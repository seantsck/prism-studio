import { describe, expect, it } from "vitest";
import type { WritingProposal, WritingWorkerStore } from "@/data/writing-repository";
import {
  estimateScreenMinutes,
  LONG_FORM_TAIL_CHARS,
  longFormPlan,
  longFormTokens,
  type WritingResult,
} from "@/domain/story/writing";
import type { StoryIntelligenceProvider, StoryModel, WritingCallResult, WritingRequest } from "../provider";
import { createStoryRegistry } from "../registry";
import { StoryWorker, WRITING_LEASE_MS } from "../worker";

/**
 * A whole Episode or film written in parts by the Story worker, with a stub writer that records every call: each part
 * continues from the tail of what is written so far, the result is ONE proposal with the whole text, usage and calls
 * add up, a failing part ends the request (what was paid for is recorded), and only a first part is retried later.
 */
const MODEL: StoryModel = {
  provider: "stub",
  modelId: "writer",
  label: "Stub writer",
  paid: true,
  pricing: { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5, version: "test" },
  maxOutputTokens: 32_000,
  contextTokens: 272_000,
};

function stub(answer: (req: WritingRequest, i: number) => WritingCallResult) {
  const calls: WritingRequest[] = [];
  const provider = {
    id: "stub",
    label: "Stub",
    models: () => [MODEL],
    unavailable: () => null,
    write: async (req: WritingRequest) => {
      calls.push(req);
      return answer(req, calls.length - 1);
    },
  } as unknown as StoryIntelligenceProvider;
  return { provider, calls };
}

const part = (text: string, usage = { inputTokens: 1000, outputTokens: 2000 }): WritingCallResult => ({
  ok: true,
  result: {
    message: "ok",
    alternatives: [
      { label: "A", text, explanation: "", newCharacterFacts: [`fact of ${text.slice(0, 12)}`] },
    ],
    ideas: [],
  } satisfies WritingResult,
  usage,
  providerCalls: 1,
});

function row(plan = longFormPlan("film", 32_000)): WritingProposal {
  return {
    id: "p1",
    projectId: "proj",
    sessionId: "s1",
    episodeId: "e1",
    mode: "continue",
    scope: { kind: "episode", sceneId: null, start: 0, end: 0, startLine: 1, endLine: 1 },
    instruction: "Write the complete screenplay of this film.",
    alternativesRequested: 1,
    targetText: "",
    draftText: null,
    context: {
      project: "P",
      episode: "E",
      synopsis: "",
      tone: "",
      scene: null,
      characters: [],
      sceneText: null,
      before: "",
      after: "",
      conversation: [],
      longForm: plan,
    },
    provider: "stub",
    model: "writer",
    estimate: { inputTokens: 100_000, maxOutputTokens: plan.parts * plan.partTokens, usd: 0.2 },
    confirmedUsd: 0.2,
    spendAuthorization: "confirmed",
    status: "running",
  } as unknown as WritingProposal;
}

function store(r: WritingProposal) {
  const out: { complete?: unknown; fail?: unknown; retry?: unknown; lease?: number } = {};
  let given = false;
  const s: WritingWorkerStore = {
    claim: async (_w, leaseMs) => {
      out.lease = leaseMs;
      if (given) return null;
      given = true;
      return r;
    },
    expireAbandoned: async () => 0,
    complete: async (_id, _w, x) => void (out.complete = x),
    fail: async (_id, _w, x) => void (out.fail = x),
    retryLater: async (_id, _w, at, calls) => void (out.retry = { at, calls }),
  };
  return { s, out };
}

const fakeStory = {
  claim: async () => null,
  expireAbandoned: async () => 0,
} as never;

async function run(provider: StoryIntelligenceProvider, r: WritingProposal) {
  const { s, out } = store(r);
  const registry = createStoryRegistry(
    { PRISM_STUDIO_STORY_AI_PROVIDERS: "", PRISM_STUDIO_ALLOW_PAID_STORY_AI: "true" },
    [provider],
  );
  await new StoryWorker({ store: fakeStory, writing: s, registry, workerId: "w", leaseMs: 60_000 }).tick(1);
  return out;
}

describe("a whole film written in parts", () => {
  it("writes every part in order, each from the tail of the text so far, into ONE proposal", async () => {
    const plan = longFormPlan("film", 32_000);
    const { provider, calls } = stub((_req, i) => part(`INT. PLACE ${i + 1} - DAY\n\n${"x".repeat(30_000)}`));
    const out = await run(provider, row(plan));
    expect(calls).toHaveLength(plan.parts);
    expect(calls.map((c) => c.maxOutputTokens)).toEqual(Array(plan.parts).fill(plan.partTokens));
    expect(calls[0]!.targetText).toBe("");
    expect(calls[0]!.instruction).toMatch(/^This is part 1 of 4 of the whole film\./);
    expect(calls[0]!.instruction).toContain("Start at the very beginning.");
    expect(calls[3]!.instruction).toContain("This is the last part");
    expect(calls[0]!.instruction).toContain("Write the complete screenplay of this film.");
    // later parts see only the tail of what is written (bounded, as priced)
    for (const c of calls.slice(1)) {
      expect(c.targetText.length).toBeLessThanOrEqual(LONG_FORM_TAIL_CHARS);
      expect(c.targetText.endsWith("x")).toBe(true);
    }
    expect(calls.every((c) => c.mode === "continue" && c.count === 1 && !c.context.longForm)).toBe(true);
    const done = out.complete as {
      result: WritingResult;
      usage: { inputTokens: number };
      providerCalls: number;
    };
    expect(done.result.alternatives).toHaveLength(1);
    const text = done.result.alternatives[0]!.text;
    for (let i = 1; i <= plan.parts; i++) expect(text).toContain(`INT. PLACE ${i} - DAY`);
    expect(text.indexOf("PLACE 1")).toBeLessThan(text.indexOf("PLACE 4"));
    expect(done.usage).toEqual({ inputTokens: 4000, outputTokens: 8000 });
    expect(done.providerCalls).toBe(4);
    expect(done.result.alternatives[0]!.newCharacterFacts).toHaveLength(4);
    // the lease covers a whole film
    expect(out.lease).toBe(WRITING_LEASE_MS);
  });

  it("a part that fails ends the request; what was paid for is recorded; only a first part waits to retry", async () => {
    const failing = (at: number, retryable: boolean) =>
      stub((_req, i) =>
        i === at
          ? {
              ok: false,
              code: "provider_error",
              message: "The writer is busy.",
              retryable,
              usage: { inputTokens: 500, outputTokens: 0 },
              providerCalls: 1,
            }
          : part(`PART ${i + 1}`),
      );
    let s = failing(2, true);
    let out = await run(s.provider, row());
    expect(s.calls).toHaveLength(3);
    expect(out.retry).toBeUndefined();
    expect(out.fail).toMatchObject({
      error: { message: "Part 3 of 4 failed: The writer is busy." },
      usage: { inputTokens: 2500, outputTokens: 4000 },
      providerCalls: 3,
    });
    s = failing(0, true);
    out = await run(s.provider, row());
    expect(out.retry).toMatchObject({ calls: 1 });
    expect(out.fail).toBeUndefined();
  });

  it("the price ceiling covers every part, and a whole film stays within a $0.25 limit with GPT-6 Luna's prices", () => {
    const plan = longFormPlan("film", 32_000);
    const t = longFormTokens(3000, plan);
    expect(t.maxOutputTokens).toBe(plan.parts * plan.partTokens);
    expect(t.inputTokens).toBe(4 * 3000 + 3 * Math.ceil(LONG_FORM_TAIL_CHARS * 1.5));
    const usd = (t.inputTokens * 0.1 + t.maxOutputTokens * 0.5) / 1_000_000;
    expect(usd).toBeLessThan(0.05);
  });
});

describe("a whole Episode redrafted in parts", () => {
  it("writes the new screenplay from nothing, with the current one sent as previousDraft, into ONE proposal", async () => {
    const plan = longFormPlan("series", 32_000, 20);
    const old = "INT. LOBBY - NIGHT\n\nThe old short scene.";
    const r = row(plan);
    Object.assign(r, {
      mode: "rewrite",
      targetText: old,
      scope: { kind: "episode", sceneId: null, start: 0, end: old.length, startLine: 1, endLine: 3 },
      context: { ...r.context, previousDraft: old },
    });
    const { provider, calls } = stub((_req, i) => part(`INT. PLACE ${i + 1} - DAY\n\nNew scene ${i + 1}.`));
    const out = await run(provider, r);
    // the stub writes a line a part, far short of 20 minutes: both reserve parts are added before the ending
    expect(calls).toHaveLength(plan.parts + plan.extraParts!);
    // the first part starts from an empty page; every part sees the old screenplay in the context, never as its target
    expect(calls[0]!.targetText).toBe("");
    expect(
      calls.every((c) => c.context.previousDraft === old && !c.targetText.includes("old short scene")),
    ).toBe(true);
    const done = out.complete as { result: WritingResult };
    const text = done.result.alternatives[0]!.text;
    expect(text.startsWith("INT. PLACE 1 - DAY")).toBe(true);
    expect(text).not.toContain("The old short scene.");
    expect(done.result.message).toMatch(/^Prism redrafted the whole episode in \d+ parts\./);
  });
});

describe("a whole Episode written to its length", () => {
  const plan = longFormPlan("series", 32_000, 20);
  const page = (n: number) =>
    `INT. ROOM ${n} - NIGHT\n\n${"Words of action and dialogue fill the page here. ".repeat(19)}`.trim();

  it("asks each part for what is still missing, and needs no extra part when the parts reach the length", async () => {
    // each part writes about five minutes (five pages of about 170 words)
    const { provider, calls } = stub((_req, i) =>
      part([1, 2, 3, 4, 5].map((k) => page(i * 5 + k)).join("\n\n")),
    );
    const out = await run(provider, row(plan));
    expect(calls).toHaveLength(plan.parts);
    expect(calls[0]!.instruction).toContain("at least 5 full screenplay pages");
    expect(calls[0]!.instruction).toContain(
      "The whole episode must run about 20 minutes; what is written so far runs about 0.",
    );
    expect(calls[0]!.instruction).toContain("Never summarise");
    expect(calls.at(-1)!.instruction).toContain("This is the last part");
    const done = out.complete as { result: WritingResult };
    expect(done.result.message).toMatch(/It runs about (2[0-4]) minutes \(target 20\)\./);
  });

  it("a text running short gets parts added BEFORE the ending, each asked for more, never past the reserve", async () => {
    // each part writes about two minutes only
    const { provider, calls } = stub((_req, i) => part([1, 2].map((k) => page(i * 2 + k)).join("\n\n")));
    const out = await run(provider, row(plan));
    expect(calls).toHaveLength(plan.parts + plan.extraParts!);
    // only the very last call ends it; every earlier call is told not to
    expect(calls.slice(0, -1).every((c) => c.instruction.includes("Do not end the episode yet."))).toBe(true);
    expect(calls.at(-1)!.instruction).toContain("This is the last part");
    expect(calls[1]!.instruction).toMatch(/^This is part 2 of 4 /);
    expect(calls.at(-1)!.instruction).toMatch(/^This is part 6 of 6 /);
    // a part after a short one is asked for more than the first
    const ask = (i: number) => Number(/at least (\d+) full screenplay pages/.exec(calls[i]!.instruction)![1]);
    expect(ask(3)).toBeGreaterThan(ask(0));
    expect((out.complete as { result: WritingResult }).result.message).toMatch(/in 6 parts\./);
  });
});

describe("estimateScreenMinutes", () => {
  it("is about a page a minute: about 170 English words, or about 400 Japanese characters of dialogue", () => {
    expect(estimateScreenMinutes("")).toBe(0);
    expect(estimateScreenMinutes("word ".repeat(1700))).toBe(10);
    expect(estimateScreenMinutes("あ".repeat(4000))).toBe(10);
    // the sample Episode 1 (six short scenes) runs about a minute
    const sample = "INT. A - NIGHT\n\nShort.\n\n".repeat(6);
    expect(estimateScreenMinutes(sample)).toBeLessThan(2);
  });
});

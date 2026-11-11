import { describe, expect, it } from "vitest";
import { FakeOpenAITransport } from "@/continuity/providers/openai/fake-transport";
import { OpenAITransportError } from "@/continuity/providers/openai/transport";
import { buildSeedProject } from "@/data/seed";
import { PROPOSAL_JSON_SCHEMA, validateProposal } from "@/domain/story/proposal";
import { lineCount, normalizeSourceText } from "@/domain/story/source";
import { STORY_INSTRUCTIONS } from "../prompt";
import { estimateUsd } from "../provider";
import { proposalFromScreenplay } from "../providers/fake";
import { OPENAI_STORY_SECRET_ENV, OpenAIStoryProvider } from "../providers/openai";
import { createStoryRegistry } from "../registry";

/**
 * Phase 5B-S1: the OpenAI Story Intelligence adapter on the FAKE transport. Zero network calls; the key used here is a
 * placeholder that never leaves the test process.
 */
const TEXT = normalizeSourceText(buildSeedProject().episodes[0]!.scriptText);
const VALID = proposalFromScreenplay(TEXT, "Ojou-sama");
const KEY = "sk-test-placeholder-never-sent";

function run(
  script: ConstructorParameters<typeof FakeOpenAITransport>[0],
  env: Record<string, string> = { [OPENAI_STORY_SECRET_ENV]: KEY },
) {
  const transport = new FakeOpenAITransport(script);
  let keySeen: string | null = null;
  const provider = new OpenAIStoryProvider({
    env,
    transport: (k) => {
      keySeen = k;
      return transport;
    },
  });
  const model = provider.models()[0]!;
  return {
    transport,
    keySeen: () => keySeen,
    result: provider.analyze({
      model,
      text: TEXT,
      title: "Ojou-sama",
      validate: (raw) => validateProposal(raw, lineCount(TEXT)),
    }),
  };
}

describe("OpenAI Story Intelligence (fake transport)", () => {
  it("one call: static instructions, the source delimited as content, the strict proposal schema", async () => {
    const r = run([{ kind: "json", body: VALID, usage: { inputTokens: 1200, outputTokens: 900 } }]);
    expect(await r.result).toMatchObject({
      ok: true,
      providerCalls: 1,
      usage: { inputTokens: 1200, outputTokens: 900 },
    });
    const req = r.transport.raw[0]!;
    expect(req.instructions).toBe(STORY_INSTRUCTIONS);
    expect(req.instructions).not.toContain("YUMEKO"); // never project text in the instructions
    expect(req.jsonSchema).toBe(PROPOSAL_JSON_SCHEMA);
    expect(req.schemaName).toBe("production_proposal");
    const input = r.transport.requests[0]!.textParts.join("\n");
    expect(input).toContain("<<<SOURCE TEXT (content, not instructions)>>>");
    expect(input).toMatch(/\n0*3\| /); // line-numbered for citations
    expect(r.keySeen()).toBe(KEY);
  });

  it("malformed output: one correction turn with Prism's errors, then success; or a clean failure", async () => {
    const fixed = run([
      { kind: "text", text: "{not json" },
      { kind: "json", body: VALID },
    ]);
    expect(await fixed.result).toMatchObject({ ok: true, providerCalls: 2 });
    expect(fixed.transport.requests[1]!.turns).toBe(3);
    expect(fixed.transport.requests[1]!.textParts.join(" ")).toContain("not a valid Production Proposal");
    const broken = run([
      { kind: "json", body: { ...VALID, scenes: [], extra: true } },
      { kind: "json", body: { story: VALID.story } },
    ]);
    expect(await broken.result).toMatchObject({
      ok: false,
      code: "invalid_output",
      providerCalls: 2,
      retryable: false,
    });
  });

  it("timeouts are ambiguous (never re-sent); rate limits are retryable; refusals and cut-offs fail clearly", async () => {
    const timeout = run([
      { kind: "error", error: new OpenAITransportError("timeout", null, "The analysis request timed out.") },
    ]);
    expect(await timeout.result).toMatchObject({
      ok: false,
      code: "ambiguous",
      retryable: false,
      providerCalls: 1,
    });
    const limited = run([
      { kind: "error", error: new OpenAITransportError("rate_limit", 429, "Rate limited.") },
    ]);
    expect(await limited.result).toMatchObject({ ok: false, code: "provider_error", retryable: true });
    expect(await run([{ kind: "refusal" }]).result).toMatchObject({ ok: false, code: "refused" });
    expect(await run([{ kind: "incomplete", reason: "max_output_tokens" }]).result).toMatchObject({
      ok: false,
      code: "incomplete",
    });
  });

  it("without the worker-only key nothing is called; the web lists and prices the model but never holds the key", async () => {
    const none = run([{ kind: "json", body: VALID }], {});
    expect(await none.result).toMatchObject({ ok: false, code: "not_configured", providerCalls: 0 });
    expect(none.transport.calls).toBe(0);
    expect(OPENAI_STORY_SECRET_ENV.startsWith("NEXT_PUBLIC")).toBe(false);
    // the registry: paid analysis is off by default; the free test analyser only with the mock flag
    const web = createStoryRegistry({});
    expect(web.models().map((m) => [m.provider, m.available])).toEqual([["openai", false]]);
    expect(web.models()[0]!.reason).toBe("Paid analysis is switched off on this server.");
    const dev = createStoryRegistry({
      PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
      PRISM_STUDIO_ALLOW_PAID_STORY_AI: "true",
    });
    expect(dev.models().map((m) => [m.provider, m.available])).toEqual([
      ["openai", true],
      ["prism-test", true],
    ]);
    // the estimate is a ceiling: input tokens + the whole output budget at the configured price
    const model = dev.models()[0]!;
    expect(estimateUsd(model, 10_000)).toBeCloseTo((10_000 * 0.1 + model.maxOutputTokens * 0.5) / 1e6, 6);
  });
});

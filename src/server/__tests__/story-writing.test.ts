import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import type { WritingProposal } from "@/data/writing-repository";
import { sceneRanges } from "@/domain/story/revisions";
import { canonical, lineRangeOffsets } from "@/domain/story/writing";
import { FakeStoryProvider } from "@/story/providers/fake";
import { createStoryRegistry } from "@/story/registry";
import { StoryWorker } from "@/story/worker";

/**
 * Phase 5B-S2 acceptance: the AI writing assistant through the REAL server actions, memory repository and Story worker
 * with the FREE test writer (no network, no paid call). Ojou-sama Episode 1 is the fixture.
 */
vi.hoisted(() => {
  process.env.PRISM_STUDIO_INLINE_WORKER = "0";
  process.env.PRISM_STUDIO_ENABLE_MOCK_PROVIDER = "1";
  process.env.PRISM_STUDIO_STORY_AI_PROVIDERS = "openai";
  delete process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI;
});
const world = vi.hoisted(() => ({ repo: null as unknown, files: new Map<string, Uint8Array>() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("@/server/auth", () => ({ requireUser: async () => ({ kind: "memory", id: "tester" }) }));
vi.mock("@/server/repo", async () => {
  const { UserFacingError } = await import("@/server/action-result");
  return {
    getRepo: async () => world.repo,
    requireProjectFresh: async (slug: string) => {
      const data = await (world.repo as MemoryRepository).loadProject(slug);
      if (!data) throw new UserFacingError("That project no longer exists.");
      return data;
    },
  };
});
vi.mock("@/server/storage", () => {
  const store = {
    name: "local" as const,
    bucket: null,
    put: async (p: string, b: Uint8Array) => void world.files.set(p, new Uint8Array(b)),
    get: async (p: string) => world.files.get(p) ?? null,
  };
  return {
    getUploadStorage: async () => store,
    storageForAsset: async () => store,
    checksum: (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
  };
});

import { saveScript } from "../actions";
import { analyzeStory, submitProposalReview } from "../story-actions";
import { openStoryChangeFor, tickInlineStoryWorker } from "../story";
import {
  acceptWritingProposal,
  askPrism,
  authorizeWritingSession,
  decideWritingProposal,
  markSceneBreakdownReviewed,
  restoreScriptRevision,
} from "../writing-actions";

let repo: MemoryRepository;
let fake: FakeStoryProvider;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  repo = new MemoryRepository();
  world.repo = repo;
  fake = new FakeStoryProvider();
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  // zero real provider calls: nothing in the writing path touched the network
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  delete process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI;
});

const project = async (slug = "ojousama") => (await repo.loadProject(slug))!;
const episodeOf = async () => (await project()).episodes[0]!;
const scene = async (n: string) => {
  const d = await project();
  return d.scenes.find((s) => s.episodeId === d.episodes[0]!.id && s.sceneNumber === n)!;
};
const form = (fields: Record<string, string>, slug = "ojousama") => {
  const f = new FormData();
  f.set("projectSlug", slug);
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** The worker, with OUR fake provider instance (so its requests can be inspected). */
const work = () =>
  new StoryWorker({
    store: repo.story,
    writing: repo.writing,
    registry: createStoryRegistry({ PRISM_STUDIO_STORY_AI_PROVIDERS: "" }, [fake]),
    workerId: "test-worker",
  }).tick(5);

async function sessionId() {
  const d = await project();
  return (await repo.writing.listSessions(d.project.id, d.episodes[0]!.id))[0]?.id ?? "";
}

/** Asks Prism, runs the worker, returns the newest proposal. */
async function ask(fields: Record<string, string>): Promise<WritingProposal> {
  const ep = await episodeOf();
  const sid = await sessionId();
  const r = await askPrism(form({ episodeId: ep.id, ...(sid ? { sessionId: sid } : {}), ...fields }));
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  await work();
  const d = await project();
  const all = await repo.writing.listProposals(d.project.id, await sessionId());
  return all.at(-1)!;
}

/** Selection fields for 1-based lines [a, b] of the current screenplay. */
async function lines(a: number, b: number) {
  const text = canonical((await episodeOf()).scriptText);
  const { start, end } = lineRangeOffsets(text, a, b);
  return {
    scopeKind: "selection",
    selStart: String(start),
    selEnd: String(end),
    selText: text.slice(start, end),
  };
}

const accept = async (p: WritingProposal, alternative = 0) =>
  acceptWritingProposal(form({ proposalId: p.id, alternative: String(alternative) }));

const GUARDED =
  "Make Yumeko more guarded and emotionally restrained without changing what happens in the scene.";

describe("5B-S2 AI writing assistant (Ojou-sama)", () => {
  it("selected range → a revision PROPOSAL with Character context; the screenplay is untouched until Accept", async () => {
    const before = (await episodeOf()).scriptText;
    const s6 = await scene("6");
    const p = await ask({ ...(await lines(48, 51)), sceneId: s6.id, instruction: GUARDED, preset: "ask" });
    expect(p).toMatchObject({
      status: "ready",
      mode: "custom",
      scope: { kind: "selection", sceneId: s6.id, startLine: 48, endLine: 51 },
    });
    expect(p.targetText).toBe("SEAN approaches the table and stops.\n\nSEAN\nお嬢様、僕と結婚してください。");
    const alt = p.result!.alternatives[0]!;
    expect(alt.text).not.toBe(p.targetText);
    expect(alt.text).toContain("Yumeko");
    // Character context (textual) reached the provider: Yumeko's and Sean's notes
    const sent = fake.writeCalls.at(-1)!;
    expect(sent.context.characters.map((c) => c.name)).toEqual(expect.arrayContaining(["Yumeko", "Sean"]));
    expect(sent.context.characters.find((c) => c.name === "Yumeko")!.personality).toMatch(/Composed/);
    expect(sent.context.scene?.heading).toBe("INT. SKY-VIEW RESTAURANT - NIGHT");
    expect(sent.operation).toBe("rewrite");
    // nothing changed yet: no revision, no story-change marker
    expect((await episodeOf()).scriptText).toBe(before);
    expect(await repo.writing.listRevisions((await project()).project.id, (await episodeOf()).id)).toEqual(
      [],
    );
    expect(await openStoryChangeFor((await project()).project.id, s6.id)).toBe(false);
  });

  it("Accept → a NEW canonical revision; the old text stays recoverable; the touched Scene is flagged; Characters unchanged", async () => {
    const d0 = await project();
    const original = d0.episodes[0]!.scriptText;
    const yumeko0 = d0.characters.find((c) => c.name === "Yumeko")!;
    const s6 = await scene("6");
    const p = await ask({
      ...(await lines(48, 51)),
      sceneId: s6.id,
      instruction: `${GUARDED} Hint at her backstory.`,
      preset: "ask",
    });
    expect(p.result!.alternatives[0]!.newCharacterFacts.length).toBeGreaterThan(0);
    expect(await accept(p)).toMatchObject({
      ok: true,
      message: expect.stringMatching(/revision 2 is now the screenplay/),
    });
    const d = await project();
    const ep = d.episodes[0]!;
    expect(ep.scriptText).toContain(p.result!.alternatives[0]!.text);
    expect(ep.scriptText).not.toBe(original);
    const revs = await repo.writing.listRevisions(d.project.id, ep.id);
    expect(revs.map((r) => [r.number, r.origin])).toEqual([
      [2, "ai_revision"],
      [1, "baseline"],
    ]);
    expect(revs[1]!.text).toBe(original); // the previous accepted text is recoverable
    expect(revs[0]).toMatchObject({ writingProposalId: p.id, alternativeIndex: 0, changedSceneIds: [s6.id] });
    expect((await repo.writing.getProposal(d.project.id, p.id))!).toMatchObject({
      status: "accepted",
      acceptedRevisionId: revs[0]!.id,
    });
    // downstream: Scene 6 (with a Shot) is "Story changed after production breakdown"; others are not
    expect(await openStoryChangeFor(d.project.id, s6.id)).toBe(true);
    expect(await openStoryChangeFor(d.project.id, (await scene("3")).id)).toBe(false);
    // the structure synced like a Script-page save; nothing downstream was deleted
    expect(d.scenes.filter((s) => s.episodeId === ep.id)).toHaveLength(6);
    expect(d.shots.length).toBe(d0.shots.length);
    // a fact the revision implied was NOT written to the Character
    expect(d.characters.find((c) => c.id === yumeko0.id)).toEqual(yumeko0);
    // the creator reviews the breakdown
    expect(await markSceneBreakdownReviewed(form({ sceneId: s6.id }))).toMatchObject({ ok: true });
    expect(await openStoryChangeFor(d.project.id, s6.id)).toBe(false);
    // accepting twice is refused
    expect(await accept(p)).toMatchObject({ ok: false, error: "This proposal was already accepted." });
  });

  it("Reject makes no change; Revise again is a NEW proposal from the chosen version, with the conversation", async () => {
    const before = (await episodeOf()).scriptText;
    const s6 = await scene("6");
    const first = await ask({
      ...(await lines(48, 51)),
      sceneId: s6.id,
      instruction: GUARDED,
      preset: "ask",
      alternatives: "2",
    });
    expect(first.result!.alternatives).toHaveLength(2);
    const again = await ask({
      parentId: first.id,
      parentAlternative: "1",
      instruction: "Version B, but warmer at the end.",
    });
    expect(again).toMatchObject({
      parentId: first.id,
      parentAlternative: 1,
      turn: first.turn + 1,
      status: "ready",
    });
    expect(again.draftText).toBe(first.result!.alternatives[1]!.text);
    expect(again.targetText).toBe(first.targetText); // the same original range, never re-selected
    expect(fake.writeCalls.at(-1)!.operation).toBe("revise");
    expect(fake.writeCalls.at(-1)!.context.conversation[0]).toMatchObject({ instruction: GUARDED });
    expect(await decideWritingProposal(form({ proposalId: first.id, intent: "reject" }))).toMatchObject({
      ok: true,
    });
    expect((await episodeOf()).scriptText).toBe(before);
    expect(await accept(first)).toMatchObject({ ok: false, error: "This proposal was already rejected." });
    // the follow-up is still acceptable (the screenplay did not change)
    expect(await accept(again)).toMatchObject({ ok: true });
  });

  it("three alternatives for one line: all shown, only the accepted one becomes canon; Save as alternate is not canon", async () => {
    const p = await ask({
      ...(await lines(51, 51)),
      instruction: "Give me three warmer alternatives for the last line.",
      preset: "ask",
    });
    expect(p.alternativesRequested).toBe(3);
    const alts = p.result!.alternatives;
    expect(alts.map((a) => a.label)).toEqual(["A", "B", "C"]);
    expect(alts.map((a) => a.text)).toEqual([
      "(warmly)\nお嬢様、僕と結婚してください。",
      "(gently)\nお嬢様、僕と結婚してください。",
      "(with a small smile)\nお嬢様、僕と結婚してください。",
    ]);
    expect(
      await decideWritingProposal(form({ proposalId: p.id, intent: "save", alternative: "2" })),
    ).toMatchObject({ ok: true });
    expect(await accept(p, 1)).toMatchObject({ ok: true });
    const text = (await episodeOf()).scriptText;
    expect(text).toContain("SEAN\n(gently)\nお嬢様、僕と結婚してください。");
    expect(text).not.toContain("(warmly)");
    expect(text).not.toContain("(with a small smile)");
    const after = (await repo.writing.getProposal((await project()).project.id, p.id))!;
    expect(after).toMatchObject({ status: "accepted", acceptedAlternative: 1, savedAlternatives: [2] });
    // the stored dialogue line synced from canon (the parenthetical is not part of the line)
    const sean = (await project()).dialogueLines.find((l) => l.speakerLabel === "SEAN");
    expect(sean?.originalText).toBe("お嬢様、僕と結婚してください。");
  });

  it("brainstorm returns ideas only and never changes the screenplay or production records", async () => {
    const d0 = await project();
    const s4 = await scene("4");
    const p = await ask({
      scopeKind: "scene",
      sceneId: s4.id,
      instruction: "Give me five ways to increase tension in this scene without adding a new character.",
      preset: "ask",
    });
    expect(p).toMatchObject({ mode: "brainstorm", alternativesRequested: 5, status: "ready" });
    expect(p.result!.ideas).toHaveLength(5);
    expect(p.result!.alternatives).toEqual([]);
    expect(fake.writeCalls.at(-1)!.operation).toBe("brainstorm");
    const d = await project();
    expect(d.episodes[0]!.scriptText).toBe(d0.episodes[0]!.scriptText);
    expect(d.scenes).toEqual(d0.scenes);
    expect(d.shots).toEqual(d0.shots);
    expect(d.characters).toEqual(d0.characters);
    expect(await repo.writing.listRevisions(d.project.id, d.episodes[0]!.id)).toEqual([]);
    expect(await accept(p)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/brainstorm has no text/),
    });
    // a chosen idea becomes a revision proposal only when the creator asks for it
    const written = await ask({ parentId: p.id, preset: "rewrite", instruction: p.result!.ideas[0]!.title });
    expect(written).toMatchObject({
      mode: "rewrite",
      parentId: p.id,
      scope: { kind: "scene", sceneId: s4.id },
    });
  });

  it("modes: Scene rewrite, Continue, Dialogue pass, Tone, Shorten, Expand", async () => {
    const s2 = await scene("2");
    const s4 = await scene("4");
    const rewrite = await ask({
      scopeKind: "scene",
      sceneId: s4.id,
      preset: "rewrite",
      instruction: "Make Takumi more condescending.",
    });
    expect(rewrite).toMatchObject({ mode: "rewrite", scope: { kind: "scene" } });
    expect(rewrite.targetText.startsWith("INT. SKY-VIEW RESTAURANT - NIGHT")).toBe(true);
    const dialogue = await ask({ scopeKind: "scene", sceneId: s2.id, preset: "dialogue", instruction: "" });
    expect(dialogue.mode).toBe("dialogue");
    expect(dialogue.targetText).toContain("！");
    expect(dialogue.result!.alternatives[0]!.text).not.toContain("！");
    const tone = await ask({ scopeKind: "scene", sceneId: s4.id, preset: "tension", instruction: "" });
    expect(tone).toMatchObject({ mode: "tone", instruction: "Increase the tension." });
    const shorten = await ask({ scopeKind: "scene", sceneId: s2.id, preset: "shorten", instruction: "" });
    expect(shorten.mode).toBe("condense");
    expect(shorten.result!.alternatives[0]!.text.length).toBeLessThanOrEqual(shorten.targetText.length);
    const expand = await ask({ scopeKind: "scene", sceneId: s4.id, preset: "expand", instruction: "" });
    expect(expand.result!.alternatives[0]!.text.length).toBeGreaterThan(expand.targetText.length);
    const cont = await ask({ scopeKind: "scene", sceneId: s4.id, preset: "continue", instruction: "" });
    expect(cont).toMatchObject({ mode: "continue" });
    expect(fake.writeCalls.at(-1)!.operation).toBe("continue");
    const before = canonical((await episodeOf()).scriptText);
    expect(await accept(cont)).toMatchObject({ ok: true });
    const after = canonical((await episodeOf()).scriptText);
    const r4 = sceneRanges(after, await project(), (await episodeOf()).id).get(s4.id)!;
    expect(after.slice(r4.start, r4.end)).toContain(cont.result!.alternatives[0]!.text.trim());
    expect(
      after.startsWith(
        before.slice(0, sceneRanges(before, await project(), (await episodeOf()).id).get(s4.id)!.end),
      ),
    ).toBe(true);
    // the other proposals were written against the old screenplay: they can no longer be accepted silently
    expect(await accept(rewrite)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/screenplay changed after Prism wrote/),
    });
  });

  it("a manual Script edit and a Restore are revisions too; nothing is ever overwritten", async () => {
    const ep = await episodeOf();
    const original = ep.scriptText;
    const edited = original.replace(
      "A black heel touches the red carpet.",
      "A black heel touches the red carpet. Flashbulbs.",
    );
    expect(await saveScript(form({ episodeId: ep.id, scriptText: edited }))).toMatchObject({ ok: true });
    const d = await project();
    const revs = await repo.writing.listRevisions(d.project.id, ep.id);
    expect(revs.map((r) => r.origin)).toEqual(["creator_edit", "baseline"]);
    expect(await openStoryChangeFor(d.project.id, (await scene("2")).id)).toBe(true);
    expect(await restoreScriptRevision(form({ episodeId: ep.id, revisionId: revs[1]!.id }))).toMatchObject({
      ok: true,
    });
    const after = await repo.writing.listRevisions(d.project.id, ep.id);
    expect(after.map((r) => [r.number, r.origin])).toEqual([
      [3, "restore"],
      [2, "creator_edit"],
      [1, "baseline"],
    ]);
    expect((await episodeOf()).scriptText).toBe(original);
    expect(after[1]!.text).toBe(edited); // the edit is still recoverable
  });

  it("refusals: another project's Episode or proposal, a stale selection, an empty instruction", async () => {
    const d = await project();
    const otherId = randomUUID();
    await repo.createProject(
      { ...d.project, id: otherId, slug: "other-film", title: "Other" },
      { ...d.bible, projectId: otherId },
    );
    const s6 = await scene("6");
    const p = await ask({ ...(await lines(48, 51)), sceneId: s6.id, instruction: GUARDED, preset: "ask" });
    // a proposal of Ojou-sama addressed through another project is not found
    expect(
      await acceptWritingProposal(form({ proposalId: p.id, alternative: "0" }, "other-film")),
    ).toMatchObject({
      ok: false,
      error: "That proposal no longer exists.",
    });
    // an Episode of Ojou-sama addressed through another project is refused
    expect(
      await askPrism(
        form({ episodeId: d.episodes[0]!.id, scopeKind: "episode", instruction: "x" }, "other-film"),
      ),
    ).toMatchObject({ ok: false, error: "Choose one of this project's Episodes." });
    // a selection whose text no longer matches the screenplay
    const sel = await lines(48, 51);
    expect(
      await askPrism(
        form({
          episodeId: d.episodes[0]!.id,
          sessionId: await sessionId(),
          ...sel,
          selText: "something else",
          instruction: "x",
        }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/changed since this page loaded/) });
    expect(
      await askPrism(
        form({
          episodeId: d.episodes[0]!.id,
          sessionId: await sessionId(),
          scopeKind: "scene",
          sceneId: s6.id,
          preset: "ask",
          instruction: "",
        }),
      ),
    ).toMatchObject({ ok: false, error: "Type what you would like Prism to do." });
  });

  it("paid models: off by default; when allowed, the estimate gates every request; a capped session; the worker fails closed without its key", async () => {
    const ep = await episodeOf();
    const s6 = await scene("6");
    const paid = {
      model: "openai/gpt-6-luna",
      scopeKind: "scene",
      sceneId: s6.id,
      instruction: GUARDED,
      preset: "ask",
    };
    expect(await askPrism(form({ episodeId: ep.id, ...paid }))).toMatchObject({
      ok: false,
      error: "Paid analysis is switched off on this server.",
    });
    process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI = "true";
    // with paid AI allowed the first available model is the paid one: a free request names the free model
    await ask({
      model: "prism-test/screenplay-parser-v1",
      scopeKind: "scene",
      sceneId: s6.id,
      instruction: "warm it up",
      preset: "ask",
    });
    const sid = await sessionId();
    const refused = await askPrism(form({ episodeId: ep.id, sessionId: sid, ...paid }));
    expect(refused).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /^Estimated cost: \$0\.00\d\d .*Enter 0\.00\d\d in "Confirm total", or allow a capped writing session\.$/,
      ),
    });
    expect(await authorizeWritingSession(form({ sessionId: sid, amountUsd: "5", hours: "2" }))).toMatchObject(
      { ok: false },
    );
    expect(
      await authorizeWritingSession(form({ sessionId: sid, amountUsd: "0.05", hours: "2" })),
    ).toMatchObject({ ok: true });
    expect(await askPrism(form({ episodeId: ep.id, sessionId: sid, ...paid }))).toMatchObject({ ok: true });
    const d = await project();
    const queued = (await repo.writing.listProposals(d.project.id, sid)).at(-1)!;
    expect(queued).toMatchObject({ provider: "openai", status: "queued", spendAuthorization: "session" });
    expect(queued.confirmedUsd).toBe(queued.estimate.usd);
    const session = (await repo.writing.getSession(d.project.id, sid))!;
    expect(session.reservedUsd).toBeCloseTo(queued.estimate.usd, 6);
    // the real worker registry has no key in this process: it fails closed, with zero provider calls
    await tickInlineStoryWorker();
    expect((await repo.writing.getProposal(d.project.id, queued.id))!).toMatchObject({
      status: "failed",
      providerCalls: 0,
      error: { code: "not_configured" },
    });
  });

  it("S1 compatibility: an imported Episode starts its history with the ORIGINAL IMPORTED SOURCE", async () => {
    const d = await project();
    const script = d.episodes[0]!.scriptText;
    expect(
      await analyzeStory(
        form({
          model: "prism-test/screenplay-parser-v1",
          sourceMode: "paste",
          text: script,
          title: "Ojou-sama",
        }),
      ),
    ).toMatchObject({ ok: true });
    await tickInlineStoryWorker();
    const [rec] = await repo.story.list(d.project.id);
    expect(rec!.status).toBe("ready");
    expect(
      await submitProposalReview(form({ proposalId: rec!.id, intent: "apply", targetKind: "new_episode" })),
    ).toMatchObject({ ok: true });
    const after = await project();
    const created = after.episodes.find((e) => e.id !== d.episodes[0]!.id)!;
    const revs = await repo.writing.listRevisions(d.project.id, created.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ origin: "import", storyProposalId: rec!.id, number: 1 });
    expect(revs[0]!.text).toBe(rec!.inputText);
  });
});

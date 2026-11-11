import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import type { ShotListProposal } from "@/data/shot-list-repository";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { productionFrameInputs } from "@/domain/generation/production-frame-inputs";
import { derivedId } from "@/domain/story/apply";
import { reviewOfShotList } from "@/domain/story/shot-list-review";
import { canonical, lineRangeOffsets } from "@/domain/story/writing";
import { FakeStoryProvider } from "@/story/providers/fake";
import { createStoryRegistry } from "@/story/registry";
import { StoryWorker } from "@/story/worker";

/**
 * Phase 5B-S4 acceptance: Scene → Plan Shots with Prism → Shot List Proposal → review → Apply, through the REAL server
 * actions, memory repository and Story worker with the FREE test planner (no network, no paid call).
 */
vi.hoisted(() => {
  process.env.PRISM_STUDIO_INLINE_WORKER = "0";
  process.env.PRISM_STUDIO_ENABLE_MOCK_PROVIDER = "1";
  process.env.PRISM_STUDIO_STORY_AI_PROVIDERS = "openai";
  delete process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI;
});
const world = vi.hoisted(() => ({ repo: null as unknown }));
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
vi.mock("@/server/storage", () => ({
  getUploadStorage: async () => null,
  storageForAsset: async () => null,
  checksum: (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
}));

import { saveScript } from "../actions";
import { planShotsWithPrism, submitShotListReview } from "../shot-list-actions";
import { openStoryChangeFor, tickInlineStoryWorker } from "../story";
import { askPrism, authorizeWritingSession } from "../writing-actions";

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
  expect(fetchSpy).not.toHaveBeenCalled(); // zero real provider calls
  fetchSpy.mockRestore();
  delete process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI;
});

const FREE = "prism-test/screenplay-parser-v1";
const project = async () => (await repo.loadProject("ojousama"))!;
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
const work = (provider = fake) =>
  new StoryWorker({
    store: repo.story,
    writing: repo.writing,
    shotLists: repo.shotLists,
    registry: createStoryRegistry({ PRISM_STUDIO_STORY_AI_PROVIDERS: "" }, [provider]),
    workerId: "test-worker",
  }).tick(5);

async function latest(sceneId: string): Promise<ShotListProposal> {
  return (await repo.shotLists.listForScene((await project()).project.id, sceneId))[0]!;
}
async function plan(n: string, provider = fake) {
  const s = await scene(n);
  const r = await planShotsWithPrism(form({ sceneId: s.id, model: FREE }));
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  await work(provider);
  return latest(s.id);
}

/** The review form as the page posts it, with overrides. */
async function reviewForm(
  rec: ShotListProposal,
  fields: Record<string, string>,
  change: (f: FormData) => void = () => {},
) {
  const parent = rec.parentId ? await repo.shotLists.get(rec.projectId, rec.parentId) : null;
  const review = reviewOfShotList(rec, parent)!;
  const f = form({ proposalId: rec.id, reviewPresent: "1", ...fields });
  for (const it of review.items) {
    if (it.selected) f.set(`include:${it.id}`, "on");
    if (it.rejected) f.set(`reject:${it.id}`, "on");
    f.set(`decision:${it.id}`, it.decision.kind === "replace" ? it.decision.shotId : "create");
  }
  if (review.confirmReplace) f.set("confirmReplace", "on");
  change(f);
  return f;
}
const reviewOf = async (rec: ShotListProposal) => (await repo.shotLists.get(rec.projectId, rec.id))!.review!;

describe("5B-S4 Scene → reviewed Shot List (Ojou-sama)", () => {
  it("Scene 3 → an ordered, traceable Shot List from the accepted screenplay; nothing changes until Apply", async () => {
    const before = await project();
    const rec = await plan("3");
    expect(rec).toMatchObject({
      status: "ready",
      version: 1,
      provider: "prism-test",
      promptVersion: "shot-planner-v1",
      schemaVersion: "prism.shot-list.v1",
    });
    const shots = rec.plan!.shots;
    expect(shots.map((s) => [s.order, s.title])).toEqual([
      [1, "Lobby master"],
      [2, "Yumeko medium close"],
    ]);
    expect(shots[0]).toMatchObject({
      characterKeys: ["c1"],
      locationKey: "l1",
      sources: [{ startLine: 19, endLine: 24 }],
    });
    expect(shots[1]).toMatchObject({ dialogueKeys: ["d1"], sources: [{ startLine: 23, endLine: 24 }] });
    expect(rec.context.characters[0]!.name).toBe("Yumeko");
    expect(rec.context.locations[0]!.name).toBe("Grand Celeste Lobby");
    expect(fake.planCalls.at(-1)!.sceneText).toBe(rec.sceneText);
    expect((await project()).shots).toEqual(before.shots); // proposal only
  });

  it("only accepted canon feeds planning: an unaccepted Prism writing suggestion never reaches the planner", async () => {
    const d = await project();
    const text = canonical(d.episodes[0]!.scriptText);
    const { start, end } = lineRangeOffsets(text, 21, 21);
    await askPrism(
      form({
        episodeId: d.episodes[0]!.id,
        scopeKind: "selection",
        selStart: String(start),
        selEnd: String(end),
        selText: text.slice(start, end),
        instruction: "Make it tense.",
        preset: "ask",
        model: FREE,
      }),
    );
    await work();
    const suggestion = (
      await repo.writing.listProposals(
        d.project.id,
        (await repo.writing.listSessions(d.project.id, d.episodes[0]!.id))[0]!.id,
      )
    )[0]!;
    expect(suggestion.status).toBe("ready");
    const rec = await plan("3");
    const lobby = lineRangeOffsets(text, 19, 24);
    expect(rec.sceneText).toBe(text.slice(lobby.start, lobby.end)); // the CANONICAL Scene text
    const suggested = suggestion.result!.alternatives[0]!.text;
    expect(suggested).toContain("(tightly)");
    expect(rec.sceneText).not.toContain(suggested);
    expect(rec.sceneText).not.toContain("(tightly)");
    expect(JSON.stringify(rec.context)).not.toContain("(tightly)");
    expect(rec.sceneFingerprint).toBeTruthy();
  });

  it("review: edit, reorder, reject, split; regenerate ONE Shot and the whole list as NEW versions", async () => {
    const rec = await plan("4");
    expect(rec.plan!.shots.map((s) => s.coverage)).toEqual([
      "master",
      "over_the_shoulder",
      "single",
      "reaction",
    ]);
    // edit a purpose, reject the reaction
    await submitShotListReview(
      await reviewForm(rec, { intent: "save", "edit:sh2:purpose": "Takumi lays out the deal." }, (f) =>
        f.set("reject:sh4", "on"),
      ),
    );
    let r = await reviewOf(rec);
    expect(r.items.find((i) => i.id === "sh2")!.edits).toEqual({ purpose: "Takumi lays out the deal." });
    expect(r.items.find((i) => i.id === "sh4")!.rejected).toBe(true);
    // reorder: the Yumeko single before the OTS
    expect(
      await submitShotListReview(await reviewForm({ ...rec, review: r }, { intent: "up:sh3" })),
    ).toMatchObject({ ok: true });
    r = await reviewOf(rec);
    expect(r.items.map((i) => i.id)).toEqual(["sh1", "sh3", "sh2", "sh4"]);
    // split the master in two
    await submitShotListReview(await reviewForm({ ...rec, review: r }, { intent: "split:sh1" }));
    r = await reviewOf(rec);
    expect(r.items.slice(0, 2).map((i) => i.id)).toEqual(["sh1", "sh1~2"]);
    // regenerate ONE Shot: a new version, only that Shot changed, the other choices carried
    await submitShotListReview(
      await reviewForm({ ...rec, review: r }, { intent: "regen:sh3", "regenNote:sh3": "tighter" }),
    );
    await work();
    const v2 = await latest(rec.sceneId);
    expect(v2).toMatchObject({
      version: 2,
      parentId: rec.id,
      scope: { kind: "shot", key: "sh3", note: "tighter" },
    });
    expect(v2.plan!.shots.find((s) => s.key === "sh3")!.shotSize).toBe("close_up");
    for (const k of ["sh1", "sh2", "sh4"])
      expect(v2.plan!.shots.find((s) => s.key === k)).toEqual(rec.plan!.shots.find((s) => s.key === k));
    const carried = reviewOfShotList(v2, (await repo.shotLists.get(rec.projectId, rec.id))!)!;
    expect(carried.items.find((i) => i.id === "sh4")!.rejected).toBe(true);
    expect(carried.items.find((i) => i.id === "sh2")!.edits.purpose).toBe("Takumi lays out the deal.");
    // the earlier version is unchanged
    expect((await repo.shotLists.get(rec.projectId, rec.id))!.plan).toEqual(rec.plan);
    // regenerate the whole list
    await submitShotListReview(await reviewForm(v2, { intent: "regenerate_all" }));
    await work();
    expect(await latest(rec.sceneId)).toMatchObject({ version: 3, scope: { kind: "full" }, status: "ready" });
  });

  it("Apply: deterministic Shots; replacing 3A needs approval and keeps its id; Shot 3A feeds the I6 Production Frame workflow", async () => {
    const s3 = await scene("3");
    const d0 = await project();
    const shot3A = d0.shots.find((s) => s.sceneId === s3.id && s.shotCode === "3A")!;
    const rec = await plan("3");
    const asReplace = (f: FormData) => f.set("decision:sh1", shot3A.id);
    expect(await submitShotListReview(await reviewForm(rec, { intent: "apply" }, asReplace))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/confirm the replacement/),
    });
    expect(
      await submitShotListReview(
        await reviewForm(rec, { intent: "apply" }, (f) => (asReplace(f), f.set("confirmReplace", "on"))),
      ),
    ).toMatchObject({ ok: true, message: "Applied: 1 Shot created, 1 replaced in place." });
    const d = await project();
    const a = d.shots.find((s) => s.id === shot3A.id)!;
    expect(a).toMatchObject({
      shotCode: "3A",
      sceneId: s3.id,
      title: "Lobby master",
      storyBeat: "The lobby is hushed. Yumeko stands alone at the elevators.",
    });
    expect(a.characters.map((c) => d.characters.find((x) => x.id === c.characterId)!.name)).toEqual([
      "Yumeko",
    ]);
    expect(d.locations.find((l) => l.id === a.spatial.locationId)!.name).toBe("Grand Celeste Lobby");
    expect(a.composition).toMatchObject({ shotSize: "wide", cameraAngle: "eye level" });
    expect(a.composition.notes).toMatch(/Source: lines 19–24 \(Shot List v1\)/);
    expect(a.scriptSources.dialogueLineIds).toEqual([rec.context.dialogue[0]!.id]);
    expect(a.generation).toEqual(shot3A.generation); // history kept
    const b = d.shots.find((s) => s.id === derivedId(rec.id, "shot:sh2"))!;
    expect(b).toMatchObject({ shotCode: "3B", sceneId: s3.id, title: "Yumeko medium close" });
    expect(d.shots.length).toBe(d0.shots.length + 1); // nothing deleted
    // the existing I6 Production Frame workflow consumes the applied Shot 3A
    const inputs = productionFrameInputs(assembleGenerationPackage(buildShotContext(d, shot3A.id)));
    expect(inputs.characters[0]!.name).toBe("Yumeko");
    expect(inputs.location[0]).toContain("Grand Celeste Lobby");
    // applied once
    expect(await submitShotListReview(await reviewForm(rec, { intent: "apply" }))).toMatchObject({
      ok: false,
      error: "This shot list was already applied.",
    });
  });

  it("story change: a screenplay revision makes the plan stale; Re-plan is a new version and destroys nothing", async () => {
    const s3 = await scene("3");
    const rec = await plan("3");
    await submitShotListReview(await reviewForm(rec, { intent: "apply" }));
    const pending = await plan("3"); // v2, ready but not applied
    const d0 = await project();
    const edited = d0.episodes[0]!.scriptText.replace(
      "Yumeko stands alone at the elevators.",
      "Yumeko stands alone at the elevators, holding her breath.",
    );
    expect(await saveScript(form({ episodeId: d0.episodes[0]!.id, scriptText: edited }))).toMatchObject({
      ok: true,
    });
    expect(await openStoryChangeFor(d0.project.id, s3.id)).toBe(true); // the S2 marker
    expect(await submitShotListReview(await reviewForm(pending, { intent: "apply" }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/screenplay changed after Prism planned/),
    });
    const shotsBefore = (await project()).shots;
    const replan = await plan("3");
    expect(replan).toMatchObject({ version: 3, parentId: pending.id, status: "ready" });
    expect(replan.sceneText).toContain("holding her breath");
    expect(replan.sceneFingerprint).not.toBe(rec.sceneFingerprint);
    expect((await project()).shots).toEqual(shotsBefore); // re-planning destroyed nothing
    expect((await repo.shotLists.get(rec.projectId, rec.id))!.status).toBe("applied"); // the old plan is kept
  });

  it("multi-character: Sean and Yumeko coverage keeps who speaks to whom", async () => {
    const d0 = await project();
    // S2's revision path: a creator edit gives Yumeko a reply in Scene 6
    const edited = d0.episodes[0]!.scriptText.replace(
      "お嬢様、僕と結婚してください。",
      "お嬢様、僕と結婚してください。\n\nYUMEKO\n……本気ですか？",
    );
    await saveScript(form({ episodeId: d0.episodes[0]!.id, scriptText: edited }));
    const rec = await plan("6");
    const names = (keys: string[]) => keys.map((k) => rec.context.characters.find((c) => c.key === k)!.name);
    expect(rec.context.dialogue.map((l) => l.speaker)).toEqual(["SEAN", "YUMEKO"]);
    const shots = rec.plan!.shots;
    expect(shots.map((s) => [s.coverage, names(s.characterKeys)])).toEqual([
      ["master", expect.arrayContaining(["Sean", "Yumeko"])],
      ["over_the_shoulder", ["Sean", "Yumeko"]],
      ["single", ["Yumeko"]],
      ["reaction", ["Sean"]],
    ]);
    const yumekoLine = rec.context.dialogue.find((l) => l.speaker === "YUMEKO")!;
    expect(shots[2]!.dialogueKeys).toEqual([yumekoLine.key]);
    expect(yumekoLine.id).toBeTruthy(); // synced from canon by the Script save
    expect(shots[1]!.continuityNotes).toMatch(/Sean screen-left and Yumeko screen-right/);
  });

  it("refusals: another project's Scene; malformed provider output fails cleanly and stores nothing", async () => {
    const d = await project();
    const other = randomUUID();
    await repo.createProject(
      { ...d.project, id: other, slug: "other-film", title: "Other" },
      { ...d.bible, projectId: other },
    );
    expect(
      await planShotsWithPrism(form({ sceneId: (await scene("3")).id, model: FREE }, "other-film")),
    ).toMatchObject({
      ok: false,
      error: "Choose one of this project's Scenes.",
    });
    const bad = new FakeStoryProvider({ planAnswers: ["{not json", { summary: "x", shots: [] }] });
    const rec = await plan("3", bad);
    expect(rec).toMatchObject({
      status: "failed",
      plan: null,
      providerCalls: 2,
      error: { code: "invalid_output" },
    });
    expect((await project()).shots).toEqual(d.shots);
  });

  it("spend: paid planning shows the estimate, can use the Episode's capped writing allowance, and the worker fails closed", async () => {
    process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI = "true";
    const s3 = await scene("3");
    const d = await project();
    expect(await planShotsWithPrism(form({ sceneId: s3.id, model: "openai/gpt-6-luna" }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /^Estimated cost: \$0\.\d{4} .*allow a capped writing session for this Episode\.$/,
      ),
    });
    // a writing session with an allowance (S2) on the same Episode
    await askPrism(
      form({
        episodeId: d.episodes[0]!.id,
        scopeKind: "episode",
        instruction: "Shorten this.",
        preset: "ask",
        model: FREE,
      }),
    );
    const sid = (await repo.writing.listSessions(d.project.id, d.episodes[0]!.id))[0]!.id;
    await authorizeWritingSession(form({ sessionId: sid, amountUsd: "0.05", hours: "1" }));
    expect(await planShotsWithPrism(form({ sceneId: s3.id, model: "openai/gpt-6-luna" }))).toMatchObject({
      ok: true,
    });
    const rec = await latest(s3.id);
    expect(rec).toMatchObject({ provider: "openai", spendAuthorization: "session", status: "queued" });
    expect((await repo.writing.getSession(d.project.id, sid))!.reservedUsd).toBeCloseTo(rec.estimate.usd, 6);
    await tickInlineStoryWorker(); // the real registry: no key in this process
    expect(await latest(s3.id)).toMatchObject({
      status: "failed",
      providerCalls: 0,
      error: { code: "not_configured" },
    });
  });
});

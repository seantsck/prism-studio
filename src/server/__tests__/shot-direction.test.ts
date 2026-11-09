import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import type { ShotDirectionProposal } from "@/data/shot-direction-repository";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { productionFrameInputs } from "@/domain/generation/production-frame-inputs";
import { draftLocationView } from "@/domain/location-view";
import { assetSchema, type ProjectData } from "@/domain/schemas";
import { FakeStoryProvider } from "@/story/providers/fake";
import { createStoryRegistry } from "@/story/registry";
import { StoryWorker } from "@/story/worker";

/**
 * Phase 5B-S5 acceptance: Shot → Direct with Prism → Storyboard Direction → review → Apply Direction → the I6
 * Production Frame Inputs, through the REAL server actions, memory repository and Story worker with the FREE test
 * director (no network, no paid call).
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
  // like the real requireProject: the Location Views and Continuity Locks are attached to the project data
  const full = async (slug: string) => {
    const r = world.repo as MemoryRepository;
    const d = await r.loadProject(slug);
    if (!d) return null;
    const lv = await r.locationViews.listForProject(d.project.id);
    const cc = await r.characterContinuity.listForProject(d.project.id);
    return {
      ...d,
      locationViews: lv.views,
      shotLocationViewSelections: lv.selections,
      characterContinuityLocks: cc.locks,
      shotCharacterContinuitySelections: cc.selections,
    };
  };
  return {
    getRepo: async () => world.repo,
    requireProjectFresh: async (slug: string) => {
      const data = await full(slug);
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
import { directShotWithPrism, submitDirectionReview } from "../shot-direction-actions";
import { tickInlineStoryWorker } from "../story";
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
const form = (fields: Record<string, string>, slug = "ojousama") => {
  const f = new FormData();
  f.set("projectSlug", slug);
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
async function data(): Promise<ProjectData> {
  const r = repo;
  const d = (await r.loadProject("ojousama"))!;
  const lv = await r.locationViews.listForProject(d.project.id);
  const cc = await r.characterContinuity.listForProject(d.project.id);
  return {
    ...d,
    locationViews: lv.views,
    shotLocationViewSelections: lv.selections,
    characterContinuityLocks: cc.locks,
    shotCharacterContinuitySelections: cc.selections,
  };
}
const shotByCode = async (code: string) => (await data()).shots.find((s) => s.shotCode === code)!;
const work = (provider = fake) =>
  new StoryWorker({
    store: repo.story,
    writing: repo.writing,
    shotLists: repo.shotLists,
    directions: repo.shotDirections,
    registry: createStoryRegistry({ PRISM_STUDIO_STORY_AI_PROVIDERS: "" }, [provider]),
    workerId: "test-worker",
  }).tick(5);
const latest = async (shotId: string) =>
  (await repo.shotDirections.listForShot((await data()).project.id, shotId))[0]!;
async function direct(shotId: string, instruction = "", provider = fake): Promise<ShotDirectionProposal> {
  const r = await directShotWithPrism(form({ shotId, model: FREE, instruction }));
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  await work(provider);
  return latest(shotId);
}
/** The review form as the page posts it (every section accepted unless overridden). */
const reviewForm = (
  rec: ShotDirectionProposal,
  fields: Record<string, string>,
  change: (f: FormData) => void = () => {},
) => {
  const f = form({ proposalId: rec.id, reviewPresent: "1", ...fields });
  for (const s of ["camera", "blocking", "lighting", "composition", "continuity", "storyboard"])
    f.set(`section:${s}`, "on");
  change(f);
  return f;
};
const pfInputs = async (shotId: string) =>
  productionFrameInputs(assembleGenerationPackage(buildShotContext(await data(), shotId)));

/** The Lobby "entrance → elevators" Location View, selected for Shot 3A (through the existing 2G.3 repository). */
async function selectLobbyView(shotId: string) {
  const d = await data();
  const lobby = d.locations.find((l) => l.name === "Grand Celeste Lobby")!;
  const asset = assetSchema.parse({
    id: randomUUID(),
    projectId: d.project.id,
    createdBy: null,
    type: "image",
    purpose: "location_ref",
    source: "upload",
    name: "lobby-entrance.png",
    originalFilename: "lobby-entrance.png",
    storageProvider: "local",
    bucket: null,
    objectPath: `${d.project.id}/lobby-entrance.png`,
    mime: "image/png",
    byteSize: 1000,
    checksum: "a".repeat(64),
    width: 2390,
    height: 1000,
    durationMs: null,
    frameRate: null,
    sampleRate: null,
    channels: null,
    tags: [],
    notes: "",
    metadata: {},
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
  });
  const draft = draftLocationView({
    id: randomUUID(),
    now: "2026-11-08T00:00:00.000Z",
    userId: null,
    projectId: d.project.id,
    location: lobby,
    asset,
    source: "upload",
    spec: {
      name: "Entrance → elevators",
      kind: "entrance",
      viewpointDescription: "From the entrance toward the elevator bank",
      orientation: "looking north",
      cameraPosition: "Just inside the revolving doors, looking north",
      cameraHeight: "eye level",
      cameraAngle: "level",
      shotSize: "wide",
      framing: "elevators centre frame",
      lens: "35mm",
    },
  });
  if (!draft.ok) throw new Error(draft.message);
  const { view } = await repo.locationViews.create({ draft: draft.draft, newAsset: asset });
  await repo.locationViews.selectForShot({
    projectId: d.project.id,
    shotId,
    locationViewId: view.id,
    userId: null,
    now: "2026-11-08T00:00:00.000Z",
  });
  return view;
}

describe("5B-S5 Shot → Storyboard Direction (Ojou-sama)", () => {
  it("Shot 3A → a proposal covering framing, lens, camera, blocking, lighting, composition, continuity and storyboard", async () => {
    const before = await shotByCode("3A");
    await selectLobbyView(before.id);
    const rec = await direct(before.id);
    expect(rec).toMatchObject({
      status: "ready",
      version: 1,
      provider: "prism-test",
      promptVersion: "shot-director-v1",
      schemaVersion: "prism.shot-direction.v1",
    });
    expect(rec.context.characters).toMatchObject([{ name: "Yumeko", look: "Episode 1 — Formal Black" }]);
    expect(rec.context.location?.name).toBe("Grand Celeste Lobby");
    expect(rec.context.locationView?.name).toBe("Entrance → elevators");
    const d = rec.direction!;
    expect(d.framing).toMatchObject({ shotSize: "medium_close" });
    expect(d.lens).toMatchObject({ focalRange: "85mm", intent: "intimate compression" });
    expect(d.camera).toMatchObject({
      height: "eye_level",
      angle: "eye_level",
      movement: "static",
      position: "Just inside the revolving doors, looking north",
    });
    expect(d.locationView).toMatchObject({ usesSelectedView: true, conflict: null }); // the View is a hard constraint
    expect(d.blocking).toMatchObject([{ characterKey: "c1", screenSide: "right", depth: "midground" }]);
    expect(d.lighting.mood).toBe("Hushed, lonely");
    expect(d.emotionalIntent).toMatch(/stillness/);
    expect(d.continuity.constraints).toContain("Yumeko in the Episode 1 — Formal Black Look");
    expect(d.storyboardDescription).toMatch(
      /^Medium close at 2\.39:1, from the Entrance → elevators view in Grand Celeste Lobby\./,
    );
    expect(fake.directCalls.at(-1)!.context.locationView?.cameraPosition).toBe(
      "Just inside the revolving doors, looking north",
    );
    expect(await shotByCode("3A")).toEqual(before); // nothing changes until Apply
  });

  it("edit → save → Apply Direction updates the SAME Shot; generations kept; I6 Production Frame Inputs reflect it", async () => {
    const before = await shotByCode("3A");
    const rec = await direct(before.id);
    expect(
      await submitDirectionReview(
        reviewForm(rec, {
          intent: "save",
          "edit:lighting.key": "Warm chandelier overhead, cool city spill through the glass",
        }),
      ),
    ).toMatchObject({ ok: true });
    expect((await repo.shotDirections.get(rec.projectId, rec.id))!.review!.edits).toEqual({
      "lighting.key": "Warm chandelier overhead, cool city spill through the glass",
    });
    expect(
      await submitDirectionReview(
        reviewForm(rec, {
          intent: "apply",
          "edit:lighting.key": "Warm chandelier overhead, cool city spill through the glass",
        }),
      ),
    ).toMatchObject({ ok: true, message: "Direction v1 applied to Shot 3A." });
    const d = await data();
    const after = d.shots.find((s) => s.id === before.id)!;
    expect(d.shots.length).toBe((await repo.loadProject("ojousama"))!.shots.length);
    expect(d.shots.filter((s) => s.shotCode === "3A")).toHaveLength(1); // no duplicate Shot
    expect(after).toMatchObject({
      id: before.id,
      shotCode: "3A",
      title: before.title,
      storyBeat: before.storyBeat,
      generation: before.generation,
      approval: before.approval,
      characters: before.characters,
    });
    expect(after.lighting.keyDirection).toBe("Warm chandelier overhead, cool city spill through the glass");
    expect(after.composition.lens).toBe("85mm — intimate compression");
    // the EXISTING I6 package and inputs read it, with no copying or wiring
    const inputs = await pfInputs(before.id);
    expect(inputs.direction[0]).toBe("medium close · 85mm — intimate compression · Hushed, lonely");
    expect(inputs.direction).toContain("Angle: eye level");
    expect(inputs.direction.join(" ")).toContain("Yumeko in the midground, frame right");
    expect(inputs.characters[0]!.lines).toContain(
      "Yumeko — screen right, midground, facing three-quarter away from camera",
    );
    expect(inputs.story[0]).toBe(`3A — ${before.title}`);
    const prompt = assembleGenerationPackage(buildShotContext(d, before.id)).camera.notes;
    expect(prompt).toMatch(/^Storyboard: Medium close at 2\.39:1/);
    // applied once
    expect(await submitDirectionReview(reviewForm(rec, { intent: "apply" }))).toMatchObject({
      ok: false,
      error: "This direction was already applied.",
    });
  });

  it("reject, regenerate and another approach are new versions; compare; a stale proposal cannot apply", async () => {
    const s = await shotByCode("3A");
    const v1 = await direct(s.id);
    expect(await submitDirectionReview(reviewForm(v1, { intent: "reject" }))).toMatchObject({
      ok: true,
      message: "Rejected — the Shot is unchanged.",
    });
    expect(await submitDirectionReview(reviewForm(v1, { intent: "apply" }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/was rejected/),
    });
    await submitDirectionReview(reviewForm(v1, { intent: "regenerate" }));
    await work();
    const v2 = await latest(s.id);
    expect(v2).toMatchObject({ version: 2, parentId: v1.id, instruction: "" });
    await submitDirectionReview(
      reviewForm(v2, { intent: "variant", variantNote: "make Yumeko feel isolated" }),
    );
    await work();
    const v3 = await latest(s.id);
    expect(v3).toMatchObject({ version: 3, parentId: v2.id, instruction: "make Yumeko feel isolated" });
    expect(v3.direction!.framing.shotSize).toBe("medium"); // wider: negative space around her
    expect(v3.direction!.blocking.map((b) => b.characterKey)).toEqual(
      v1.direction!.blocking.map((b) => b.characterKey),
    );
    await submitDirectionReview(reviewForm(v2, { intent: "save_alternate" }));
    expect((await repo.shotDirections.get(v2.projectId, v2.id))!.review!.savedAlternate).toBe(true);
    expect((await repo.shotDirections.get(v1.projectId, v1.id))!.direction).toEqual(v1.direction); // immutable
    // the Shot changes before Apply → v3 is stale
    await repo.upsert(s.projectId, "shots", {
      ...(await shotByCode("3A")),
      title: "Renamed",
      updatedAt: new Date().toISOString(),
    });
    expect(await submitDirectionReview(reviewForm(v3, { intent: "apply" }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/changed after Prism wrote this direction/),
    });
    expect((await shotByCode("3A")).composition).toEqual(s.composition);
  });

  it("a screenplay change makes a ready direction stale; an applied one is flagged for review, never re-run", async () => {
    const s = await shotByCode("3A");
    const rec = await direct(s.id);
    await submitDirectionReview(reviewForm(rec, { intent: "apply" }));
    const pending = await direct(s.id, "more intimate");
    const d = await data();
    await saveScript(
      form({
        episodeId: d.episodes[0]!.id,
        scriptText: d.episodes[0]!.scriptText.replace(
          "The lobby is hushed.",
          "The lobby is hushed, almost empty.",
        ),
      }),
    );
    expect(await submitDirectionReview(reviewForm(pending, { intent: "apply" }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/changed after Prism wrote/),
    });
    expect(fake.directCalls).toHaveLength(2); // nothing silently re-ran
  });

  it("multi-Shot continuity through S4 → S5: Sean stays screen-left, Yumeko screen-right, eyelines match", async () => {
    const d0 = await data();
    await saveScript(
      form({
        episodeId: d0.episodes[0]!.id,
        scriptText: d0.episodes[0]!.scriptText.replace(
          "お嬢様、僕と結婚してください。",
          "お嬢様、僕と結婚してください。\n\nYUMEKO\n……本気ですか？",
        ),
      }),
    );
    const s6 = (await data()).scenes.find(
      (s) => s.sceneNumber === "6" && s.episodeId === d0.episodes[0]!.id,
    )!;
    expect(await planShotsWithPrism(form({ sceneId: s6.id, model: FREE }))).toMatchObject({ ok: true });
    await work();
    const plan = (await repo.shotLists.listForScene(d0.project.id, s6.id))[0]!;
    const f = form({ proposalId: plan.id, reviewPresent: "1", intent: "apply" });
    for (const s of plan.plan!.shots) {
      f.set(`include:${s.key}`, "on");
      f.set(`decision:${s.key}`, "create");
    }
    expect(await submitShotListReview(f)).toMatchObject({ ok: true });
    const codes = ["6B", "6C", "6D", "6E"];
    const titles = (await data()).shots.filter((s) => codes.includes(s.shotCode)).map((s) => s.title);
    expect(titles).toEqual(["Restaurant master", "Sean OTS", "Yumeko single", "Sean reaction"]);
    const sides: Record<string, Record<string, string>> = {};
    for (const code of codes) {
      const shot = await shotByCode(code);
      const rec = await direct(shot.id);
      if (code === "6D") expect(rec.context.adjacent.map((a) => a.code)).toEqual(["6B", "6C", "6E"]);
      expect(rec.status, JSON.stringify(rec.error)).toBe("ready");
      await submitDirectionReview(reviewForm(rec, { intent: "apply" }));
      sides[code] = Object.fromEntries(
        rec.direction!.blocking.map((b) => [
          rec.context.characters.find((c) => c.key === b.characterKey)!.name,
          b.screenSide,
        ]),
      );
      expect(rec.direction!.continuity.breaksPattern).toBe(false);
    }
    expect(sides).toEqual({
      "6B": { Sean: "left", Yumeko: "right" },
      "6C": { Sean: "left", Yumeko: "right" },
      "6D": { Yumeko: "right" },
      "6E": { Sean: "left" },
    });
    const ots = await shotByCode("6C");
    expect(ots.spatial.eyelines).toMatch(
      /Sean looks screen-right, toward Yumeko; Yumeko looks screen-left, toward Sean/,
    );
    // S4's source traceability survives Apply Direction
    expect(ots.composition.notes).toMatch(/Source: lines \d+–\d+ \(Shot List v1\)/);
    expect((await pfInputs(ots.id)).characters.map((c) => c.lines.find((l) => /screen/.test(l)))).toEqual([
      expect.stringMatching(/^Sean — screen left/),
      expect.stringMatching(/^Yumeko — screen right/),
    ]);
  });

  it("refusals: another project's Shot; malformed provider output fails cleanly and changes nothing", async () => {
    const d = await data();
    const other = randomUUID();
    await repo.createProject(
      { ...d.project, id: other, slug: "other-film", title: "Other" },
      { ...d.bible, projectId: other },
    );
    const s = await shotByCode("3A");
    expect(await directShotWithPrism(form({ shotId: s.id, model: FREE }, "other-film"))).toMatchObject({
      ok: false,
      error: "Choose one of this project's Shots.",
    });
    const bad = new FakeStoryProvider({ directAnswers: ["{nope", { summary: "x" }] });
    const rec = await direct(s.id, "", bad);
    expect(rec).toMatchObject({
      status: "failed",
      direction: null,
      providerCalls: 2,
      error: { code: "invalid_output" },
    });
    expect(await shotByCode("3A")).toEqual(s);
  });

  it("spend: paid direction shows the estimate, can use the Episode's capped writing allowance; the worker fails closed", async () => {
    process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI = "true";
    const s = await shotByCode("3A");
    const d = await data();
    expect(await directShotWithPrism(form({ shotId: s.id, model: "openai/gpt-6-luna" }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /^Estimated cost: \$0\.\d{4} .*allow a capped writing session for this Episode\.$/,
      ),
    });
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
    expect(await directShotWithPrism(form({ shotId: s.id, model: "openai/gpt-6-luna" }))).toMatchObject({
      ok: true,
    });
    const rec = await latest(s.id);
    expect(rec).toMatchObject({ provider: "openai", spendAuthorization: "session", status: "queued" });
    expect((await repo.writing.getSession(d.project.id, sid))!.reservedUsd).toBeCloseTo(rec.estimate.usd, 6);
    await tickInlineStoryWorker();
    expect(await latest(s.id)).toMatchObject({
      status: "failed",
      providerCalls: 0,
      error: { code: "not_configured" },
    });
  });
});

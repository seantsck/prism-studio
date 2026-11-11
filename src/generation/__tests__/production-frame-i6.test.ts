import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage, shotChangedSinceAttempt } from "@/domain/generation-package";
import { evaluateCompatibility } from "@/domain/generation/compatibility";
import {
  fitProductionFrameToModel,
  modelsFittingEssentials,
  productionFrameInputs,
} from "@/domain/generation/production-frame-inputs";
import {
  ALTERNATE_COMPOSITION_LINE,
  buildPromptPlan,
  CREATOR_DIRECTION_GUARD,
} from "@/domain/generation/prompt-plan";
import { draftLocationView } from "@/domain/location-view";
import type { Asset, ProjectData } from "@/domain/schemas";
import { portraitFixturePng } from "@/generation/matting/fixture";
import { decodePng } from "@/generation/matting/png";
import { promoteGeneratedFrame } from "@/server/production-frame-generated";
import { CandidateSetBlockedError, submitCandidateSet, type CandidateSelection } from "../candidate-set";
import { makeHarness, type Harness } from "./helpers";

/**
 * Phase 5B-I6: reference-driven Production Frames on the REAL candidate-set workflow (memory, free mock image models,
 * in-process worker, local Storage). Shot 3A and the two-Character Shot 6A build their inputs from the Character and
 * Location Visual Bibles; nothing is attached by hand; no paid call.
 */
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function attached(h: Harness): Promise<ProjectData> {
  const data = await h.data();
  const pf = await h.repo.productionFrames.listForProject(data.project.id);
  const lv = await h.repo.locationViews.listForProject(data.project.id);
  const cc = await h.repo.characterContinuity.listForProject(data.project.id);
  return {
    ...data,
    productionFrames: pf.frames,
    productionFrameSelections: pf.selections,
    locationViews: lv.views,
    shotLocationViewSelections: lv.selections,
    characterContinuityLocks: cc.locks,
    shotCharacterContinuitySelections: cc.selections,
  };
}

async function img(h: Harness, label: string): Promise<Asset> {
  const d = await h.data();
  const bytes = portraitFixturePng(128, 96);
  const id = randomUUID();
  const objectPath = `${d.project.id}/fixtures/${id}.png`;
  await h.sink.put(objectPath, bytes);
  const png = decodePng(bytes);
  const asset = {
    ...d.assets[0]!,
    id,
    projectId: d.project.id,
    type: "image",
    purpose: "identity_ref",
    source: "upload",
    name: `${label}.png`,
    originalFilename: `${label}.png`,
    storageProvider: "local",
    bucket: null,
    objectPath,
    mime: "image/png",
    byteSize: bytes.length,
    checksum: sha(bytes),
    width: png.width,
    height: png.height,
    durationMs: null,
    metadata: {},
  } as Asset;
  await h.repo.upsert(d.project.id, "assets", asset);
  return asset;
}

/** A Character's Visual Bible (5B-I4): a canonical identity and one reference on the given Look. */
async function characterBible(h: Harness, name: string, lookId: string) {
  const d = await h.data();
  const c = d.characters.find((x) => x.name === name)!;
  const canonical = await img(h, `${name} canonical`);
  await h.repo.upsert(d.project.id, "identityRefs", {
    id: randomUUID(),
    characterId: c.id,
    slot: "additional",
    assetId: canonical.id,
    label: "Canonical identity",
    metadata: { visualRole: "canonical", source: "visual_bible" },
    locked: false,
  });
  const lookRef = await img(h, `${name} look`);
  const look = (await h.data()).looks.find((l) => l.id === lookId)!;
  await h.repo.upsert(d.project.id, "looks", {
    ...look,
    referenceAssetIds: [...look.referenceAssetIds, lookRef.id],
  });
  return { canonical, look: lookRef };
}

/** A Location View of `locationName` (2G.3), selected for `shotId`. */
async function selectedView(h: Harness, locationName: string, name: string, shotId: string) {
  const asset = await img(h, name);
  const location = (await h.data()).locations.find((l) => l.name === locationName)!;
  const drafted = draftLocationView({
    id: randomUUID(),
    now: h.clock.now.toISOString(),
    userId: null,
    projectId: location.projectId,
    location,
    asset,
    source: "upload",
    spec: { name, kind: "entrance" },
  });
  if (!drafted.ok) throw new Error(drafted.message);
  const view = (await h.repo.locationViews.create({ draft: drafted.draft, newAsset: null })).view;
  await h.repo.locationViews.selectForShot({
    projectId: location.projectId,
    shotId,
    locationViewId: view.id,
    userId: null,
    now: h.clock.now.toISOString(),
  });
  return { asset, view };
}

/** The Location's Visual Bible (5B-I5): canonical appearance + establishing + variants. */
async function locationBible(h: Harness, locationName: string) {
  const d = await h.data();
  const l = d.locations.find((x) => x.name === locationName)!;
  const canonical = await img(h, `${locationName} canonical`);
  const establishing = await img(h, `${locationName} establishing`);
  const night = await img(h, `${locationName} night`);
  const golden = await img(h, `${locationName} golden hour`);
  await h.repo.upsert(d.project.id, "locations", {
    ...l,
    visualBible: {
      canonicalAssetId: canonical.id,
      entries: [
        { assetId: establishing.id, role: "establishing", label: "wide" },
        { assetId: night.id, role: "variant", label: "night" },
        { assetId: golden.id, role: "variant", label: "golden hour" },
      ],
    },
  });
  return { canonical, establishing, night, golden };
}

async function setup3A() {
  const h = makeHarness();
  const d = await h.data();
  const shot = d.shots.find((s) => s.shotCode === "3A")!;
  await h.repo.upsert(d.project.id, "shots", {
    ...shot,
    composition: { ...shot.composition, aspectRatio: "16:9" },
    updatedAt: new Date(h.clock.now.getTime() - 1000).toISOString(),
  });
  const yumeko = await characterBible(h, "Yumeko", shot.characters[0]!.lookId!);
  const lobby = await locationBible(h, "Grand Celeste Lobby");
  const view = await selectedView(h, "Grand Celeste Lobby", "Lobby — entrance toward elevators", shot.id);
  return { h, shotId: shot.id, yumeko, lobby, view };
}

async function generate(h: Harness, shotId: string, selections: CandidateSelection[]) {
  return submitCandidateSet({
    data: await attached(h),
    shotId,
    registry: h.registry,
    config: h.config,
    generation: h.repo.generation,
    candidates: h.repo.candidates,
    selections,
    acknowledgeAll: true,
    confirmedTotalUsd: null,
    title: "Production Frame candidate",
    purpose: "",
    userId: null,
    projectRevision: null,
    generationPurpose: "production_frame",
    now: h.clock.now,
  });
}

async function drain(h: Harness, rounds = 16) {
  for (let i = 0; i < rounds; i++) {
    await h.worker().tick(10);
    h.clock.advance(2000);
  }
}

const pkgOf = async (h: Harness, shotId: string) =>
  assembleGenerationPackage(buildShotContext(await attached(h), shotId), h.clock.now);
const shotAttempts = async (h: Harness, shotId: string) =>
  (await h.data()).attempts
    .filter((a) => a.shotId === shotId)
    .sort((a, b) => a.attemptNumber - b.attemptNumber);
const refsOf = (a: { request: unknown }) =>
  (a.request as { references: Array<{ assetId: string; label: string; role: string }> }).references;
const limited = (h: Harness, max: number) => {
  const m = structuredClone(h.registry.model("mock", "mock-image-1")!);
  m.capabilities.references.maxReferences = max;
  return m;
};

describe("5B-I6 Shot 3A: the Production Frame builds from the Visual Bibles", () => {
  it("Generate Production Frame sends Yumeko canonical → Look → the selected Lobby view → Lobby canonical → establishing → night", async () => {
    const { h, shotId, yumeko, lobby, view } = await setup3A();
    const result = await generate(h, shotId, [
      { provider: "mock", modelId: "mock-image-1" },
      { provider: "mock", modelId: "mock-image-1" },
    ]);
    expect(result.submitted).toBe(2);
    await drain(h);
    const attempts = await shotAttempts(h, shotId);
    expect(attempts).toHaveLength(2);
    for (const a of attempts) {
      expect(a).toMatchObject({ status: "succeeded", provider: "mock", model: "mock-image-1" });
      // exactly what was sent, in priority order, recorded with labels
      expect(refsOf(a).map((r) => [r.assetId, r.role])).toEqual([
        [yumeko.canonical.id, "identity"],
        [yumeko.look.id, "character_look"],
        [view.asset.id, "location_view"],
        [lobby.canonical.id, "location"],
        [lobby.establishing.id, "location"],
        [lobby.night.id, "location"],
      ]);
      expect(JSON.stringify(a.request)).not.toContain(lobby.golden.id);
      expect(a.outputAssetId).toBeTruthy();
      expect(a.packageFingerprint).toMatch(/^[0-9a-f]{64}$/);
      // the frozen still prompt: semantic content, cinematography, continuity; no video timing
      const keys = (a.promptPlan as { sections: Array<{ key: string }> }).sections.map((s) => s.key);
      expect(keys).not.toContain("timing");
      expect(keys.indexOf("identity")).toBeLessThan(keys.indexOf("composition"));
      expect(a.prompt).toContain("Yumeko: match the canonical identity reference image");
      expect(a.prompt).toContain("Grand Celeste Lobby: match the canonical Location reference image");
    }
    // one candidate set holds both candidates (no new selection table)
    expect(result.view.members).toHaveLength(2);
    // a free mock model: a simulated cost is recorded, but nothing bills money and no provider is called
    expect(h.registry.billsMoney(h.registry.model("mock", "mock-image-1")!)).toBe(false);
    for (const a of attempts) expect(a.provider).toBe("mock");
  });

  it("the human-readable inputs name what is used; Advanced lists every reference with its tier", async () => {
    const { h, shotId } = await setup3A();
    const inputs = productionFrameInputs(await pkgOf(h, shotId));
    expect(inputs.characters[0]!.lines.slice(0, 2)).toEqual([
      "Yumeko — Canonical Identity",
      expect.stringMatching(/^Yumeko — .*Formal Black.* Look$/),
    ]);
    expect(inputs.location.slice(0, 2)).toEqual([
      "Grand Celeste Lobby — Lobby — entrance toward elevators",
      "Grand Celeste Lobby — Canonical",
    ]);
    expect(inputs.ready).toEqual({ characters: true, location: true, direction: true, story: true });
    expect(inputs.story[0]).toBe("3A — I Already Want to Go Home");
    expect(inputs.references.map((r) => r.tier)).toEqual([
      "essential",
      "essential",
      "essential",
      "optional",
      "optional",
      "optional",
    ]);
    expect(inputs.essentialCount).toBe(3);
  });

  it("works without a Storyboard; an approved Storyboard is used as an optional composition reference", async () => {
    const { h, shotId, yumeko } = await setup3A();
    // the seeded approved Storyboard has no stored file: generation works without it
    let pkg = await pkgOf(h, shotId);
    expect(productionFrameInputs(pkg).references.some((r) => r.role === "storyboard")).toBe(false);
    // give it bytes: it is used, as an OPTIONAL reference (it never outranks an essential one at the limit)
    const d = await h.data();
    const sb = d.frames.find((f) => f.shotId === shotId && f.approved)!;
    const stored = await img(h, "3A storyboard");
    await h.repo.upsert(d.project.id, "assets", { ...stored, id: sb.assetId! });
    pkg = await pkgOf(h, shotId);
    const refs = productionFrameInputs(pkg).references;
    expect(refs[0]).toMatchObject({ role: "storyboard", tier: "optional" });
    const three = evaluateCompatibility(pkg, limited(h, 3), { purpose: "production_frame" });
    expect(three.used.references.map((r) => r.role)).toEqual(["identity", "character_look", "location_view"]);
    expect(three.used.references[0]!.assetId).toBe(yumeko.canonical.id);
    const four = evaluateCompatibility(pkg, limited(h, 4), { purpose: "production_frame" });
    expect(four.used.references.map((r) => r.role)).toEqual([
      "storyboard",
      "identity",
      "character_look",
      "location_view",
    ]);
  });

  it("limits: optional images are trimmed first and named; essential overflow refuses; the model is never switched", async () => {
    const { h, shotId, lobby } = await setup3A();
    const pkg = await pkgOf(h, shotId);
    const four = fitProductionFrameToModel(pkg, limited(h, 4));
    expect(four.refusal).toBeNull();
    expect(four.sent.map((r) => r.tier)).toEqual(["essential", "essential", "essential", "optional"]);
    expect(four.sent[3]!.assetId).toBe(lobby.canonical.id);
    expect(four.omitted.map((r) => r.label)).toEqual([
      "Grand Celeste Lobby establishing view (wide)",
      "Grand Celeste Lobby variant (night)",
    ]);
    const two = fitProductionFrameToModel(pkg, limited(h, 2));
    expect(two.refusal).toBe(
      "This model supports 2 references, but this Shot requires 3 essential references.",
    );
    expect(
      modelsFittingEssentials(pkg, [limited(h, 2), limited(h, 3)]).map(
        (m) => m.capabilities.references.maxReferences,
      ),
    ).toEqual([3]);
    // the real submission with the 2-reference model: refused, nothing created, no other model used
    const before = (await shotAttempts(h, shotId)).length;
    await expect(
      generate(h, shotId, [{ provider: "mock", modelId: "mock-image-lite" }]),
    ).rejects.toBeInstanceOf(CandidateSetBlockedError);
    await expect(generate(h, shotId, [{ provider: "mock", modelId: "mock-image-lite" }])).rejects.toThrow(
      /supports 2 references, but this Shot requires 3 essential references/,
    );
    expect(await shotAttempts(h, shotId)).toHaveLength(before);
  });

  it("promotion is explicit; Generate Alternatives never overwrites the canonical Production Frame; edits stay immutable", async () => {
    const { h, shotId } = await setup3A();
    const first = await generate(h, shotId, [{ provider: "mock", modelId: "mock-image-1" }]);
    await drain(h);
    // nothing is promoted automatically
    expect(buildShotContext(await attached(h), shotId).selectedProductionFrame ?? null).toBeNull();
    const [a] = await shotAttempts(h, shotId);
    await h.repo.candidates.setPreferred(first.view.set.id, a!.id, null, h.clock.now.toISOString());
    const deps = { frames: h.repo.productionFrames, generation: h.repo.generation, qa: h.repo.mediaQa };
    const promoted = await promoteGeneratedFrame(deps, buildShotContext(await attached(h), shotId), {
      attemptId: a!.id,
      userId: null,
    });
    const canonicalBefore = structuredClone(promoted.frame);
    // Generate Alternatives: same identity, Look, Location and continuity; only the composition may vary
    const alt = await generate(h, shotId, [
      {
        provider: "mock",
        modelId: "mock-image-1",
        direction: { kind: "alternate_composition", text: "low angle" },
      },
    ]);
    expect(alt.submitted).toBe(1);
    await drain(h);
    const attempts = await shotAttempts(h, shotId);
    const altAttempt = attempts.at(-1)!;
    expect(altAttempt.modelSettings).toMatchObject({
      creatorDirection: { kind: "alternate_composition", text: "low angle" },
    });
    expect(altAttempt.prompt).toContain(ALTERNATE_COMPOSITION_LINE);
    expect(altAttempt.prompt).toContain(CREATOR_DIRECTION_GUARD);
    // the alternate receives the SAME identity / Look / Location images (plus the current frame, as a reference)
    const aRefs = new Set(refsOf(a!).map((r) => r.assetId));
    for (const id of aRefs) expect(refsOf(altAttempt).map((r) => r.assetId)).toContain(id);
    const ctx = buildShotContext(await attached(h), shotId);
    expect(ctx.selectedProductionFrame?.id).toBe(promoted.frame.id);
    expect(ctx.productionFrames.find((f) => f.id === promoted.frame.id)).toEqual(canonicalBefore);
    // Edit Image from the canonical frame: a NEW still; the frame's Asset is byte-identical
    const pfAsset = (await h.data()).assets.find((x) => x.id === promoted.frame.assetId)!;
    const bytesBefore = sha((await h.sink.get(pfAsset.objectPath!))!);
    const edited = await generate(h, shotId, [
      {
        provider: "mock",
        modelId: "mock-image-1",
        edit: { sourceAssetId: pfAsset.id, instruction: "warmer practicals" },
      },
    ]);
    expect(edited.submitted).toBe(1);
    await drain(h);
    const editAttempt = (await shotAttempts(h, shotId)).at(-1)!;
    expect(editAttempt.outputAssetId).not.toBe(pfAsset.id);
    expect(sha((await h.sink.get(pfAsset.objectPath!))!)).toBe(bytesBefore);
    expect(buildShotContext(await attached(h), shotId).selectedProductionFrame?.id).toBe(promoted.frame.id);
  });

  it("freshness follows what was SENT: an unused variant keeps the candidate fresh; a new Lobby canonical stales it", async () => {
    const { h, shotId } = await setup3A();
    await generate(h, shotId, [{ provider: "mock", modelId: "mock-image-1" }]);
    await drain(h);
    const [a] = await shotAttempts(h, shotId);
    expect(shotChangedSinceAttempt(a!, await pkgOf(h, shotId))?.changed).toBe(false);
    const d = await h.data();
    const lobby = d.locations.find((l) => l.name === "Grand Celeste Lobby")!;
    const crowd = await img(h, "Lobby crowded daytime");
    await h.repo.upsert(d.project.id, "locations", {
      ...lobby,
      visualBible: {
        ...lobby.visualBible!,
        entries: [
          ...lobby.visualBible!.entries!,
          { assetId: crowd.id, role: "variant", label: "crowded daytime" },
        ],
      },
    });
    expect(shotChangedSinceAttempt(a!, await pkgOf(h, shotId))?.changed).toBe(false);
    const next = await img(h, "Lobby canonical v2");
    const l2 = (await h.data()).locations.find((l) => l.id === lobby.id)!;
    await h.repo.upsert(d.project.id, "locations", {
      ...l2,
      visualBible: { ...l2.visualBible!, canonicalAssetId: next.id },
    });
    expect(shotChangedSinceAttempt(a!, await pkgOf(h, shotId))?.changed).toBe(true);
  });

  it("another project's image never reaches the package, even if a Shot names it", async () => {
    const { h, shotId } = await setup3A();
    const d = await h.data();
    const shot = d.shots.find((s) => s.id === shotId)!;
    const foreignId = randomUUID();
    await h.repo.upsert(d.project.id, "shots", {
      ...shot,
      generation: { ...shot.generation, referenceAssetIds: [foreignId] },
    });
    const pkg = await pkgOf(h, shotId);
    expect(productionFrameInputs(pkg).references.some((r) => r.assetId === foreignId)).toBe(false);
  });
});

describe("5B-I6 two Characters (Shot 6A): identities are essential", () => {
  async function setup6A() {
    const h = makeHarness();
    const d = await h.data();
    const shot = d.shots.find((s) => s.shotCode === "6A")!;
    await h.repo.upsert(d.project.id, "shots", {
      ...shot,
      // the seeded 6A has no camera movement yet (an existing preflight requirement, not an I6 one)
      composition: {
        ...shot.composition,
        aspectRatio: "16:9",
        movement: shot.composition.movement || "Static",
      },
      spatial: {
        ...shot.spatial,
        subjectBlocking: shot.spatial.subjectBlocking || "Sean left, Yumeko right",
      },
      updatedAt: new Date(h.clock.now.getTime() - 1000).toISOString(),
    });
    const byName = (n: string) =>
      shot.characters.find((c) => d.characters.find((x) => x.id === c.characterId)?.name === n)!;
    const sean = await characterBible(h, "Sean", byName("Sean").lookId!);
    const yumeko = await characterBible(h, "Yumeko", byName("Yumeko").lookId!);
    const restaurant = await locationBible(h, "Sky-View Restaurant");
    const view = await selectedView(h, "Sky-View Restaurant", "Restaurant — table toward skyline", shot.id);
    return { h, shotId: shot.id, sean, yumeko, restaurant, view };
  }

  it("both canonical identities and both Looks lead; the Location follows; optional images are trimmed first", async () => {
    const { h, shotId, sean, yumeko, restaurant, view } = await setup6A();
    const pkg = await pkgOf(h, shotId);
    const inputs = productionFrameInputs(pkg);
    expect(inputs.references.map((r) => r.assetId)).toEqual([
      sean.canonical.id,
      yumeko.canonical.id,
      sean.look.id,
      yumeko.look.id,
      view.asset.id,
      restaurant.canonical.id,
      restaurant.establishing.id,
      restaurant.night.id,
    ]);
    expect(inputs.essentialCount).toBe(5);
    const five = fitProductionFrameToModel(pkg, limited(h, 5));
    expect(five.refusal).toBeNull();
    expect(five.sent.every((r) => r.tier === "essential")).toBe(true);
    expect(five.omitted.map((r) => r.assetId)).toEqual([
      restaurant.canonical.id,
      restaurant.establishing.id,
      restaurant.night.id,
    ]);
    // a model that cannot fit both identities and Looks refuses: no identity is ever dropped for a Location image
    const four = fitProductionFrameToModel(pkg, limited(h, 4));
    expect(four.refusal).toBe(
      "This model supports 4 references, but this Shot requires 5 essential references.",
    );
    // the real workflow with a full model sends everything, in order
    await generate(h, shotId, [{ provider: "mock", modelId: "mock-image-1" }]);
    await drain(h);
    const [a] = await shotAttempts(h, shotId);
    expect(
      refsOf(a!)
        .slice(0, 5)
        .map((r) => r.assetId),
    ).toEqual([sean.canonical.id, yumeko.canonical.id, sean.look.id, yumeko.look.id, view.asset.id]);
  });

  it("the still prompt separates content, cinematography and continuity, and keeps both identities protected", () => {
    const pkg = {
      shot: { code: "6A", title: "t" },
      storyIntent: { storyBeat: "b", dramaticPurpose: "", scene: {}, episodeTitle: "" },
      characters: [
        {
          characterId: "s",
          name: "Sean",
          physicalDescription: "",
          canonicalIdentityAssetId: "x",
          look: null,
        },
      ],
      camera: { shotSize: "MS", framing: "", lens: "35mm" },
      blocking: { subjectBlocking: "", marks: [] },
      continuity: { projectRules: [] },
      constraints: { hard: [], guardrails: [], negative: [], generatorNotes: "" },
      timing: { beats: [], segments: [], durationMs: 4000, source: "x" },
      performance: [],
      lighting: {},
      references: {},
      props: [],
      set: null,
    } as never;
    const plan = buildPromptPlan(pkg, null, {
      purpose: "production_frame",
      direction: { kind: "additional", text: "a touch tighter" },
    });
    const keys = plan.sections.map((s) => s.key);
    expect(keys).toEqual(["subject", "identity", "wardrobe", "composition", "camera", "hard_constraints"]);
    expect(plan.sections.find((s) => s.key === "composition")!.lines).toContain(
      "Creator direction: a touch tighter",
    );
    expect(plan.sections.find((s) => s.key === "hard_constraints")!.lines[0]).toBe(CREATOR_DIRECTION_GUARD);
    // the video purpose is unchanged (timing stays; no direction is ever applied)
    const video = buildPromptPlan(pkg, null, { direction: { kind: "additional", text: "x" } });
    expect(video.sections.map((s) => s.key)).toContain("timing");
    expect(JSON.stringify(video)).not.toContain("Creator direction");
  });
});

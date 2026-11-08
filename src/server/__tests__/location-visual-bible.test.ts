import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { buildShotContext } from "@/domain/context";
import { approvalSnapshot } from "@/domain/fingerprint";
import { assembleGenerationPackage } from "@/domain/generation-package";
import {
  deriveProductionFrameReferenceCandidates,
  evaluateCompatibility,
} from "@/domain/generation/compatibility";
import { locationBibleOf, locationBibleReadiness } from "@/domain/location-visual-bible";
import type { Asset, Shot } from "@/domain/schemas";
import { readGenerationConfig } from "@/generation/config";
import { portraitFixturePng } from "@/generation/matting/fixture";
import { decodePng } from "@/generation/matting/png";
import { createRegistry } from "@/generation/registry";
import { LocalDiskSink } from "@/generation/sink";
import { prepareSubmission } from "@/generation/submission";
import { GenerationWorker } from "@/generation/worker";

/**
 * Phase 5B-I5: the Location Visual Bible through the REAL server actions, queue, worker, sink and delete path, on the
 * Ojou-sama project (memory, fixtures, free mock models; no paid generation, no provider call).
 */
vi.setConfig({ testTimeout: 60_000 });
const env = {
  NODE_ENV: "test",
  PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
  PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
};
const world = vi.hoisted(() => ({ repo: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth", () => ({ requireUser: async () => ({ kind: "memory", id: "tester" }) }));
vi.mock("@/server/repo", async () => {
  const { UserFacingError } = await import("@/server/action-result");
  return {
    getRepo: async () => world.repo,
    requireProjectFresh: async (slug: string) => {
      const r = world.repo as MemoryRepository;
      const data = await r.loadProject(slug);
      if (!data) throw new UserFacingError("That project no longer exists.");
      const pf = await r.productionFrames.listForProject(data.project.id);
      const lv = await r.locationViews.listForProject(data.project.id);
      const cc = await r.characterContinuity.listForProject(data.project.id);
      return {
        ...data,
        productionFrames: pf.frames,
        productionFrameSelections: pf.selections,
        locationViews: lv.views,
        shotLocationViewSelections: lv.selections,
        characterContinuityLocks: cc.locks,
        shotCharacterContinuitySelections: cc.selections,
      };
    },
  };
});
vi.mock("@/server/location-views", () => ({
  getLocationViewRepo: async () => (world.repo as MemoryRepository).locationViews,
}));
vi.mock("@/server/generation", async () => {
  const { readGenerationConfig: read } = await import("@/generation/config");
  const { createRegistry: create } = await import("@/generation/registry");
  const e = {
    NODE_ENV: "test",
    PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
    PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
  };
  return {
    getGenerationRepo: async () => (world.repo as MemoryRepository).generation,
    getGenerationConfig: () => read(e),
    getRegistry: () => create(e, read(e)),
  };
});
vi.mock("@/server/media-qa", () => ({ getMediaQaRepo: async () => ({ assetPins: async () => [] }) }));
vi.mock("@/server/previs", () => ({
  getPrevisRepo: async () => ({
    spatialPassUsesAsset: async () => false,
    reconstructionUsesAsset: async () => false,
  }),
}));
vi.mock("@/server/ingest-upload", () => ({
  discardUpload: vi.fn(async () => {}),
  hasFile: () => false,
  ingestUpload: vi.fn(),
}));

import { deleteAsset } from "../actions";
import {
  addLocationDesignation,
  clearLocationDesignation,
  setCanonicalLocation,
} from "../location-visual-bible-actions";
import { createLocationViewFromReference, selectShotLocationView } from "../location-view-actions";
import { saveAsLocationView, startSubjectImage } from "../subject-image-actions";
import { setCanonicalIdentity } from "../visual-bible-actions";

const sinkRoot = mkdtempSync(path.join(tmpdir(), "prism-i5-"));
afterAll(() => rmSync(sinkRoot, { recursive: true, force: true }));
let repo: MemoryRepository;
let sink: LocalDiskSink;
let t = Date.now();
beforeEach(() => {
  repo = new MemoryRepository();
  world.repo = repo;
  sink = new LocalDiskSink(sinkRoot);
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ projectSlug: "ojousama", ...fields })) f.set(k, v);
  return f;
};
const data = async () => {
  const r = repo;
  const d = (await r.loadProject("ojousama"))!;
  const lv = await r.locationViews.listForProject(d.project.id);
  const cc = await r.characterContinuity.listForProject(d.project.id);
  const pf = await r.productionFrames.listForProject(d.project.id);
  return {
    ...d,
    productionFrames: pf.frames,
    productionFrameSelections: pf.selections,
    locationViews: lv.views,
    shotLocationViewSelections: lv.selections,
    characterContinuityLocks: cc.locks,
    shotCharacterContinuitySelections: cc.selections,
  };
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const locByName = async (name: string) => (await data()).locations.find((l) => l.name === name)!;
const shot3A = async () => (await data()).shots.find((s) => s.shotCode === "3A")!;

async function setLocked(name: string, locked: boolean) {
  const d = await data();
  const l = d.locations.find((x) => x.name === name)!;
  await repo.upsert(d.project.id, "locations", { ...l, locked });
}

async function work(ticks = 8) {
  const config = readGenerationConfig(env);
  const worker = new GenerationWorker({
    store: repo.generation,
    registry: createRegistry(env, config),
    sink,
    config,
    logger: { info() {}, warn() {}, error() {} },
    clock: () => new Date(t),
  });
  for (let i = 0; i < ticks; i++) {
    await worker.tick(5);
    t += 2000;
  }
}

/** A stored image Asset (fixture bytes); optionally attached to a Location's references. */
async function image(
  label: string,
  opts: { locationName?: string; w?: number; h?: number } = {},
): Promise<Asset> {
  const d = await data();
  const bytes = portraitFixturePng(opts.w ?? 128, opts.h ?? 96);
  const id = randomUUID();
  const objectPath = `${d.project.id}/fixtures/${id}.png`;
  await sink.put(objectPath, bytes);
  const png = decodePng(bytes);
  const asset = {
    ...d.assets[0]!,
    id,
    projectId: d.project.id,
    type: "image",
    purpose: "location_ref",
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
  await repo.upsert(d.project.id, "assets", asset);
  if (opts.locationName) {
    const l = (await data()).locations.find((x) => x.name === opts.locationName)!;
    await repo.upsert(d.project.id, "locations", { ...l, referenceAssetIds: [...l.referenceAssetIds, id] });
  }
  return asset;
}

/** A Location View made from one of the Location's references through the EXISTING 2G.3 action. */
async function view(locationName: string, label: string, kind: string) {
  const a = await image(label, { locationName });
  const l = await locByName(locationName);
  expect(
    await createLocationViewFromReference(
      form({ locationId: l.id, assetId: a.id, lv_name: label, lv_kind: kind }),
    ),
  ).toMatchObject({ ok: true });
  const v = (await data()).locationViews.find((x) => x.assetId === a.id)!;
  return { asset: a, view: v };
}

async function canonical(locationName: string, label: string) {
  const a = await image(label, { locationName });
  const l = await locByName(locationName);
  expect(await setCanonicalLocation(form({ locationId: l.id, assetId: a.id }))).toMatchObject({ ok: true });
  return a;
}

async function designate(locationName: string, role: string, label: string) {
  const a = await image(`${locationName} ${label}`, { locationName });
  const l = await locByName(locationName);
  expect(await addLocationDesignation(form({ locationId: l.id, assetId: a.id, role, label }))).toMatchObject({
    ok: true,
  });
  return a;
}

const LOCATIONS = [
  "Grand Celeste Hotel Canopy",
  "Grand Celeste Lobby",
  "Sky-View Restaurant",
  "Hotel Hallway",
  "Tokyo Night Streets",
];

describe("5B-I5 Location Visual Bible: designations", () => {
  it("canonical appearance: set explicitly, one per Location, replacement confirmed, source immutable, generation never replaces it", async () => {
    await setLocked("Grand Celeste Lobby", false);
    const lobby = await locByName("Grand Celeste Lobby");
    const first = await canonical("Grand Celeste Lobby", "Lobby canonical");
    const before = structuredClone((await data()).assets.find((a) => a.id === first.id));
    const second = await image("Lobby alt", { locationName: "Grand Celeste Lobby" });
    expect(await setCanonicalLocation(form({ locationId: lobby.id, assetId: second.id }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("Confirm to replace"),
    });
    expect(locationBibleOf(await locByName("Grand Celeste Lobby")).canonicalAssetId).toBe(first.id);
    // a generated image of the Location never replaces the canonical appearance
    expect(
      await startSubjectImage(
        form({
          subjectKind: "location",
          subjectId: lobby.id,
          intent: "establishing_view",
          model: "mock/mock-image-1",
        }),
      ),
    ).toMatchObject({ ok: true });
    await work();
    expect(locationBibleOf(await locByName("Grand Celeste Lobby")).canonicalAssetId).toBe(first.id);
    // explicit replacement
    expect(
      await setCanonicalLocation(form({ locationId: lobby.id, assetId: second.id, confirmReplace: "1" })),
    ).toMatchObject({ ok: true });
    const bible = locationBibleOf(await locByName("Grand Celeste Lobby"));
    expect(bible.canonicalAssetId).toBe(second.id);
    // the old image stays in the library, byte-identical
    expect((await data()).assets.find((a) => a.id === first.id)).toEqual(before);
    expect(sha((await sink.get(first.objectPath!))!)).toBe(first.checksum);
    // a generated image may become the canonical appearance too (Use as Canonical on the image)
    const gen = (
      await repo.generation.listSubjectImageAttempts({ kind: "location", locationId: lobby.id })
    )[0]!;
    expect(
      await setCanonicalLocation(
        form({ locationId: lobby.id, attemptId: gen.attempt.id, confirmReplace: "1" }),
      ),
    ).toMatchObject({ ok: true });
    expect(locationBibleOf(await locByName("Grand Celeste Lobby")).canonicalAssetId).toBe(
      gen.outputs[0]!.asset.id,
    );
  });

  it("establishing views, background plates and free-label variants are stored as designations of the same Location", async () => {
    await setLocked("Grand Celeste Lobby", false);
    const lobby = await locByName("Grand Celeste Lobby");
    const wide = await designate("Grand Celeste Lobby", "establishing", "Lobby  Wide");
    const plate = await designate("Grand Celeste Lobby", "plate", "");
    const night = await designate("Grand Celeste Lobby", "variant", "Rainy  Night");
    const custom = await designate("Grand Celeste Lobby", "variant", "after the gala");
    const bible = locationBibleOf(await locByName("Grand Celeste Lobby"));
    expect(bible.entries).toEqual([
      { assetId: wide.id, role: "establishing", label: "lobby wide" },
      { assetId: plate.id, role: "plate", label: "" },
      { assetId: night.id, role: "variant", label: "rainy night" },
      { assetId: custom.id, role: "variant", label: "after the gala" },
    ]);
    // a variant needs a name; an unknown role is refused
    expect(
      await addLocationDesignation(
        form({ locationId: lobby.id, assetId: wide.id, role: "variant", label: " " }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("Name the variant") });
    expect(
      await addLocationDesignation(
        form({ locationId: lobby.id, assetId: wide.id, role: "angle", label: "x" }),
      ),
    ).toMatchObject({ ok: false });
    // a variant is part of the SAME Location: no new Location was created
    expect((await data()).locations.filter((l) => l.name.includes("Lobby"))).toHaveLength(1);
  });

  it("a locked Location refuses every Visual Bible change", async () => {
    const lobby = await locByName("Grand Celeste Lobby");
    expect(lobby.locked).toBe(true);
    const a = await image("Lobby locked", { locationName: "Grand Celeste Lobby" });
    const err = "That location is locked. Unlock it before changing its Visual Bible.";
    expect(await setCanonicalLocation(form({ locationId: lobby.id, assetId: a.id }))).toMatchObject({
      ok: false,
      error: err,
    });
    expect(
      await addLocationDesignation(form({ locationId: lobby.id, assetId: a.id, role: "plate", label: "" })),
    ).toMatchObject({ ok: false, error: err });
    expect(locationBibleOf(await locByName("Grand Celeste Lobby")).canonicalAssetId).toBeNull();
  });

  it("refuses another Location's image and another project's image", async () => {
    await setLocked("Grand Celeste Lobby", false);
    const lobby = await locByName("Grand Celeste Lobby");
    const hallwayImg = await image("Hallway ref", { locationName: "Hotel Hallway" });
    expect(await setCanonicalLocation(form({ locationId: lobby.id, assetId: hallwayImg.id }))).toMatchObject({
      ok: false,
      error: "That image does not belong to this location.",
    });
    const d = await data();
    const otherId = randomUUID();
    await repo.createProject(
      { ...d.project, id: otherId, slug: "other-project", title: "Other" },
      { ...d.bible, projectId: otherId },
    );
    const foreign = { ...(await image("probe")), id: randomUUID(), projectId: otherId };
    await repo.upsert(otherId, "assets", foreign);
    for (const f of [
      () => setCanonicalLocation(form({ locationId: lobby.id, assetId: foreign.id })),
      () =>
        addLocationDesignation(form({ locationId: lobby.id, assetId: foreign.id, role: "plate", label: "" })),
    ])
      expect(await f()).toMatchObject({ ok: false, error: "That image does not belong to this location." });
    expect(JSON.stringify((await locByName("Grand Celeste Lobby")).visualBible ?? {})).not.toContain(
      foreign.id,
    );
  });

  it("designations pin their image against deletion; removing the designation restores the normal rules", async () => {
    await setLocked("Hotel Hallway", false);
    const hall = await locByName("Hotel Hallway");
    // a GENERATED image (not a Location reference) designated as a background plate
    await startSubjectImage(
      form({ subjectKind: "location", subjectId: hall.id, intent: "background", model: "mock/mock-image-1" }),
    );
    await work();
    const gen = (
      await repo.generation.listSubjectImageAttempts({ kind: "location", locationId: hall.id })
    )[0]!;
    const out = gen.outputs[0]!.asset;
    expect(
      await addLocationDesignation(
        form({ locationId: hall.id, attemptId: gen.attempt.id, role: "plate", label: "" }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await setCanonicalLocation(form({ locationId: hall.id, attemptId: gen.attempt.id })),
    ).toMatchObject({
      ok: true,
    });
    expect(await deleteAsset(form({ assetId: out.id }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("in use"),
    });
    // removing ONE designation keeps the other pin
    await clearLocationDesignation(form({ locationId: hall.id, role: "plate", assetId: out.id }));
    expect(await deleteAsset(form({ assetId: out.id }))).toMatchObject({ ok: false });
    await clearLocationDesignation(form({ locationId: hall.id, role: "canonical", assetId: out.id }));
    expect(locationBibleOf(await locByName("Hotel Hallway"))).toEqual({
      canonicalAssetId: null,
      entries: [],
    });
    // historical generation attempts are provenance, not usage
    expect(await deleteAsset(form({ assetId: out.id }))).toMatchObject({ ok: true });
  });

  it("Use as Location View: needs an explicit name, honours the Location lock, keeps the source and lineage, never replaces a view", async () => {
    await setLocked("Hotel Hallway", false);
    const hall = await locByName("Hotel Hallway");
    await startSubjectImage(
      form({
        subjectKind: "location",
        subjectId: hall.id,
        intent: "alternate_angle",
        model: "mock/mock-image-1",
      }),
    );
    await work();
    const gen = (
      await repo.generation.listSubjectImageAttempts({ kind: "location", locationId: hall.id })
    )[0]!;
    const out = gen.outputs[0]!.asset;
    const save = (extra: Record<string, string>) =>
      saveAsLocationView(form({ locationId: hall.id, attemptId: gen.attempt.id, lv_kind: "zone", ...extra }));
    expect(await save({ lv_name: "" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Name the"),
    });
    expect(await save({ lv_name: "Hallway — elevator end" })).toMatchObject({ ok: true });
    let views = (await data()).locationViews.filter((v) => v.locationId === hall.id);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ name: "Hallway — elevator end", assetId: out.id, kind: "zone" });
    // the same image + view again does not make or replace anything
    expect(await save({ lv_name: "Hallway — elevator end" })).toMatchObject({ ok: true });
    views = (await data()).locationViews.filter((v) => v.locationId === hall.id);
    expect(views).toHaveLength(1);
    // lineage: the view's image IS the generated output; the attempt still records how it was made
    expect(out.metadata).toMatchObject({ generation: { attemptId: gen.attempt.id } });
    // locked Location: refused
    await setLocked("Hotel Hallway", true);
    expect(await save({ lv_name: "Hallway — room-door end" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("locked"),
    });
  });

  it("a Location image generation leads with the canonical appearance, then establishing views and plates", async () => {
    await setLocked("Sky-View Restaurant", false);
    const r = await locByName("Sky-View Restaurant");
    const loose = await image("Restaurant loose", { locationName: "Sky-View Restaurant" });
    const plate = await designate("Sky-View Restaurant", "plate", "");
    const est = await designate("Sky-View Restaurant", "establishing", "restaurant wide");
    const canon = await canonical("Sky-View Restaurant", "Restaurant canonical");
    expect(
      await startSubjectImage(
        form({
          subjectKind: "location",
          subjectId: r.id,
          intent: "time_variant",
          variant: "golden hour",
          model: "mock/mock-image-1",
        }),
      ),
    ).toMatchObject({ ok: true });
    const v = (await repo.generation.listSubjectImageAttempts({ kind: "location", locationId: r.id }))[0]!;
    const refs = (v.attempt.request as { references: Array<{ assetId: string }> }).references.map(
      (x) => x.assetId,
    );
    expect(refs).toEqual([canon.id, est.id, plate.id, loose.id]);
    expect(JSON.stringify(v.attempt.request)).toContain("Time of day / state: golden hour.");
  });
});

describe("5B-I5 Ojou-sama acceptance: Shots receive Character + Location references automatically", () => {
  async function ojousama() {
    for (const n of LOCATIONS) await setLocked(n, false);
    const out = {
      exterior: {
        canonical: await canonical("Grand Celeste Hotel Canopy", "Exterior canonical"),
        arrival: await view("Grand Celeste Hotel Canopy", "Canopy — arrival", "entrance"),
        nightEstablishing: await designate("Grand Celeste Hotel Canopy", "establishing", "night exterior"),
      },
      lobby: {
        canonical: await canonical("Grand Celeste Lobby", "Lobby canonical"),
        toElevators: await view("Grand Celeste Lobby", "Lobby — entrance toward elevators", "entrance"),
        toEntrance: await view("Grand Celeste Lobby", "Lobby — elevators toward entrance", "reverse"),
        establishing: await designate("Grand Celeste Lobby", "establishing", "lobby wide"),
        night: await designate("Grand Celeste Lobby", "variant", "night"),
        goldenHour: await designate("Grand Celeste Lobby", "variant", "golden hour"),
      },
      restaurant: {
        canonical: await canonical("Sky-View Restaurant", "Restaurant canonical"),
        toSkyline: await view("Sky-View Restaurant", "Restaurant — table toward skyline", "custom"),
        toTable: await view("Sky-View Restaurant", "Restaurant — skyline toward table", "reverse"),
      },
      hallway: {
        canonical: await canonical("Hotel Hallway", "Hallway canonical"),
        elevator: await view("Hotel Hallway", "Hallway — elevator end", "zone"),
        room: await view("Hotel Hallway", "Hallway — room-door end", "reverse"),
      },
      street: {
        canonical: await canonical("Tokyo Night Streets", "Street canonical"),
        establishing: await designate("Tokyo Night Streets", "establishing", "street establishing"),
      },
    };
    for (const n of LOCATIONS) await setLocked(n, true);
    // Yumeko: canonical identity + her selected Look's reference (5B-I4)
    const d = await data();
    const shot = d.shots.find((s) => s.shotCode === "3A")!;
    const y = d.characters.find((c) => c.name === "Yumeko")!;
    const lookId = shot.characters.find((c) => c.characterId === y.id)!.lookId!;
    const yCanon = await image("Yumeko canonical");
    await repo.upsert(d.project.id, "identityRefs", {
      id: randomUUID(),
      characterId: y.id,
      slot: "additional",
      assetId: yCanon.id,
      label: "Yumeko canonical",
      metadata: {},
      locked: false,
    });
    expect(await setCanonicalIdentity(form({ characterId: y.id, assetId: yCanon.id }))).toMatchObject({
      ok: true,
    });
    const yLook = await image("Yumeko Black Satin Formal");
    const look = (await data()).looks.find((l) => l.id === lookId)!;
    await repo.upsert(d.project.id, "looks", {
      ...look,
      referenceAssetIds: [...look.referenceAssetIds, yLook.id],
    });
    // Shot 3A selects the Lobby view "entrance toward elevators"
    expect(
      await selectShotLocationView(form({ shotId: shot.id, locationViewId: out.lobby.toElevators.view.id })),
    ).toMatchObject({ ok: true });
    return { ...out, yumeko: { canonical: yCanon, look: yLook } };
  }

  async function prepare(shot: Shot, modelId: string, key: string) {
    const config = readGenerationConfig(env);
    await repo.upsert(shot.projectId, "shots", {
      ...shot,
      composition: { ...shot.composition, aspectRatio: "16:9" },
      updatedAt: new Date(t - 1000).toISOString(),
    });
    const fresh = await data();
    const args = {
      data: fresh,
      shotId: shot.id,
      registry: createRegistry(env, config),
      provider: "mock",
      modelId,
      purpose: "production_frame" as const,
      userId: null,
      idempotencyKey: key,
      config,
    };
    const first = prepareSubmission({ ...args, acknowledged: [] });
    const ignored = first.evaluation.compatibility?.ignoredFeatures.map((f) => f.id) ?? [];
    const final = prepareSubmission({ ...args, acknowledged: ignored });
    expect(final.input, final.evaluation.gate.blockers.map((b) => b.message).join(" ")).not.toBeNull();
    return final;
  }

  it("all five Locations have a canonical appearance, their recurring views and establishing references", async () => {
    const f = await ojousama();
    const d = await data();
    const ready = (name: string) => locationBibleReadiness(d, d.locations.find((l) => l.name === name)!.id);
    expect(ready("Grand Celeste Hotel Canopy")).toMatchObject({ canonicalAssetId: f.exterior.canonical.id });
    expect(
      ready("Grand Celeste Lobby")
        .views.map((v) => v.view.name)
        .sort(),
    ).toEqual(["Lobby — elevators toward entrance", "Lobby — entrance toward elevators"]);
    const lobbyItems = Object.fromEntries(ready("Grand Celeste Lobby").items.map((i) => [i.key, i.done]));
    expect(lobbyItems).toEqual({
      canonical: true,
      establishing: true,
      view: true,
      reverse: true,
      variant: true,
      plate: false, // guidance, not a gate
    });
    expect(ready("Sky-View Restaurant").views).toHaveLength(2);
    expect(
      ready("Hotel Hallway")
        .views.map((v) => v.view.kind)
        .sort(),
    ).toEqual(["reverse", "zone"]);
    expect(ready("Tokyo Night Streets").items.find((i) => i.key === "establishing")!.done).toBe(true);
    expect(ready("Tokyo Night Streets").items.find((i) => i.key === "view")!.suggestion).toMatch(
      /camera view/,
    );
  });

  it("Shot 3A: Yumeko canonical → her Look → the selected Lobby view → Lobby canonical → establishing → the night variant", async () => {
    const f = await ojousama();
    const d = await data();
    const shot = d.shots.find((s) => s.shotCode === "3A")!;
    const pkg = assembleGenerationPackage(buildShotContext(d, shot.id));
    const candidates = deriveProductionFrameReferenceCandidates(pkg);
    expect(candidates.map((c) => [c.assetId, c.role])).toEqual([
      [f.yumeko.canonical.id, "identity"],
      [f.yumeko.look.id, "character_look"],
      [f.lobby.toElevators.asset.id, "location_view"],
      [f.lobby.canonical.id, "location"],
      [f.lobby.establishing.id, "location"],
      [f.lobby.night.id, "location"], // 3A is at night: the night variant is relevant
      [f.lobby.toEntrance.asset.id, "location"], // the other view's image stays a generic Lobby reference
    ]);
    // the golden-hour variant is not relevant to a night Shot: it is never sent
    expect(candidates.some((c) => c.assetId === f.lobby.goldenHour.id)).toBe(false);
    // no other Location's images leak in
    for (const other of [
      f.exterior.canonical,
      f.restaurant.canonical,
      f.hallway.canonical,
      f.street.canonical,
    ])
      expect(candidates.some((c) => c.assetId === other.id)).toBe(false);
  });

  it("the request records exactly what was sent, in that order, within the model's limit", async () => {
    const f = await ojousama();
    const shot = await shot3A();
    const full = await prepare(shot, "mock-image-1", "i5-shot-full");
    const sent = (full.input!.attempt.request as { references: Array<{ assetId: string; label: string }> })
      .references;
    expect(sent.map((r) => r.assetId)).toEqual([
      f.yumeko.canonical.id,
      f.yumeko.look.id,
      f.lobby.toElevators.asset.id,
      f.lobby.canonical.id,
      f.lobby.establishing.id,
      f.lobby.night.id,
      f.lobby.toEntrance.asset.id,
    ]);
    expect(sent[2]!.label).toContain("Lobby — entrance toward elevators");
    expect(sent[3]!.label).toBe("Grand Celeste Lobby canonical location");
    expect(full.input!.attempt.inputAssetIds).toEqual(expect.arrayContaining(sent.map((r) => r.assetId)));
  });

  it("model limits: Visual Bible images are left out first and disclosed; nothing else is ever dropped silently", async () => {
    const f = await ojousama();
    const d = await data();
    const shot = d.shots.find((s) => s.shotCode === "3A")!;
    const pkg = assembleGenerationPackage(buildShotContext(d, shot.id));
    const base = createRegistry(env, readGenerationConfig(env)).model("mock", "mock-image-1")!;
    const limited = (max: number) => ({
      ...base,
      capabilities: {
        ...base.capabilities,
        references: { ...base.capabilities.references, maxReferences: max },
      },
    });
    // 5: the two lowest-priority Visual Bible images (night variant, establishing) are left out and named
    const five = evaluateCompatibility(pkg, limited(5), { purpose: "production_frame" });
    expect(five.errors.map((e) => e.id)).not.toContain("references.too_many");
    expect(five.used.references.map((r) => r.assetId)).toEqual([
      f.yumeko.canonical.id,
      f.yumeko.look.id,
      f.lobby.toElevators.asset.id,
      f.lobby.canonical.id,
      f.lobby.toEntrance.asset.id,
    ]);
    const disclosed = five.ignoredFeatures.find((x) => x.id === "references.location_visual_bible_limit")!;
    expect(disclosed.label).toBe("2 Location Visual Bible references");
    expect(disclosed.impact).toContain("lobby wide");
    expect(disclosed.impact).toContain("night");
    // 2: even without every Visual Bible image the Shot needs 4; the existing hard limit refuses (nothing is sent)
    const two = evaluateCompatibility(pkg, limited(2), { purpose: "production_frame" });
    expect(two.errors.map((e) => e.id)).toContain("references.too_many");
    const lite = prepareSubmission({
      data: await data(),
      shotId: shot.id,
      registry: createRegistry(env, readGenerationConfig(env)),
      provider: "mock",
      modelId: "mock-image-lite",
      acknowledged: [],
      purpose: "production_frame",
      userId: null,
      idempotencyKey: "i5-lite",
      config: readGenerationConfig(env),
    });
    expect(lite.input).toBeNull();
  });

  it("without a selected view the canonical Location leads the Location references; manual Shot references still follow", async () => {
    const f = await ojousama();
    const d = await data();
    const shot = d.shots.find((s) => s.shotCode === "3A")!;
    await repo.locationViews.clearForShot({
      projectId: d.project.id,
      shotId: shot.id,
      expectedSelectedViewId: f.lobby.toElevators.view.id,
    });
    const manual = await image("3A manual reference");
    await repo.upsert(d.project.id, "shots", {
      ...shot,
      generation: { ...shot.generation, referenceAssetIds: [manual.id] },
    });
    const fresh = await data();
    const ids = deriveProductionFrameReferenceCandidates(
      assembleGenerationPackage(buildShotContext(fresh, shot.id)),
    ).map((c) => c.assetId);
    expect(ids.slice(0, 3)).toEqual([f.yumeko.canonical.id, f.yumeko.look.id, f.lobby.canonical.id]);
    expect(ids.at(-1)).toBe(manual.id);
  });

  it("freshness: a new canonical Location stales 3A; an irrelevant variant or another Location does not", async () => {
    const f = await ojousama();
    const fp = async (code: string) => {
      const d = await data();
      return approvalSnapshot(buildShotContext(d, d.shots.find((s) => s.shotCode === code)!.id)).fingerprint;
    };
    const lobbyId = (await shot3A()).spatial.locationId;
    const otherCode = (await data()).shots.find(
      (s) => s.spatial.locationId && s.spatial.locationId !== lobbyId,
    )?.shotCode;
    // a generated Lobby image (never a reference), designated as a variant that 3A (night) does not use
    await setLocked("Grand Celeste Lobby", false);
    const lobbyLoc = await locByName("Grand Celeste Lobby");
    await startSubjectImage(
      form({
        subjectKind: "location",
        subjectId: lobbyLoc.id,
        intent: "background",
        model: "mock/mock-image-1",
      }),
    );
    await work();
    const gen = (
      await repo.generation.listSubjectImageAttempts({ kind: "location", locationId: lobbyLoc.id })
    )[0]!;
    await setLocked("Grand Celeste Lobby", true);
    const before3A = await fp("3A");
    const beforeOther = otherCode ? await fp(otherCode) : null;
    await setLocked("Grand Celeste Lobby", false);
    expect(
      await addLocationDesignation(
        form({
          locationId: lobbyLoc.id,
          attemptId: gen.attempt.id,
          role: "variant",
          label: "crowded daytime",
        }),
      ),
    ).toMatchObject({ ok: true });
    await setLocked("Grand Celeste Lobby", true);
    expect(await fp("3A")).toBe(before3A);
    await setLocked("Grand Celeste Lobby", false);
    const lobby = await locByName("Grand Celeste Lobby");
    const next = await image("Lobby canonical v2", { locationName: "Grand Celeste Lobby" });
    await setCanonicalLocation(form({ locationId: lobby.id, assetId: next.id, confirmReplace: "1" }));
    await setLocked("Grand Celeste Lobby", true);
    expect(await fp("3A")).not.toBe(before3A);
    if (otherCode) expect(await fp(otherCode)).toBe(beforeOther);
    expect(f.lobby.canonical.id).not.toBe(next.id);
  });

  it("frozen references: a recorded request never changes after the Visual Bible changes", async () => {
    const f = await ojousama();
    const prepared = await prepare(await shot3A(), "mock-image-1", "i5-frozen");
    const accepted = await repo.generation.createAttemptWithJob(prepared.input!);
    const frozen = structuredClone(
      (await repo.generation.getAttemptView(accepted.attempt.id))!.attempt.request,
    );
    await setLocked("Grand Celeste Lobby", false);
    const lobby = await locByName("Grand Celeste Lobby");
    const next = await image("Lobby canonical v3", { locationName: "Grand Celeste Lobby" });
    await setCanonicalLocation(form({ locationId: lobby.id, assetId: next.id, confirmReplace: "1" }));
    await clearLocationDesignation(
      form({ locationId: lobby.id, role: "variant", assetId: f.lobby.night.id }),
    );
    expect((await repo.generation.getAttemptView(accepted.attempt.id))!.attempt.request).toEqual(frozen);
    expect(JSON.stringify(frozen)).toContain(f.lobby.canonical.id);
    expect(JSON.stringify(frozen)).not.toContain(next.id);
  });
});

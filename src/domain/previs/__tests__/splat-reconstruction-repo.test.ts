import { describe, expect, it } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { PrevisError } from "@/data/previs-repository";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { assetSchema } from "@/domain/schemas";
import { assetTokenFor, buildPrevisDocument } from "../document";
import { buildHotelCanopyEngineScene } from "../hotel-canopy";
import {
  manualCalibration,
  reconstructionFingerprintOf,
  SPLAT_USER_DATA,
  UNKNOWN_CALIBRATION,
  type SplatCalibration,
} from "../splat";

const NOW = new Date("2026-10-18T00:00:00Z");
const iso = NOW.toISOString();
const SPLAT_UUID = "00000000-0000-4000-8000-0000000051a7";
const SPLAT_ASSET = "11111111-1111-4111-8111-111111111111";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

async function setup() {
  const repo = new MemoryRepository();
  const data = (await repo.loadProject("ojousama"))!;
  const shot = data.shots.find((s) => s.shotCode === "3A")!;
  const location = data.locations.find((l) => l.id === shot.spatial.locationId) ?? data.locations[0]!;
  const project = data.project;
  const splatAsset = assetSchema.parse({
    id: SPLAT_ASSET,
    projectId: project.id,
    createdBy: null,
    type: "3d",
    purpose: "spatial_reconstruction",
    source: "import",
    name: "Hotel Canopy reconstruction",
    originalFilename: "hotel-canopy.splat",
    storageProvider: "local",
    bucket: null,
    objectPath: `${project.id}/${SPLAT_ASSET}/hotel-canopy.splat`,
    mime: "application/x-gaussian-splat",
    byteSize: 18432,
    checksum: "sha-splat-a",
    width: null,
    height: null,
    durationMs: null,
    frameRate: null,
    sampleRate: null,
    channels: null,
    tags: ["gaussian_splat", "splat"],
    notes: "",
    metadata: {},
    createdAt: iso,
    updatedAt: iso,
  });
  await repo.upsert(project.id, "assets", splatAsset);
  const refImage = data.assets.find((a) => a.type === "image") ?? null;
  const record = await repo.previs.recordReconstruction({
    id: "recon-1",
    projectId: project.id,
    locationId: location.id,
    method: "imported",
    resultKind: "gaussian_splat",
    resultAssetId: SPLAT_ASSET,
    resultChecksum: "sha-splat-a",
    resultFormat: "splat",
    gaussianCount: 576,
    sources: refImage ? [{ assetId: refImage.id, checksum: refImage.checksum ?? null }] : [],
    calibration: { ...UNKNOWN_CALIBRATION },
    userId: null,
    now: iso,
  });
  return { repo, data, shot, location, project, record, refImage };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

function sceneWith(opts: {
  position?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
  visible?: boolean;
  calibration?: SplatCalibration;
}) {
  const s = buildHotelCanopyEngineScene();
  s.scene.push({
    ...clone(s.scene[1]),
    object_uuid: SPLAT_UUID,
    object_name: "Hotel Canopy reconstruction",
    media_file_token: assetTokenFor(SPLAT_ASSET),
    position: opts.position ?? { x: 0, y: 0, z: 0 },
    scale: opts.scale ?? { x: 1, y: 1, z: 1 },
    visible: opts.visible ?? true,
    user_data: {
      [SPLAT_USER_DATA.reconstructionId]: "recon-1",
      [SPLAT_USER_DATA.calibration]: opts.calibration ?? { ...UNKNOWN_CALIBRATION },
    },
  });
  return buildPrevisDocument({ engineScene: s, assetChecksums: { [SPLAT_ASSET]: "sha-splat-a" } });
}

async function saveSet(ctx: Ctx, document: ReturnType<typeof sceneWith>, expectedRevision: number | null) {
  return ctx.repo.previs.saveScene({
    id: "scene-1",
    projectId: ctx.project.id,
    locationId: ctx.location.id,
    document,
    expectedRevision,
    engineVersion: "t",
    userId: null,
    now: iso,
  });
}

async function link(ctx: Ctx, scene: Awaited<ReturnType<typeof saveSet>>) {
  await ctx.repo.previs.setBookmark({
    id: "bm-1",
    projectId: ctx.project.id,
    shotId: ctx.shot.id,
    locationId: ctx.location.id,
    sceneDocumentId: scene.id,
    userId: null,
    now: iso,
  });
}

const compile = async (ctx: Ctx) => {
  const data = (await ctx.repo.loadProject("ojousama"))!;
  const refs = await ctx.repo.previs.listSpatialReferences(data.project.id);
  return assembleGenerationPackage(buildShotContext({ ...data, spatialReferences: refs }, ctx.shot.id), NOW);
};

describe("reconstruction records", () => {
  it("are immutable provenance with a content fingerprint computed by the repository", async () => {
    const ctx = await setup();
    expect(ctx.record).toMatchObject({
      id: "recon-1",
      schemaVersion: "prism.spatial-reconstruction.v1",
      method: "imported",
      resultKind: "gaussian_splat",
      resultAssetId: SPLAT_ASSET,
      calibration: { units: "unknown", scaleMethod: "unknown" },
    });
    expect(ctx.record.fingerprint).toBe(
      reconstructionFingerprintOf({
        locationId: ctx.location.id,
        method: "imported",
        resultKind: "gaussian_splat",
        resultAssetId: SPLAT_ASSET,
        resultChecksum: "sha-splat-a",
        sources: ctx.record.sources,
        calibration: ctx.record.calibration,
      }),
    );
    expect((await ctx.repo.previs.getReconstruction("recon-1"))?.fingerprint).toBe(ctx.record.fingerprint);
    expect((await ctx.repo.previs.listReconstructions(ctx.location.id)).map((r) => r.id)).toEqual([
      "recon-1",
    ]);
    expect(await ctx.repo.previs.listReconstructions("another-location")).toEqual([]);
  });

  it("pin their result Asset and every source image against deletion", async () => {
    const ctx = await setup();
    expect(await ctx.repo.previs.reconstructionUsesAsset(SPLAT_ASSET)).toBe(true);
    if (ctx.refImage) expect(await ctx.repo.previs.reconstructionUsesAsset(ctx.refImage.id)).toBe(true);
    expect(await ctx.repo.previs.reconstructionUsesAsset("unrelated-asset")).toBe(false);
  });

  it("refuse an identical reconstruction twice, and a location outside the project", async () => {
    const ctx = await setup();
    await expect(
      ctx.repo.previs.recordReconstruction({
        id: "recon-dup",
        projectId: ctx.project.id,
        locationId: ctx.location.id,
        method: "imported",
        resultKind: "gaussian_splat",
        resultAssetId: SPLAT_ASSET,
        resultChecksum: "sha-splat-a",
        resultFormat: "splat",
        gaussianCount: 576,
        sources: ctx.record.sources,
        calibration: { ...UNKNOWN_CALIBRATION },
        userId: null,
        now: iso,
      }),
    ).rejects.toBeInstanceOf(PrevisError);
    await expect(
      ctx.repo.previs.recordReconstruction({
        id: "recon-x",
        projectId: ctx.project.id,
        locationId: "not-a-location-of-this-project",
        method: "imported",
        resultKind: "gaussian_splat",
        resultAssetId: SPLAT_ASSET,
        resultChecksum: "sha-splat-a",
        resultFormat: "splat",
        gaussianCount: 1,
        sources: [],
        calibration: { ...UNKNOWN_CALIBRATION },
        userId: null,
        now: iso,
      }),
    ).rejects.toBeInstanceOf(PrevisError);
  });

  it("do not change when the splat is later moved: origin truth is separate from placement", async () => {
    const ctx = await setup();
    const a = await saveSet(ctx, sceneWith({}), null);
    await saveSet(
      ctx,
      sceneWith({ position: { x: 4, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } }),
      a.revision,
    );
    expect((await ctx.repo.previs.getReconstruction("recon-1"))?.fingerprint).toBe(ctx.record.fingerprint);
  });
});

describe("GenerationPackage: spatial environment", () => {
  it("a Shot whose Set has no splat has NO spatialEnvironment key (historical packages are unchanged)", async () => {
    const ctx = await setup();
    const scene = await saveSet(
      ctx,
      buildPrevisDocument({ engineScene: buildHotelCanopyEngineScene() }),
      null,
    );
    await link(ctx, scene);
    const pkg = await compile(ctx);
    expect(pkg.spatialReference).toBeDefined();
    expect("spatialEnvironment" in pkg.spatialReference!).toBe(false);
    expect(JSON.stringify(pkg)).not.toContain("spatialEnvironment");
  });

  it("freezes the reconstruction identity, asset binding, transform and calibration BY VALUE", async () => {
    const ctx = await setup();
    const scene = await saveSet(
      ctx,
      sceneWith({ position: { x: 1, y: 0.5, z: -2 }, calibration: manualCalibration(0.5) }),
      null,
    );
    await link(ctx, scene);
    const env = (await compile(ctx)).spatialReference!.spatialEnvironment!;
    expect(env).toMatchObject({
      kind: "gaussian_splat",
      sceneObjectId: SPLAT_UUID,
      reconstructionId: "recon-1",
      reconstructionFingerprint: ctx.record.fingerprint,
      assetId: SPLAT_ASSET,
      assetChecksum: "sha-splat-a",
      format: "splat",
      gaussianCount: 576,
      visible: true,
      transform: { position: { x: 1, y: 0.5, z: -2 }, scale: { x: 1, y: 1, z: 1 } },
      calibration: { units: "metres", metresPerSourceUnit: 0.5, scaleMethod: "manual" },
    });
    expect(env.sourceReferenceAssetIds).toEqual(ctx.record.sources.map((s) => s.assetId));
    const pkg = await compile(ctx);
    // the splat Asset is described by value; there are no URLs and no bytes anywhere
    expect(pkg.assets[SPLAT_ASSET]).toMatchObject({
      mime: "application/x-gaussian-splat",
      checksum: "sha-splat-a",
    });
    expect(JSON.stringify(pkg.spatialReference)).not.toMatch(/https?:|blob:|token=|signature/i);
  });

  it("does NOT inject reconstruction sources or splat vocabulary into the shot's references or prompt", async () => {
    const ctx = await setup();
    const before = await compile(ctx);
    const scene = await saveSet(ctx, sceneWith({}), null);
    await link(ctx, scene);
    const after = await compile(ctx);
    expect(after.references).toEqual(before.references);
    expect(after.prompt).toEqual(before.prompt);
    expect(JSON.stringify(after.prompt)).not.toMatch(/splat|gaussian|reconstruction/i);
    if (ctx.refImage) expect(after.references.referenceAssetIds).not.toContain(ctx.refImage.id);
  });

  it("history: package A is unchanged after the splat is moved and the Set re-saved; package B differs", async () => {
    const ctx = await setup();
    const s1 = await saveSet(ctx, sceneWith({}), null);
    await link(ctx, s1);
    const a = await compile(ctx);
    const aJson = JSON.stringify(a);

    const s2 = await saveSet(
      ctx,
      sceneWith({ position: { x: 3, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } }),
      s1.revision,
    );
    expect(s2.sceneFingerprint).not.toBe(s1.sceneFingerprint);
    const b = await compile(ctx);

    expect(JSON.stringify(a)).toBe(aJson); // A is a value, not a view
    expect(b.provenance.fingerprint).not.toBe(a.provenance.fingerprint);
    expect(b.spatialReference!.sceneFingerprint).not.toBe(a.spatialReference!.sceneFingerprint);
    expect(b.spatialReference!.spatialEnvironment!.transform.position.x).toBe(3);
    expect(a.spatialReference!.spatialEnvironment!.transform.position.x).toBe(0);
    // the reconstruction (origin truth) is identical in both
    expect(b.spatialReference!.spatialEnvironment!.reconstructionFingerprint).toBe(
      a.spatialReference!.spatialEnvironment!.reconstructionFingerprint,
    );
  });

  it("a hidden splat stays in the scene fingerprint and is frozen as hidden", async () => {
    const ctx = await setup();
    const s1 = await saveSet(ctx, sceneWith({}), null);
    const s2 = await saveSet(ctx, sceneWith({ visible: false }), s1.revision);
    expect(s2.sceneFingerprint).not.toBe(s1.sceneFingerprint);
    await link(ctx, s2);
    expect((await compile(ctx)).spatialReference!.spatialEnvironment!.visible).toBe(false);
  });
});

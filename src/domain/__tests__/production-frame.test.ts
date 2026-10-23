import { describe, expect, it } from "vitest";
import { buildShotContext } from "@/domain/context";
import { findAssetUsage } from "@/domain/asset-usage";
import { fingerprint } from "@/domain/hash";
import {
  assembleGenerationPackage,
  PACKAGE_SCHEMA_VERSION,
  renderGenerationBrief,
  briefToText,
} from "@/domain/generation-package";
import { evaluateCompatibility } from "@/domain/generation/compatibility";
import { runPreflight } from "@/domain/preflight";
import {
  buildProductionFrameIntent,
  checkProductionImage,
  draftProductionFrame,
  PRODUCTION_FRAME_INTENT_SCHEMA,
  PRODUCTION_FRAME_SCHEMA,
  productionFrameFreshness,
  productionFrameSchema,
  selectedProductionFrameFreshness,
  shotProductionAspect,
  type ProductionFrame,
} from "@/domain/production-frame";
import { MockProvider } from "@/generation/providers/mock";
import { seed, shotByCode } from "./helpers";
import {
  attach,
  checksumOf,
  contextOf,
  draftFor,
  newUploadAsset,
  seedWithFrame,
  storeImage,
  T,
} from "./production-frame-fixtures";

const NOW = new Date("2026-10-21T00:00:00Z");
const pkgOf = (data: ReturnType<typeof seed>, code = "3A") =>
  assembleGenerationPackage(contextOf(data, code), NOW);

describe("production aspect and the image rules", () => {
  it("is the Shot's own ratio, else the Bible's (never hardcoded); unparseable → none", () => {
    const data = seed();
    const shot = shotByCode(data, "3A");
    expect(shotProductionAspect(shot, data.bible)?.raw).toBe("2.39:1");
    const other = { ...shot, composition: { ...shot.composition, aspectRatio: "16:9" } };
    expect(shotProductionAspect(other, data.bible)?.raw).toBe("16:9");
    const blank = { ...shot, composition: { ...shot.composition, aspectRatio: "" } };
    expect(shotProductionAspect(blank, { aspectRatio: "1.85:1" })?.raw).toBe("1.85:1");
    expect(shotProductionAspect(blank, { aspectRatio: "wide" })).toBeNull();
  });

  const aspect = () => {
    const d = seed();
    return shotProductionAspect(shotByCode(d, "3A"), d.bible);
  };
  const img = (o: Partial<ReturnType<typeof newUploadAsset>> = {}) => ({ ...newUploadAsset("p"), ...o });

  it("accepts any size at the production aspect (1912×800 is only the 3D master size)", () => {
    for (const [w, h] of [
      [1912, 800],
      [2388, 1000],
      [1280, 536],
      [956, 400],
      [4780, 2000],
    ])
      expect(checkProductionImage(img({ width: w, height: h }), aspect()).ok, `${w}×${h}`).toBe(true);
  });

  it("refuses a wrongly shaped image and never crops it", () => {
    const r = checkProductionImage(img({ width: 1920, height: 1080 }), aspect());
    expect(r).toMatchObject({ ok: false, problem: { code: "wrong_aspect" } });
    if (!r.ok) {
      expect(r.problem.message).toMatch(/1920×1080 \(16:9\)/);
      expect(r.problem.message).toMatch(/2\.39:1/);
      expect(r.problem.message).toMatch(/does not crop/);
    }
    expect(checkProductionImage(img({ width: 1000, height: 1000 }), aspect())).toMatchObject({ ok: false });
  });

  it("refuses non-images, unsupported types, unstored files, missing facts and tiny images", () => {
    const code = (o: object) => {
      const r = checkProductionImage(img(o), aspect());
      return r.ok ? "ok" : r.problem.code;
    };
    expect(code({ type: "audio" })).toBe("not_image");
    expect(code({ mime: "image/gif" })).toBe("unsupported_type");
    expect(code({ mime: "image/avif" })).toBe("unsupported_type");
    expect(code({ mime: null })).toBe("unsupported_type");
    expect(code({ objectPath: null })).toBe("not_stored");
    expect(code({ width: null })).toBe("no_dimensions");
    expect(code({ checksum: null })).toBe("no_checksum");
    expect(code({ checksum: "short" })).toBe("no_checksum");
    expect(code({ width: 60, height: 25 })).toBe("too_small");
    expect(checkProductionImage(img(), null)).toMatchObject({
      ok: false,
      problem: { code: "no_production_aspect" },
    });
  });
});

describe("draftProductionFrame", () => {
  it("builds an immutable record: frozen intent by value, parts, deterministic fingerprints, no timestamps in identity", () => {
    const data = seed();
    const asset = newUploadAsset(data.project.id);
    data.assets.push(asset);
    const ctx = contextOf(data, "3A");
    const a = draftProductionFrame(ctx, { id: "f1", now: T, userId: null, source: "upload", asset });
    const b = draftProductionFrame(ctx, {
      id: "f2",
      now: "2030-01-01T00:00:00.000Z",
      userId: "u",
      source: "upload",
      asset,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.draft).toMatchObject({
      schemaVersion: PRODUCTION_FRAME_SCHEMA,
      shotId: ctx.shot.id,
      projectId: data.project.id,
      assetId: asset.id,
      assetChecksum: asset.checksum,
      width: 1912,
      height: 800,
      productionAspectRatio: "2.39:1",
      source: "upload",
      sourceStoryboardFrameId: null,
      sourceMasterFrameId: null,
      sourceGenerationAttemptId: null,
    });
    // identity is the artifact, not the id or the moment
    expect(a.draft.frameFingerprint).toBe(b.draft.frameFingerprint);
    expect(a.draft.intentFingerprint).toBe(b.draft.intentFingerprint);
    expect(a.draft.intentFingerprint).toBe(fingerprint(a.draft.intentSnapshot));
    expect(a.draft.parts).toHaveProperty("looks");
    expect(a.draft.parts).toHaveProperty("camera");
    expect(productionFrameSchema.safeParse({ ...a.draft, version: 1 }).success).toBe(true);
  });

  it("the frozen intent names what the frame represents (Shot, framing, Looks, location, lighting, blocking, performance, timing, continuity, constraints)", () => {
    const data = seed();
    const ctx = contextOf(data, "3A");
    const s = buildProductionFrameIntent(ctx);
    expect(s.schema).toBe(PRODUCTION_FRAME_INTENT_SCHEMA);
    expect(s.shot).toMatchObject({ id: ctx.shot.id, code: "3A", title: ctx.shot.title });
    expect(s.framing.aspectRatio).toBe("2.39:1");
    expect(s.characters.length).toBeGreaterThan(0);
    const c = s.characters[0]!;
    expect(c).toMatchObject({
      lookId: ctx.characters[0]!.look!.id,
      wardrobe: ctx.characters[0]!.look!.wardrobe,
    });
    expect(c.identityReferenceAssetIds.length).toBeGreaterThan(0);
    expect(s.location).toMatchObject({ id: ctx.location!.id, name: ctx.location!.name });
    expect(s.lighting).toHaveProperty("mood");
    expect(s.blocking).toHaveProperty("subjectBlocking");
    expect(s.performance.length).toBe(ctx.lines.length);
    expect(s.timing.durationMs).toBe(ctx.duration.durationMs);
    expect(s.continuity).toHaveProperty("weather");
    expect(s.constraints.guardrails).toEqual(data.bible.guardrails);
    // by value: later edits to the live Look do not reach the snapshot
    const before = JSON.stringify(s);
    ctx.characters[0]!.look!.wardrobe = "changed afterwards";
    expect(JSON.stringify(s)).toBe(before);
    // never a whole GenerationPackage, a path or a URL
    expect(before).not.toMatch(/objectPath|provenance|packageSchemaVersion|https?:\/\//);
  });

  it("3D facts are frozen ONLY when the Shot has a 3D set; without one the snapshot has no spatial key at all", () => {
    const data = seed();
    expect(buildProductionFrameIntent(contextOf(data, "3A"))).not.toHaveProperty("spatial");
    const ctx = contextOf(data, "3A");
    ctx.spatial = {
      sceneFingerprint: "s".repeat(64),
      cameraBookmark: { id: "bm", label: "Wide", sceneRevision: 1, sceneFingerprint: "s".repeat(64) },
      masterFrameAssetId: "mf-asset",
    } as never;
    expect(buildProductionFrameIntent(ctx).spatial).toMatchObject({
      sceneFingerprint: "s".repeat(64),
      cameraBookmarkLabel: "Wide",
      masterFrameAssetId: "mf-asset",
    });
  });

  it("refuses a cross-project image, an inconsistent origin, and a wrongly shaped image", () => {
    const data = seed();
    const ctx = contextOf(data, "3A");
    const foreign = newUploadAsset("another-project");
    const base = { id: "f", now: T, userId: null, source: "upload" as const };
    expect(draftProductionFrame(ctx, { ...base, asset: foreign })).toMatchObject({
      ok: false,
      problem: { code: "wrong_project" },
    });
    const mine = newUploadAsset(data.project.id);
    // an upload carries no source id; a storyboard origin needs exactly its own
    expect(draftProductionFrame(ctx, { ...base, asset: mine, sourceMasterFrameId: "x" })).toMatchObject({
      ok: false,
      problem: { code: "bad_source" },
    });
    expect(draftProductionFrame(ctx, { ...base, source: "storyboard", asset: mine })).toMatchObject({
      ok: false,
      problem: { code: "bad_source" },
    });
    expect(
      draftProductionFrame(ctx, {
        ...base,
        asset: newUploadAsset(data.project.id, { width: 1920, height: 1080 }),
      }),
    ).toMatchObject({ ok: false, problem: { code: "wrong_aspect" } });
  });

  it("each origin carries exactly its own source id (upload, storyboard, previs_master, generation_output)", () => {
    const data = seed();
    const asset = newUploadAsset(data.project.id);
    for (const source of ["upload", "storyboard", "previs_master", "generation_output"] as const) {
      const d = draftFor(data, "3A", { asset, source });
      expect(
        [d.sourceStoryboardFrameId, d.sourceMasterFrameId, d.sourceGenerationAttemptId].filter(Boolean),
      ).toHaveLength(source === "upload" ? 0 : 1);
    }
    // the same image with a different origin is a different artifact
    const fps = ["upload", "storyboard", "previs_master"].map(
      (source) => draftFor(data, "3A", { asset, source: source as never }).frameFingerprint,
    );
    expect(new Set(fps).size).toBe(3);
  });
});

describe("ShotContext resolution (no 3D, no previs repository)", () => {
  it("lists the Shot's frames newest first and resolves its ONE selection; other Shots' frames are ignored", () => {
    const { data, asset } = seedWithFrame("3A");
    const v2: ProductionFrame = {
      ...draftFor(data, "3A", { asset: { ...asset, id: asset.id }, source: "storyboard" }),
      version: 2,
    };
    const other = { ...draftFor(data, "4C", { asset }), version: 1 };
    attach(data, [data.productionFrames![0]!, v2, other], v2);
    const ctx = contextOf(data, "3A");
    expect(ctx.productionFrames.map((f) => f.version)).toEqual([2, 1]);
    expect(ctx.selectedProductionFrame?.id).toBe(v2.id);
    expect(contextOf(data, "4C").selectedProductionFrame).toBeNull();
    // a project with none at all
    expect(contextOf(seed(), "3A")).toMatchObject({ productionFrames: [], selectedProductionFrame: null });
    expect(contextOf(seed(), "3A").spatial).toBeUndefined();
  });
});

describe("freshness", () => {
  const stale = (mutate: (d: ReturnType<typeof seed>) => void) => {
    const { data, frame } = seedWithFrame("3A");
    expect(selectedProductionFrameFreshness(contextOf(data, "3A"))).toMatchObject({
      status: "fresh",
      changedParts: [],
    });
    const before = structuredClone(data.productionFrames);
    mutate(data);
    const f = selectedProductionFrameFreshness(contextOf(data, "3A"));
    // history is never rewritten by a change to the Shot
    expect(data.productionFrames).toEqual(before);
    expect(frame.parts).toEqual(before![0]!.parts);
    return f;
  };

  it("no frame → missing", () => {
    expect(selectedProductionFrameFreshness(contextOf(seed(), "3A")).status).toBe("missing");
    expect(productionFrameFreshness(contextOf(seed(), "3A"), null).changedParts).toEqual([]);
  });

  it.each([
    [
      "Character Look",
      "looks",
      (d: ReturnType<typeof seed>) => {
        const id = shotByCode(d, "3A").characters[0]!.lookId!;
        d.looks.find((l) => l.id === id)!.wardrobe = "a completely different gown";
      },
      /Character Look changed after this Production Frame/,
    ],
    [
      "camera",
      "camera",
      (d: ReturnType<typeof seed>) => {
        shotByCode(d, "3A").composition.lens = "135mm";
      },
      /Camera setup changed/,
    ],
    [
      "lighting",
      "lighting",
      (d: ReturnType<typeof seed>) => {
        shotByCode(d, "3A").lighting.mood = "harsh noon";
      },
      /Lighting changed/,
    ],
    [
      "location",
      "location",
      (d: ReturnType<typeof seed>) => {
        const loc = shotByCode(d, "3A").spatial.locationId;
        d.locations.find((l) => l.id === loc)!.geography = "moved wall";
      },
      /Location \/ set changed/,
    ],
    [
      "blocking",
      "blocking",
      (d: ReturnType<typeof seed>) => {
        shotByCode(d, "3A").spatial.subjectBlocking = "she crosses to the window";
      },
      /Blocking changed/,
    ],
    [
      "performance",
      "performance",
      (d: ReturnType<typeof seed>) => {
        const line = shotByCode(d, "3A").audio.dialogueLineIds[0]!;
        d.directions.find((x) => x.dialogueLineId === line)!.emotion = "furious";
      },
      /Selected performance changed/,
    ],
    [
      "continuity",
      "continuity",
      (d: ReturnType<typeof seed>) => {
        shotByCode(d, "3A").continuity.weather = "heavy snow";
      },
      /Continuity changed/,
    ],
  ] as const)("a %s change makes it stale and names the part", (_label, part, mutate, message) => {
    const f = stale(mutate);
    expect(f.status).toBe("stale");
    expect(f.changedParts).toContain(part);
    expect(f.messages.join(" ")).toMatch(message);
  });

  it("story text, constraints and the optional 3D scene do NOT stale the image by themselves", () => {
    for (const mutate of [
      (d: ReturnType<typeof seed>) => (shotByCode(d, "3A").storyBeat = "a rewritten beat"),
      (d: ReturnType<typeof seed>) => shotByCode(d, "3A").constraints.hard.push("no umbrellas"),
    ])
      expect(stale(mutate).status).toBe("fresh");
    const { data } = seedWithFrame("3A");
    const ctx = contextOf(data, "3A");
    ctx.spatial = {
      sceneFingerprint: "x".repeat(64),
      cameraBookmark: null,
      masterFrameAssetId: null,
    } as never;
    expect(selectedProductionFrameFreshness(ctx).status).toBe("fresh");
  });
});

describe("GenerationPackage v3", () => {
  it("a new package is the current version (4); a Shot with no selected frame carries none of the v3-only keys", () => {
    const pkg = pkgOf(seed());
    expect(pkg.version).toBe(PACKAGE_SCHEMA_VERSION);
    expect(pkg.packageSchemaVersion).toBe(5); // Phase 2G.4 bumped the shape to v5; the v3-only keys below are still absent
    expect(pkg.references).not.toHaveProperty("productionFrame");
    expect(pkg.freshness).not.toHaveProperty("productionFrame");
    expect(pkg.provenance.sourceVersions).not.toHaveProperty("productionFrameId");
    expect(pkg.provenance.parts).not.toHaveProperty("productionFrame");
  });

  it("describes the SELECTED frame by value and puts its Asset in package.assets", () => {
    const { data, asset, frame } = seedWithFrame("3A");
    const pkg = pkgOf(data);
    expect(pkg.references.productionFrame).toEqual({
      frameId: frame.id,
      assetId: asset.id,
      version: 1,
      source: "upload",
      intentFingerprint: frame.intentFingerprint,
      freshness: "fresh",
      changedParts: [],
    });
    expect(pkg.freshness.productionFrame).toMatchObject({ status: "fresh" });
    expect(pkg.assets[asset.id]).toMatchObject({
      id: asset.id,
      purpose: "production_frame",
      width: 1912,
      height: 800,
    });
    expect(pkg.provenance.sourceVersions.productionFrameId).toBe(frame.id);
    // a package built with a frame is a v3-shaped package: it hashes differently from the frameless one
    expect(pkg.provenance.fingerprint).not.toBe(pkgOf(seed()).provenance.fingerprint);
  });

  it("start-frame precedence: explicit override > selected Production Frame > approved Storyboard > null", () => {
    const { data, asset } = seedWithFrame("3A");
    const storyboardAsset = contextOf(data, "3A").approvedFrame!.assetId;
    expect(storyboardAsset).toBeTruthy();
    expect(pkgOf(data).references.startFrameAssetId).toBe(asset.id); // the Production Frame beats the Storyboard
    const withOverride = structuredClone(data);
    const override = newUploadAsset(data.project.id, { label: "override" });
    withOverride.assets.push(override);
    shotByCode(withOverride, "3A").generation.startFrameAssetId = override.id;
    expect(pkgOf(withOverride).references.startFrameAssetId).toBe(override.id); // an explicit override wins
    expect(pkgOf(withOverride).references.productionFrame?.assetId).toBe(asset.id); // …but the frame is still recorded
    // the Shot's own field is never written from the selection
    expect(shotByCode(data, "3A").generation.startFrameAssetId).toBeNull();
    // no selection → the approved Storyboard, as before
    attach(data, data.productionFrames!, null);
    expect(pkgOf(data).references.startFrameAssetId).toBe(storyboardAsset);
    // nothing at all → null
    const bare = seed();
    for (const f of bare.frames.filter((f) => f.shotId === shotByCode(bare, "3A").id)) f.approved = false;
    expect(pkgOf(bare).references.startFrameAssetId).toBeNull();
  });

  it("the fingerprint follows the SELECTION: changing it changes the package; adding an unselected frame does not", () => {
    const { data, asset, frame } = seedWithFrame("3A");
    const before = pkgOf(data).provenance.fingerprint;
    // an unselected historical frame (even a newer one) is invisible to the package
    const spare = newUploadAsset(data.project.id, { label: "spare" });
    data.assets.push(spare);
    const v2: ProductionFrame = { ...draftFor(data, "3A", { asset: spare }), version: 2 };
    attach(data, [frame, v2], frame);
    expect(pkgOf(data).provenance.fingerprint).toBe(before);
    // moving the pointer changes what will be generated
    attach(data, [frame, v2], v2);
    const after = pkgOf(data);
    expect(after.provenance.fingerprint).not.toBe(before);
    expect(after.references.productionFrame).toMatchObject({ version: 2, assetId: spare.id });
    expect(after.references.startFrameAssetId).toBe(spare.id);
    // selecting it back restores the original fingerprint exactly
    attach(data, [frame, v2], frame);
    expect(pkgOf(data).provenance.fingerprint).toBe(before);
    void asset;
  });

  it("a stale selected frame is reported in the package, the brief (by name) and nowhere as a path, URL or checksum", () => {
    const { data, asset } = seedWithFrame("3A");
    shotByCode(data, "3A").lighting.mood = "harsh noon";
    const id = shotByCode(data, "3A").characters[0]!.lookId!;
    data.looks.find((l) => l.id === id)!.wardrobe = "a completely different gown";
    const pkg = pkgOf(data);
    expect(pkg.references.productionFrame).toMatchObject({ freshness: "stale" });
    expect(pkg.references.productionFrame!.changedParts.sort()).toEqual(["lighting", "looks"]);
    const text = briefToText(renderGenerationBrief(pkg));
    expect(text).toMatch(/Production Frame: v1 · Uploaded · stale/);
    expect(text).toMatch(/STALE: .*Lighting.*changed after this frame was made/);
    expect(text).toMatch(/STALE: .*Character Look/);
    const section = renderGenerationBrief(pkg).find((s) => s.title === "Production Frame")!;
    const lines = section.lines.join("\n");
    expect(lines).not.toContain(asset.objectPath!);
    expect(lines).not.toContain(asset.checksum!);
    expect(lines).not.toMatch(/https?:|\/api\/assets/);
    // a fresh frame says so
    const fresh = briefToText(renderGenerationBrief(pkgOf(seedWithFrame("3A").data)));
    expect(fresh).toMatch(/Production Frame: v1 · Uploaded · fresh/);
    expect(fresh).not.toMatch(/STALE/);
  });

  it("a historical v2 package stays readable: the v3-only keys are optional and the evaluators accept it", () => {
    const { data } = seedWithFrame("3A", { selected: false });
    const legacy = structuredClone(pkgOf(data));
    legacy.version = 2;
    legacy.packageSchemaVersion = 2;
    delete (legacy.references as { productionFrame?: unknown }).productionFrame;
    delete (legacy.freshness as { productionFrame?: unknown }).productionFrame;
    const model = new MockProvider({ stageDelayMs: 0 })
      .listModels()
      .find((m) => m.modelId === "mock-video-1")!;
    // the same functions that read today's packages read a v2 snapshot, without a rewrite
    expect(evaluateCompatibility(legacy, model).used.startFrameAssetId).toBe(
      legacy.references.startFrameAssetId,
    );
    expect(briefToText(renderGenerationBrief(legacy))).not.toMatch(/Production Frame/);
    expect(JSON.parse(JSON.stringify(legacy)).packageSchemaVersion).toBe(2);
  });
});

describe("NO-3D flow: a project with no spatial data, no GPU and no reconstruction", () => {
  it("approved Storyboard → Production Frame → selected → package v3 → image-to-video sees the start frame", () => {
    const data = seed();
    expect(data.spatialReferences).toBeUndefined();
    const ctx0 = contextOf(data, "3A");
    expect(ctx0.spatial).toBeUndefined();
    const sbFrame = ctx0.approvedFrame!;
    // the seed's storyboard image is a placeholder; give it the stored image a real upload would have
    storeImage(data, sbFrame.assetId!, { label: "storyboard-3A" });
    const draft = draftFor(data, "3A", {
      asset: data.assets.find((a) => a.id === sbFrame.assetId)!,
      source: "storyboard",
      sourceStoryboardFrameId: sbFrame.id,
    });
    // a promotion REUSES the Storyboard's Asset: no copy
    expect(draft.assetId).toBe(sbFrame.assetId);
    const assetsBefore = data.assets.length;
    const frame: ProductionFrame = { ...draft, version: 1 };
    attach(data, [frame], frame);
    expect(data.assets.length).toBe(assetsBefore);
    const pkg = pkgOf(data);
    expect(pkg.version).toBe(5);
    expect(pkg.references.productionFrame).toMatchObject({
      source: "storyboard",
      version: 1,
      freshness: "fresh",
    });
    expect(pkg.references.startFrameAssetId).toBe(sbFrame.assetId);
    expect(pkg).not.toHaveProperty("spatialReference");
    const model = new MockProvider({ stageDelayMs: 0 })
      .listModels()
      .find((m) => m.modelId === "mock-video-1")!;
    const report = evaluateCompatibility(pkg, model);
    expect(report.modality).toBe("image_to_video");
    expect(report.used.startFrameAssetId).toBe(sbFrame.assetId);
    expect(report.errors.map((e) => e.id)).not.toContain("start_frame.missing");
    // no preflight item or brief line asks for a 3D set
    const all = JSON.stringify(runPreflight(contextOfWith(data))) + briefToText(renderGenerationBrief(pkg));
    expect(all).not.toMatch(/3D|spatial|reconstruction|GPU|COLMAP|splat/i);
  });
});

function contextOfWith(data: ReturnType<typeof seed>) {
  return buildShotContext(data, shotByCode(data, "3A").id);
}

describe("preflight", () => {
  const mk = (modality: "image_to_video" | "video", mutate?: (d: ReturnType<typeof seed>) => void) => {
    const { data } = seedWithFrame("3A");
    shotByCode(data, "3A").generation.modality = modality;
    mutate?.(data);
    const report = runPreflight(contextOf3A(data));
    return report.items.find((i) => i.ruleId === "production_frame.fresh")!;
  };
  const contextOf3A = (d: ReturnType<typeof seed>) => buildShotContext(d, shotByCode(d, "3A").id);
  const makeStale = (d: ReturnType<typeof seed>) => (shotByCode(d, "3A").lighting.mood = "harsh noon");

  it("not applicable without a selected frame (existing Shots keep the storyboard path); passes when fresh", () => {
    const item = runPreflight(contextOf3A(seed())).items.find((i) => i.ruleId === "production_frame.fresh")!;
    expect(item.status).toBe("na");
    expect(mk("image_to_video").status).toBe("pass");
  });

  it("a stale selected frame BLOCKS image-to-video with a clear reason, and only warns for other modalities", () => {
    const blocked = mk("image_to_video", makeStale);
    expect(blocked.status).toBe("fail");
    expect(blocked.detail).toMatch(/Lighting changed after this Production Frame/);
    expect(blocked.detail).toMatch(/explicit start frame/);
    expect(mk("video", makeStale).status).toBe("warn");
    const { data } = seedWithFrame("3A");
    shotByCode(data, "3A").generation.modality = "image_to_video";
    makeStale(data);
    expect(runPreflight(contextOf3A(data)).blockers.map((b) => b.ruleId)).toContain("production_frame.fresh");
  });

  it("an explicit start-frame override means the stale selection is not what generates: a warning, not a blocker", () => {
    const item = mk("image_to_video", (d) => {
      makeStale(d);
      const o = newUploadAsset(d.project.id, { label: "override" });
      d.assets.push(o);
      shotByCode(d, "3A").generation.startFrameAssetId = o.id;
    });
    expect(item.status).toBe("warn");
    expect(item.detail).toMatch(/explicit start frame is set/);
  });
});

describe("asset usage", () => {
  it("a Production Frame pins its image (a promoted frame pins the Storyboard's shared Asset)", () => {
    const { data, asset } = seedWithFrame("3A");
    const usage = findAssetUsage(data, asset.id);
    expect(usage.inUse).toBe(true);
    expect(usage.direct.map((u) => u.kind)).toContain("production_frame");
    expect(usage.direct[0]!.label).toMatch(/Shot 3A · Production Frame v1/);
    expect(checksumOf("x")).toHaveLength(64);
  });
});

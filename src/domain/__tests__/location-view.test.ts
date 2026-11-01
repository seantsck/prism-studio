import { describe, expect, it } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { LocationViewError } from "@/data/location-view-repository";
import { buildShotContext } from "@/domain/context";
import { computeShotParts, overallFingerprint, storyboardFreshness } from "@/domain/fingerprint";
import {
  assembleGenerationPackage,
  renderGenerationBrief,
  shotChangedSinceAttempt,
} from "@/domain/generation-package";
import { candidateInputBasis, candidateInputStaleness } from "@/domain/generated-production-frame";
import {
  deriveProductionFrameReferenceCandidates,
  deriveReferenceCandidates,
  evaluateCompatibility,
} from "@/domain/generation/compatibility";
import { buildPromptPlan, renderPromptPlan } from "@/domain/generation/prompt-plan";
import type { GenerationModel } from "@/domain/generation/schemas";
import {
  buildLocationViewSpec,
  checkLocationViewImage,
  draftLocationView,
  LOCATION_VIEW_INTEGRITY_MESSAGE,
  locationViewFingerprint,
  locationViewSchema,
} from "@/domain/location-view";
import { runPreflight } from "@/domain/preflight";
import {
  buildProductionFrameIntent,
  productionFrameFreshness,
  productionFrameToViewStatus,
  type ProductionFrame,
} from "@/domain/production-frame";
import type { ProjectData } from "@/domain/schemas";
import { MockProvider } from "@/generation/providers/mock";
import { runwayImageTags } from "@/generation/providers/runway/image-families";
import { seed, shotByCode } from "./helpers";
import { attachViews, locationByName, locationOf, viewFor } from "./location-view-fixtures";
import { attach, contextOf, draftFor, newUploadAsset, storeImage, T } from "./production-frame-fixtures";

/**
 * Phase 2G.3 Location View continuity: pure domain rules plus the memory repository. Fictional data, in memory: no 3D
 * set, GPU, reconstruction, provider or network anywhere.
 */

const models = new MockProvider().listModels();
const model = (id: string): GenerationModel => models.find((m) => m.modelId === id)!;
/** A still-image model that takes NO reference images (text-to-image only). */
const textOnly = (): GenerationModel => {
  const m = structuredClone(model("mock-image-1"));
  m.modelId = "mock-image-text-only";
  m.capabilities.modalities = ["text_to_image"];
  m.capabilities.references.referenceImages = false;
  m.capabilities.references.maxReferences = 0;
  return m;
};

/** A seed project whose Shot `code` has an uploaded "Doorway" view of its Location (4:3, not the production aspect). */
function seedWithView(code = "2A", o: { select?: boolean } = {}) {
  const data = seed();
  const location = locationOf(data, code);
  const asset = newUploadAsset(data.project.id, { label: "doorway", width: 1024, height: 768 });
  asset.purpose = "location_ref";
  data.assets.push(asset);
  const view = viewFor(data, location.id, asset, {
    name: "Doorway",
    kind: "entrance",
    entranceId: location.entrances[0]?.id ?? null,
    zoneId: location.zones[0]?.id ?? null,
    viewpointDescription: "from the revolving doors toward the red carpet",
    orientation: "south-facing",
  });
  attachViews(data, [view], o.select === false ? [] : [{ shotId: shotByCode(data, code).id, view }]);
  return { data, location, asset, view };
}

const ctxOf = (data: ProjectData, code = "2A") => buildShotContext(data, shotByCode(data, code).id);
const pkgOf = (data: ProjectData, code = "2A") =>
  assembleGenerationPackage(ctxOf(data, code), new Date("2026-10-22T00:00:00Z"));

describe("Location View: an immutable canonical image + viewpoint description", () => {
  it("drafts a view with frozen image facts, a semantic spec and a deterministic fingerprint (no coordinates)", () => {
    const { view, asset, location } = seedWithView();
    expect(locationViewSchema.parse(view)).toEqual(view);
    expect(view).toMatchObject({
      schemaVersion: "prism.location-view.v1",
      locationId: location.id,
      name: "Doorway",
      kind: "entrance",
      assetId: asset.id,
      assetChecksum: asset.checksum,
      width: 1024,
      height: 768,
      source: "upload",
      sourceProductionFrameId: null,
    });
    expect(view.viewSpec.schema).toBe("prism.location-view-spec.v1");
    expect(view.viewSpec.entrance?.name).toBe("Revolving doors"); // copied BY VALUE from the Location
    expect(JSON.stringify(view.viewSpec)).not.toMatch(/"(x|y|z|position3d|matrix|quaternion)"/);
    expect(view.viewFingerprint).toBe(locationViewFingerprint(location.id, asset.checksum!, view.viewSpec));
  });

  it("any image shape is accepted: a reference is never cropped to the production aspect", () => {
    for (const [w, h] of [
      [1024, 768],
      [768, 1365],
      [1920, 1080],
    ])
      expect(checkLocationViewImage({ ...newUploadAsset("p", { width: w, height: h }) }).ok).toBe(true);
    expect(checkLocationViewImage({ ...newUploadAsset("p"), objectPath: null }).ok).toBe(false);
    expect(checkLocationViewImage({ ...newUploadAsset("p"), type: "video" }).ok).toBe(false);
    expect(checkLocationViewImage({ ...newUploadAsset("p", { width: 32, height: 32 }) }).ok).toBe(false);
  });

  it("dedupe key: same Location + image + spec → same fingerprint; a changed spec is a new view; no timestamps", () => {
    const { data, location, asset } = seedWithView();
    const a = viewFor(data, location.id, asset, { name: "Doorway" }, { now: "2026-01-01T00:00:00Z" });
    const b = viewFor(data, location.id, asset, { name: "Doorway" }, { now: "2027-01-01T00:00:00Z" });
    expect(a.viewFingerprint).toBe(b.viewFingerprint);
    const tighter = viewFor(data, location.id, asset, { name: "Doorway — tighter" });
    expect(tighter.viewFingerprint).not.toBe(a.viewFingerprint);
    const other = viewFor(data, locationByName(data, "Grand Celeste Lobby").id, asset, { name: "Doorway" });
    expect(other.viewFingerprint).not.toBe(a.viewFingerprint);
  });

  it("refuses a zone or entrance that is not the Location's own, a foreign image, an inconsistent origin", () => {
    const { data, location, asset } = seedWithView();
    expect(buildLocationViewSpec(location, { name: "x", kind: "zone", zoneId: "nope" }).ok).toBe(false);
    expect(buildLocationViewSpec(location, { name: "", kind: "zone" }).ok).toBe(false);
    expect(buildLocationViewSpec(location, { name: "x", kind: "panorama" }).ok).toBe(false);
    const base = {
      id: "v",
      now: T,
      userId: null,
      projectId: data.project.id,
      location,
      spec: { name: "x", kind: "detail" },
    };
    expect(draftLocationView({ ...base, asset: { ...asset, projectId: "other" }, source: "upload" }).ok).toBe(
      false,
    );
    expect(
      draftLocationView({ ...base, asset, source: "production_frame", sourceProductionFrameId: null }).ok,
    ).toBe(false);
    expect(draftLocationView({ ...base, asset, source: "upload", sourceProductionFrameId: "pf" }).ok).toBe(
      false,
    );
  });
});

describe("ShotContext → GenerationPackage v4 → PromptPlan (no Production Frame required)", () => {
  it("a selected view resolves in ShotContext; only views of the Shot's own Location are listed", () => {
    const { data, view } = seedWithView();
    const lobby = locationByName(data, "Grand Celeste Lobby");
    const lobbyAsset = newUploadAsset(data.project.id, { label: "lobby view" });
    data.assets.push(lobbyAsset);
    const lobbyView = viewFor(data, lobby.id, lobbyAsset, { name: "Concierge desk", kind: "zone" });
    data.locationViews!.push(lobbyView);
    const ctx = ctxOf(data);
    expect(ctx.selectedLocationView?.id).toBe(view.id);
    expect(ctx.locationViews.map((v) => v.id)).toEqual([view.id]);
    expect(ctx.locationViewIssue).toBeNull();
    expect(ctx.selectedProductionFrame).toBeNull();
  });

  it("package v4 carries references.locationView by value and describes its Asset", () => {
    const { data, view, asset } = seedWithView();
    const pkg = pkgOf(data);
    expect(pkg.version).toBe(5);
    expect(pkg.references.locationView).toMatchObject({
      viewId: view.id,
      locationId: view.locationId,
      name: "Doorway",
      kind: "entrance",
      assetId: asset.id,
      assetChecksum: asset.checksum,
      viewFingerprint: view.viewFingerprint,
      viewSpec: view.viewSpec,
    });
    expect(pkg.assets[asset.id]).toMatchObject({ id: asset.id, checksum: asset.checksum, width: 1024 });
    expect(pkg.provenance.sourceVersions.locationViewId).toBe(view.id);
    // a Location View is a reference, never the start frame
    expect(pkg.references.startFrameAssetId).not.toBe(asset.id);
    // no URL, path or 3D data in the reference
    expect(JSON.stringify(pkg.references.locationView)).not.toMatch(
      /https?:|\/api\/|objectPath|splat|colmap/i,
    );
  });

  it("without a selected view a v4 package carries no locationView key and the Shot hashes as before 2G.3", () => {
    const { data } = seedWithView("2A", { select: false });
    const pkg = pkgOf(data);
    expect(pkg.version).toBe(5);
    expect(pkg.references).not.toHaveProperty("locationView");
    expect(pkg.provenance.sourceVersions).not.toHaveProperty("locationViewId");
    // the location part is exactly the pre-2G.3 value (views that exist but are not selected change nothing)
    const bare = seed();
    expect(pkg.provenance.parts.location).toBe(computeShotParts(ctxOf(bare)).location);
    expect(pkg.provenance.parts.overall).toBe(overallFingerprint(computeShotParts(ctxOf(bare))));
  });

  it("the PromptPlan environment states the canonical view in words; the brief names it", () => {
    const { data } = seedWithView();
    const pkg = pkgOf(data);
    const env = buildPromptPlan(pkg).sections.find((s) => s.key === "environment")!;
    expect(env.lines).toEqual(
      expect.arrayContaining([
        'canonical Location View: "Doorway" (entrance)',
        "viewpoint: from the revolving doors toward the red carpet",
        "entrance: Revolving doors",
        "orientation: south-facing",
      ]),
    );
    expect(renderPromptPlan(buildPromptPlan(pkg))).not.toMatch(/pixel|checksum|\/api\//);
    const brief = renderGenerationBrief(pkg).find((s) => s.title === "Location View");
    expect(brief?.lines[0]).toMatch(/^Doorway · Entrance · Uploaded · 1024×768$/);
  });

  it("the Production Frame intent snapshot records the view by identity; older snapshots stay valid", () => {
    const { data, view } = seedWithView();
    const intent = buildProductionFrameIntent(ctxOf(data));
    expect(intent.location?.view).toEqual({
      viewId: view.id,
      name: view.name,
      kind: view.kind,
      assetId: view.assetId,
      viewFingerprint: view.viewFingerprint,
    });
    const without = buildProductionFrameIntent(ctxOf(seedWithView("2A", { select: false }).data));
    expect(without.location).not.toHaveProperty("view");
  });
});

describe("the Shot's selected view is production truth (freshness)", () => {
  it("none → A → B → none each change the location part, stale the Storyboard and the Production Frame, and change the package's semantic identity", () => {
    const { data, location, view: a } = seedWithView("2B", { select: false });
    const bAsset = newUploadAsset(data.project.id, { label: "reverse" });
    data.assets.push(bAsset);
    const b = viewFor(data, location.id, bAsset, { name: "Reverse", kind: "reverse" });
    data.locationViews!.push(b);
    // an approved Storyboard and a selected Production Frame made while NO view was selected
    const shot = shotByCode(data, "2B");
    // what a Storyboard approval stores (its parts), taken while no view was selected
    const sbSnapshot = {
      approvedFingerprint: "x",
      approvedSnapshot: { parts: computeShotParts(ctxOf(data, "2B")), durationMs: 0 },
    };
    const pfAsset = newUploadAsset(data.project.id, { label: "pf-2b" });
    data.assets.push(pfAsset);
    const pf: ProductionFrame = { ...draftFor(data, "2B", { asset: pfAsset }), version: 1 };
    attach(data, [pf], pf);
    const history = JSON.stringify(pf);

    const states: Array<{ label: string; overall: string; location: string }> = [];
    const record = (label: string) => {
      const ctx = ctxOf(data, "2B");
      const pkg = assembleGenerationPackage(ctx);
      states.push({
        label,
        overall: pkg.provenance.parts.overall!,
        location: pkg.provenance.parts.location!,
      });
      return ctx;
    };
    record("none");
    attachViews(data, [a, b], [{ shotId: shot.id, view: a }]);
    let ctx = record("A");
    expect(productionFrameFreshness(ctx, pf)).toMatchObject({ status: "stale", changedParts: ["location"] });
    const sb = storyboardFreshness(ctx, sbSnapshot);
    expect(sb.status).toBe("stale");
    expect(sb.changedParts).toEqual(["location"]);
    attachViews(data, [a, b], [{ shotId: shot.id, view: b }]);
    ctx = record("B");
    expect(productionFrameFreshness(ctx, pf).status).toBe("stale");
    attachViews(data, [a, b], []);
    ctx = record("none again");
    expect(productionFrameFreshness(ctx, pf).status).toBe("fresh"); // back to the exact intent it was made for

    expect(new Set(states.map((s) => s.location)).size).toBe(3);
    expect(new Set(states.map((s) => s.overall)).size).toBe(3);
    expect(states[0]!.overall).toBe(states[3]!.overall);
    // history is never rewritten
    expect(JSON.stringify(pf)).toBe(history);
  });

  it("a Production Frame candidate generated with view A is stale once the Shot chooses view B (input basis)", () => {
    const { data, location, view: a } = seedWithView("2A");
    const bAsset = newUploadAsset(data.project.id, { label: "window side" });
    data.assets.push(bAsset);
    const b = viewFor(data, location.id, bAsset, { name: "Window side", kind: "side" });
    data.locationViews!.push(b);
    const pkg = pkgOf(data);
    const attempt = {
      id: "cand-1",
      request: { purpose: "production_frame", references: [{ role: "location_view", assetId: a.assetId }] },
      packageSnapshot: JSON.parse(JSON.stringify(pkg)),
    };
    // the frozen request records that the view image WAS sent (never inferred from today's selection)
    expect(candidateInputBasis(attempt).locationViewReference).toEqual({ assetId: a.assetId, viewId: a.id });
    expect(candidateInputStaleness(ctxOf(data), attempt)).toBeNull();
    attachViews(data, [a, b], [{ shotId: shotByCode(data, "2A").id, view: b }]);
    expect(candidateInputStaleness(ctxOf(data), attempt)).toEqual({ changed: ["location"], unknown: false });
    // a candidate whose request carried no view says so
    expect(candidateInputBasis({ ...attempt, request: { references: [] } }).locationViewReference).toBeNull();
  });
});

describe("Production Frame → Location View", () => {
  it("only a selected, FRESH frame of a Shot with a Location may be saved as a view", () => {
    const data = seed();
    expect(productionFrameToViewStatus(contextOf(data, "2A"))).toMatchObject({ ok: false });
    const asset = newUploadAsset(data.project.id, { label: "pf-2a" });
    data.assets.push(asset);
    const pf: ProductionFrame = { ...draftFor(data, "2A", { asset }), version: 1 };
    attach(data, [pf], pf);
    expect(productionFrameToViewStatus(contextOf(data, "2A"))).toEqual({ ok: true });
    // the frame becomes stale: it no longer depicts the Shot, so it may not become Location truth
    shotByCode(data, "2A").lighting.mood = "a different mood";
    const stale = productionFrameToViewStatus(contextOf(data, "2A"));
    expect(stale).toMatchObject({ ok: false });
    expect((stale as { reason: string }).reason).toMatch(/stale/);
    // no Location: refused
    shotByCode(data, "2A").spatial.locationId = null;
    expect((productionFrameToViewStatus(contextOf(data, "2A")) as { reason: string }).reason).toMatch(
      /no Location/,
    );
  });
});

describe("references: role, order, dedupe, limits and truthful disclosure", () => {
  /** 2B with stored images for: a selected PF, the approved Storyboard, a generic Location reference and the view. */
  function richShot(o: { viewSameAsPf?: boolean; viewSameAsLocationRef?: boolean } = {}) {
    const data = seed();
    const shot = shotByCode(data, "2B");
    const location = locationOf(data, "2B");
    const sb = data.frames.find((f) => f.shotId === shot.id && f.approved)!;
    storeImage(data, sb.assetId!, { label: "sb-2b" });
    const pfAsset = newUploadAsset(data.project.id, { label: "pf-2b" });
    const locRef = newUploadAsset(data.project.id, { label: "canopy-ref", width: 800, height: 600 });
    data.assets.push(pfAsset, locRef);
    location.referenceAssetIds = [locRef.id];
    const pf: ProductionFrame = { ...draftFor(data, "2B", { asset: pfAsset }), version: 1 };
    attach(data, [pf], pf);
    const viewAsset = o.viewSameAsPf
      ? pfAsset
      : o.viewSameAsLocationRef
        ? locRef
        : newUploadAsset(data.project.id, { label: "doorway-2b" });
    if (!data.assets.includes(viewAsset)) data.assets.push(viewAsset);
    const view = viewFor(data, location.id, viewAsset, { name: "Doorway" });
    attachViews(data, [view], [{ shotId: shot.id, view }]);
    return { data, pf, sb, view, locRef, viewAsset };
  }

  it("order: Production Frame · Storyboard · … · Location View · generic Location refs; role location_view, truthful label", () => {
    const { data, pf, sb, view, locRef } = richShot();
    const refs = deriveProductionFrameReferenceCandidates(pkgOf(data, "2B"));
    expect(refs.map((r) => [r.role, r.assetId])).toEqual([
      ["production_frame", pf.assetId],
      ["storyboard", sb.assetId],
      ["location_view", view.assetId],
      ["location", locRef.id],
    ]);
    expect(refs.find((r) => r.role === "location_view")!.label).toBe('Canonical Location View "Doorway"');
    const report = evaluateCompatibility(pkgOf(data, "2B"), model("mock-image-1"), {
      purpose: "production_frame",
    });
    expect(report.errors.filter((e) => e.feature === "references")).toEqual([]); // (2.39:1 aspect is a separate, unrelated matter)
    expect(report.used.references.map((r) => r.role)).toEqual([
      "production_frame",
      "storyboard",
      "location_view",
      "location",
    ]);
    // the video path also sends the view, before generic Location references, under its own role
    const videoRefs = deriveReferenceCandidates(pkgOf(data, "2B"));
    const roles = videoRefs.map((r) => r.role);
    expect(roles.indexOf("location_view")).toBeLessThan(roles.indexOf("location"));
  });

  it("the same Asset as the selected Production Frame is sent ONCE, as production_frame (no second slot)", () => {
    const { data, pf } = richShot({ viewSameAsPf: true });
    const refs = deriveProductionFrameReferenceCandidates(pkgOf(data, "2B"));
    expect(refs.filter((r) => r.assetId === pf.assetId)).toEqual([
      expect.objectContaining({ role: "production_frame" }),
    ]);
    expect(refs.some((r) => r.role === "location_view")).toBe(false);
    expect(new Set(refs.map((r) => r.assetId)).size).toBe(refs.length);
  });

  it("an image that is both the view and a generic Location reference is sent once, as location_view", () => {
    const { data, locRef } = richShot({ viewSameAsLocationRef: true });
    const refs = deriveProductionFrameReferenceCandidates(pkgOf(data, "2B"));
    expect(refs.filter((r) => r.assetId === locRef.id)).toEqual([
      expect.objectContaining({ role: "location_view" }),
    ]);
  });

  it("more references than the model accepts BLOCKS the candidate: nothing is truncated", () => {
    const { data } = richShot();
    const lite = model("mock-image-lite"); // accepts 2
    const report = evaluateCompatibility(pkgOf(data, "2B"), lite, { purpose: "production_frame" });
    expect(report.compatible).toBe(false);
    expect(report.errors.map((e) => e.id)).toContain("references.too_many");
    expect(report.errors.find((e) => e.id === "references.too_many")!.message).toMatch(
      /4 references selected/,
    );
  });

  it("a model that takes no images: the view is described in words and disclosed as NOT supplied", () => {
    const { data } = seedWithView();
    const report = evaluateCompatibility(pkgOf(data), textOnly(), { purpose: "production_frame" });
    expect(report.used.references).toEqual([]);
    const lv = report.ignoredFeatures.find((i) => i.id === "references.location_view")!;
    expect(lv.impact).toMatch(/^Location View image not supplied to this model/);
    expect(lv.impact).toMatch(/NOT conditioned on the image/);
    expect(report.inputs.find((i) => i.role === "location_view")?.used).toBe(false);
    const env = buildPromptPlan(pkgOf(data)).sections.find((s) => s.key === "environment")!;
    expect(env.lines.join("\n")).toMatch(/canonical Location View: "Doorway"/);
  });

  it("the Runway adapter gives the view its own deterministic tag", () => {
    expect(
      runwayImageTags([
        { role: "production_frame", label: "Current Production Frame" },
        { role: "location_view", label: 'Canonical Location View "Doorway"' },
        { role: "location", label: "Canopy reference" },
      ]),
    ).toEqual(["ProductionFrame", "LocationView", "Location"]);
  });
});

describe("integrity: a selection of another Location's view never resolves", () => {
  it("context marks it invalid, the package omits it, preflight blocks, and nothing of it reaches the references", () => {
    const { data, view } = seedWithView("2A");
    // the Shot moves to the lobby by a path that did NOT clear the pointer (historical / out-of-band data)
    shotByCode(data, "2A").spatial.locationId = locationByName(data, "Grand Celeste Lobby").id;
    const ctx = ctxOf(data);
    expect(ctx.selectedLocationView).toBeNull();
    expect(ctx.locationViewIssue).toMatchObject({ code: "wrong_location", locationViewId: view.id });
    const pkg = assembleGenerationPackage(ctx);
    expect(pkg.references).not.toHaveProperty("locationView");
    expect(pkg.assets[view.assetId]).toBeUndefined();
    expect(deriveProductionFrameReferenceCandidates(pkg).some((r) => r.assetId === view.assetId)).toBe(false);
    const item = runPreflight(ctx).items.find((i) => i.ruleId === "set.location_view")!;
    expect(item).toMatchObject({ status: "fail", detail: LOCATION_VIEW_INTEGRITY_MESSAGE });
    expect(pkg.readiness.ready).toBe(false);
  });

  it("no selection is never a blocker", () => {
    const ctx = ctxOf(seed());
    expect(runPreflight(ctx).items.find((i) => i.ruleId === "set.location_view")!.status).toBe("na");
  });
});

describe("history: v2 and v3 packages stay readable; nothing is rewritten", () => {
  it("a frozen v3 snapshot (2G.2) and a v2 snapshot compare by Shot inputs, without a false 'shot changed'", () => {
    const data = seed();
    const current = pkgOf(data);
    const asV3 = { ...JSON.parse(JSON.stringify(current)), version: 3, packageSchemaVersion: 3 };
    delete asV3.references.locationView;
    const v3 = { packageFingerprint: "f".repeat(64), packageSnapshot: asV3 };
    expect(shotChangedSinceAttempt(v3, current)).toMatchObject({ changed: false, basis: "inputs" });
    const asV2 = { ...asV3, version: 2, packageSchemaVersion: 2 };
    delete asV2.references.productionFrame;
    expect(
      shotChangedSinceAttempt({ packageFingerprint: "e".repeat(64), packageSnapshot: asV2 }, current),
    ).toMatchObject({ changed: false, basis: "inputs" });
    // a v3 candidate's input basis reads as before (no location_view in its request)
    expect(
      candidateInputBasis({
        request: { purpose: "production_frame", references: [] },
        packageSnapshot: asV3,
      }),
    ).toMatchObject({ productionFrameReference: null, locationViewReference: null });
  });
});

describe("memory repository: create, dedupe, select (same Location only), clear, CAS, location change", () => {
  async function setup() {
    const repo = new MemoryRepository();
    const data = (await repo.loadProject("ojousama"))!;
    const pid = data.project.id;
    const canopy = locationOf(data, "2A");
    const asset = newUploadAsset(pid, { label: "repo doorway", width: 1024, height: 768 });
    const draft = viewFor(data, canopy.id, asset, { name: "Doorway" });
    return { repo, data, pid, canopy, asset, draft, lv: repo.locationViews };
  }

  it("an upload stores its Asset with the view; an identical create returns the existing view, no duplicate", async () => {
    const { repo, pid, asset, draft, lv } = await setup();
    const before = (await repo.loadProject("ojousama"))!.assets.length;
    const r1 = await lv.create({ draft, newAsset: asset });
    expect(r1.created).toBe(true);
    expect((await repo.loadProject("ojousama"))!.assets.length).toBe(before + 1);
    const r2 = await lv.create({ draft: { ...draft, id: "another-id" }, newAsset: { ...asset, id: "a2" } });
    expect(r2).toMatchObject({ created: false, view: { id: r1.view.id } });
    expect((await repo.loadProject("ojousama"))!.assets.length).toBe(before + 1);
    expect((await lv.listForProject(pid)).views).toHaveLength(1);
    expect(await lv.usesAsset(asset.id)).toBe(true);
  });

  it("refuses a view whose facts differ from its image", async () => {
    const { asset, draft, lv } = await setup();
    await expect(
      lv.create({ draft: { ...draft, assetChecksum: "0".repeat(64) }, newAsset: asset }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("select for a Shot at that Location; cross-Location and cross-Project refused; CAS; clear; reselect", async () => {
    const { repo, data, pid, asset, draft, lv } = await setup();
    const view = (await lv.create({ draft, newAsset: asset })).view;
    const shot2A = shotByCode(data, "2A");
    const shot3A = shotByCode(data, "3A"); // the lobby
    const sel = (shotId: string, expected?: string | null, viewId = view.id) =>
      lv.selectForShot({
        projectId: pid,
        shotId,
        locationViewId: viewId,
        userId: null,
        now: T,
        expectedSelectedViewId: expected,
      });
    const s1 = await sel(shot2A.id, null);
    expect(s1).toMatchObject({ shotId: shot2A.id, locationViewId: view.id, locationId: view.locationId });
    await expect(sel(shot3A.id)).rejects.toMatchObject({ code: "wrong_location" });
    await expect(
      lv.selectForShot({
        projectId: "other",
        shotId: shot2A.id,
        locationViewId: view.id,
        userId: null,
        now: T,
      }),
    ).rejects.toBeInstanceOf(LocationViewError);
    await expect(sel(shot2A.id, null)).rejects.toMatchObject({ code: "conflict" });
    await expect(
      lv.clearForShot({ projectId: pid, shotId: shot2A.id, expectedSelectedViewId: null }),
    ).rejects.toMatchObject({ code: "conflict" });
    await lv.clearForShot({ projectId: pid, shotId: shot2A.id, expectedSelectedViewId: view.id });
    expect(await lv.selectionForShot(pid, shot2A.id)).toBeNull();
    expect((await sel(shot2A.id, null)).locationViewId).toBe(view.id);
    // selecting never mutated the Shot row
    // 3A.4F (0047): clearing moves the Shot's clock and nothing else about it
    const cleared = (await repo.loadProject("ojousama"))!.shots.find((s) => s.id === shot2A.id)!;
    expect(cleared.updatedAt).not.toBe(shot2A.updatedAt);
    expect({ ...cleared, updatedAt: shot2A.updatedAt }).toEqual(shot2A);
  });

  it("moving the Shot to another Location clears the old Location's view selection (like the database trigger)", async () => {
    const { repo, data, pid, asset, draft, lv } = await setup();
    const view = (await lv.create({ draft, newAsset: asset })).view;
    const shot = shotByCode(data, "2A");
    await lv.selectForShot({
      projectId: pid,
      shotId: shot.id,
      locationViewId: view.id,
      userId: null,
      now: T,
    });
    // an unrelated edit keeps it
    await repo.upsert(pid, "shots", { ...shot, title: "renamed" });
    expect(await lv.selectionForShot(pid, shot.id)).not.toBeNull();
    // a Location change clears it
    const lobby = locationByName(data, "Grand Celeste Lobby");
    await repo.upsert(pid, "shots", { ...shot, spatial: { ...shot.spatial, locationId: lobby.id } });
    expect(await lv.selectionForShot(pid, shot.id)).toBeNull();
    // moving back does NOT resurrect it
    await repo.upsert(pid, "shots", shot);
    expect(await lv.selectionForShot(pid, shot.id)).toBeNull();
    expect((await lv.listForProject(pid)).views).toHaveLength(1); // the view itself is untouched
  });
});

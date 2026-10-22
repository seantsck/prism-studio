import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { draftLocationView } from "@/domain/location-view";
import { productionFrameToViewStatus } from "@/domain/production-frame";
import type { ProjectData } from "@/domain/schemas";
import { promoteGeneratedFrame } from "@/server/production-frame-generated";
import { CandidateSetBlockedError, submitCandidateSet, type CandidateSelection } from "../candidate-set";
import { makeHarness, type Harness } from "./helpers";

/**
 * Phase 2G.3 end to end on the memory repository — THE acceptance workflow, with the FREE mock image models (no
 * provider, no GPU, no 3D set):
 *
 *   Shot A: generate → choose a Production Frame → "Save as Location View" ("Doorway", the SAME Asset)
 *   Shot B: choose "Doorway" → generate → the frozen request carries the view as `location_view`, once
 *   Shot C: choose the same "Doorway" → the same image reference
 *
 * plus: same-Asset dedupe on Shot A, reference overflow BLOCKS (no attempt, no call), and freshness.
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const mock = (modelId: string): CandidateSelection => ({ provider: "mock", modelId });

/** ProjectData exactly as the server loaders attach it (Production Frames + Location Views). */
async function attached(h: Harness): Promise<ProjectData> {
  const data = await h.data();
  const pf = await h.repo.productionFrames.listForProject(data.project.id);
  const lv = await h.repo.locationViews.listForProject(data.project.id);
  return {
    ...data,
    productionFrames: pf.frames,
    productionFrameSelections: pf.selections,
    locationViews: lv.views,
    shotLocationViewSelections: lv.selections,
  };
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
    title: "Frame candidates",
    purpose: "location continuity",
    userId: null,
    projectRevision: null,
    generationPurpose: "production_frame",
    now: h.clock.now,
  });
}

async function drain(h: Harness, rounds = 14) {
  for (let i = 0; i < rounds; i++) {
    await h.worker().tick(10);
    h.clock.advance(2000);
  }
}

const refsOf = (a: { request: unknown }) =>
  (a.request as { references?: Array<{ role: string; assetId: string; label: string }> }).references ?? [];

async function setup() {
  const h = makeHarness();
  const data = await h.data();
  const pid = data.project.id;
  // 1A and 1B are both set at "Tokyo Night Streets"; a third Shot C there too. 16:9 so the free models are native.
  const a = data.shots.find((s) => s.shotCode === "1A")!;
  const b = data.shots.find((s) => s.shotCode === "1B")!;
  const c = { ...b, id: randomUUID(), shotCode: "1Z", title: "Shot C", order: 99 };
  for (const s of [a, b, c])
    await h.repo.upsert(pid, "shots", {
      ...s,
      composition: { ...s.composition, aspectRatio: "16:9" },
      updatedAt: new Date(h.clock.now.getTime() - 1000).toISOString(),
    });
  expect(a.spatial.locationId).toBe(b.spatial.locationId);
  return { h, pid, a: a.id, b: b.id, c: c.id, locationId: a.spatial.locationId! };
}

describe("Location View continuity (memory, free mock image models)", () => {
  it("Shot A frame → 'Doorway' view (same Asset) → Shots B and C send the same canonical image", async () => {
    const { h, pid, a, b, c, locationId } = await setup();

    // ── Shot A: generate, choose a Production Frame ──
    await generate(h, a, [mock("mock-image-1")]);
    await drain(h);
    const [candidate] = (await h.data()).attempts.filter((x) => x.shotId === a);
    const promoted = await promoteGeneratedFrame(
      { frames: h.repo.productionFrames, generation: h.repo.generation, qa: h.repo.mediaQa },
      buildShotContext(await attached(h), a),
      { attemptId: candidate!.id, userId: null },
    );
    const ctxA = buildShotContext(await attached(h), a);
    expect(productionFrameToViewStatus(ctxA)).toEqual({ ok: true });

    // ── Save as Location View: the SAME Asset, no copy ──
    const assetsBefore = (await h.data()).assets.length;
    const drafted = draftLocationView({
      id: randomUUID(),
      now: h.clock.now.toISOString(),
      userId: null,
      projectId: pid,
      location: ctxA.location!,
      asset: ctxA.assets.get(promoted.frame.assetId)!,
      source: "production_frame",
      sourceProductionFrameId: promoted.frame.id,
      spec: { name: "Doorway", kind: "entrance", viewpointDescription: "from the curb toward the hotel" },
    });
    if (!drafted.ok) throw new Error(drafted.message);
    const saved = await h.repo.locationViews.create({ draft: drafted.draft, newAsset: null });
    expect(saved.created).toBe(true);
    expect(saved.view).toMatchObject({
      assetId: promoted.frame.assetId,
      source: "production_frame",
      sourceProductionFrameId: promoted.frame.id,
      locationId,
    });
    expect((await h.data()).assets.length).toBe(assetsBefore); // no duplicated bytes / Asset row
    // saving it changed nothing about Shot A (no selection was made for it)
    expect(buildShotContext(await attached(h), a).selectedLocationView).toBeNull();

    // ── Shot B and Shot C choose "Doorway" and generate ──
    for (const shotId of [b, c]) {
      await h.repo.locationViews.selectForShot({
        projectId: pid,
        shotId,
        locationViewId: saved.view.id,
        userId: null,
        now: h.clock.now.toISOString(),
      });
      const pkg = assembleGenerationPackage(buildShotContext(await attached(h), shotId));
      expect(pkg.references.locationView?.viewId).toBe(saved.view.id);
      const out = await generate(h, shotId, [mock("mock-image-1")]);
      expect(out.submitted).toBe(1);
    }
    await drain(h);
    const sent = (await h.data()).attempts.filter((x) => x.shotId === b || x.shotId === c);
    expect(sent).toHaveLength(2);
    for (const attempt of sent) {
      expect(attempt.status).toBe("succeeded");
      expect(attempt.requestModality).toBe("image_to_image");
      const refs = refsOf(attempt);
      expect(refs.filter((r) => r.assetId === saved.view.assetId)).toEqual([
        expect.objectContaining({ role: "location_view", label: 'Canonical Location View "Doorway"' }),
      ]);
      expect(attempt.inputAssetIds).toContain(saved.view.assetId);
      // the frozen package says which view it was
      expect(
        (attempt.packageSnapshot as { references?: { locationView?: { viewId: string } } }).references
          ?.locationView?.viewId,
      ).toBe(saved.view.id);
    }

    // ── Shot A also chooses "Doorway" (its own frame's image): alternatives send that image ONCE ──
    await h.repo.locationViews.selectForShot({
      projectId: pid,
      shotId: a,
      locationViewId: saved.view.id,
      userId: null,
      now: h.clock.now.toISOString(),
    });
    await generate(h, a, [mock("mock-image-1")]);
    await drain(h);
    const latestA = (await h.data()).attempts
      .filter((x) => x.shotId === a)
      .sort((x, y) => y.attemptNumber - x.attemptNumber)[0]!;
    const refsA = refsOf(latestA).filter((r) => r.assetId === promoted.frame.assetId);
    expect(refsA).toEqual([expect.objectContaining({ role: "production_frame" })]);
    expect(refsOf(latestA).some((r) => r.role === "location_view")).toBe(false);
  });

  it("references beyond the model's limit BLOCK the candidate: no attempt, no job, nothing truncated", async () => {
    const { h, pid, b, locationId } = await setup();
    // two stored images (real generated bytes) become the Location's generic references, a third its Doorway view
    await generate(h, b, [mock("mock-image-1"), mock("mock-image-1"), mock("mock-image-1")]);
    await drain(h);
    const outputs = await Promise.all(
      (await h.data()).attempts
        .filter((x) => x.shotId === b)
        .map(async (x) => (await h.repo.generation.getAttemptView(x.id))!.outputs[0]!.asset),
    );
    const data = await h.data();
    const location = data.locations.find((l) => l.id === locationId)!;
    await h.repo.upsert(pid, "locations", {
      ...location,
      referenceAssetIds: [outputs[0]!.id, outputs[1]!.id],
    });
    const drafted = draftLocationView({
      id: randomUUID(),
      now: h.clock.now.toISOString(),
      userId: null,
      projectId: pid,
      location,
      asset: outputs[2]!,
      source: "upload",
      spec: { name: "Doorway", kind: "entrance" },
    });
    if (!drafted.ok) throw new Error(drafted.message);
    const view = (await h.repo.locationViews.create({ draft: drafted.draft, newAsset: null })).view;
    await h.repo.locationViews.selectForShot({
      projectId: pid,
      shotId: b,
      locationViewId: view.id,
      userId: null,
      now: h.clock.now.toISOString(),
    });
    const attemptsBefore = (await h.data()).attempts.length;
    // mock-image-lite accepts 2 references; the Shot now needs 3 (view + 2 Location references)
    await expect(generate(h, b, [mock("mock-image-lite")])).rejects.toBeInstanceOf(CandidateSetBlockedError);
    await expect(generate(h, b, [mock("mock-image-lite")])).rejects.toThrow(/accepts at most 2/);
    expect((await h.data()).attempts.length).toBe(attemptsBefore);
    // the larger model takes all three, the view first among the Location images
    const ok = await generate(h, b, [mock("mock-image-1")]);
    expect(ok.submitted).toBe(1);
    await drain(h);
    const last = (await h.data()).attempts.sort((x, y) => y.attemptNumber - x.attemptNumber)[0]!;
    expect(refsOf(last).map((r) => r.role)).toEqual(["location_view", "location", "location"]);
  });
});

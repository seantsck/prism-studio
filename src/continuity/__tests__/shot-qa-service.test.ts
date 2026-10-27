import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AttemptView } from "@/data/generation-repository";
import type { MediaQaRepository } from "@/data/media-qa-repository";
import { MockContinuityAnalyzer } from "@/domain/continuity/analyzer";
import type { ProductionFrame } from "@/domain/production-frame";
import type { ProjectData } from "@/domain/schemas";
import { attach, draftFor, newUploadAsset } from "@/domain/__tests__/production-frame-fixtures";
import { makeHarness, type Harness } from "@/generation/__tests__/helpers";
import { FfmpegMediaProcessor } from "@/media/ffmpeg";
import { computeQaInputs, projectRun, runContinuityReview } from "../service";

/**
 * Phase 3A.1 end-to-end through the real service (memory repositories, real ffmpeg probe, Mock analyzer; no provider):
 * a stored run projects into a Shot QA assessment, human overrides change only the EFFECTIVE assessment, a Production
 * Frame-sourced attempt is judged against its frozen frame, a later selection makes the QA stale, and nothing touches
 * creative review.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const processor = new FfmpegMediaProcessor({ limits: { timeoutMs: 90_000 } });
const hasFfmpeg = await processor.available();
const media = hasFfmpeg ? describe : describe.skip;

media("Shot QA over stored continuity runs", () => {
  let h: Harness;
  let qa: MediaQaRepository;
  let attemptId: string;
  const deps = () => ({
    processor,
    storage: h.sink,
    qa,
    userId: null,
    now: () => h.clock.now,
    analyzer: new MockContinuityAnalyzer(),
  });
  const view = () => h.repo.generation.getAttemptView(attemptId).then((v) => v!);

  beforeAll(async () => {
    h = makeHarness();
    qa = h.repo.mediaQa;
    const r = await h.submit("3A", "mock-video-1");
    attemptId = r.attemptId!;
    const w = h.worker();
    for (let i = 0; i < 30; i++) {
      const j = (await h.repo.generation.getJob(r.jobId!))!;
      if (j.status === "succeeded" || j.status === "failed") break;
      await w.tick();
      h.clock.advance(1500);
    }
    expect((await view()).attempt.status).toBe("succeeded");
  });

  /** The same attempt, as if it had been generated (animated) from Production Frame `frame` of `data`. */
  function asAnimatedFrom(v: AttemptView, frame: ProductionFrame, data: ProjectData): AttemptView {
    const snap = structuredClone(v.attempt.packageSnapshot) as Record<string, unknown> & {
      references: Record<string, unknown>;
      assets: Record<string, unknown>;
    };
    const asset = data.assets.find((a) => a.id === frame.assetId)!;
    snap.references = {
      ...snap.references,
      productionFrame: {
        frameId: frame.id,
        assetId: frame.assetId,
        version: frame.version,
        source: frame.source,
        intentFingerprint: frame.intentFingerprint,
        freshness: "fresh",
        changedParts: [],
      },
    };
    snap.assets = { ...snap.assets, [asset.id]: { checksum: asset.checksum } };
    return {
      ...v,
      attempt: {
        ...v.attempt,
        packageSnapshot: snap,
        request: { ...(v.attempt.request ?? {}), purpose: "animate_production_frame" },
      },
    };
  }

  it("a Mock run projects into a Shot QA assessment: ordered issues, suggestions only from fails/warnings, review untouched", async () => {
    const data = await h.data();
    const v = await view();
    const inputs = computeQaInputs({ data, view: v, delivery: null, now: h.clock.now })!;
    const run = await runContinuityReview({ inputs, view: v, deps: deps() });
    const p = projectRun(run, inputs);
    const a = p.assessment;
    expect(a.run).toMatchObject({ id: run.run.id, analyzerKind: "mock" });
    expect(a.freshness?.stale).toBe(false);
    expect(run.run.rulesVersion).toBe("3a.1");
    // the projection agrees with the stored rows it was derived from
    const fails = run.findings.filter((f) => f.finding.result === "fail").length;
    expect(a.counts.criticalFailures + a.counts.majorFailures + a.counts.minorFailures).toBe(fails);
    expect(a.issues.map((i) => i.priority)).toEqual(
      [...a.issues.map((i) => i.priority)].sort((x, y) => x - y),
    );
    const suggested = new Set(a.suggestedRejectionReasons.map((s) => s.criterionKey));
    for (const i of a.issues) if (i.kind === "unchecked") expect(suggested.has(i.criterionKey)).toBe(false);
    // camera movement and lip sync stay unchecked for the image-only Mock analyzer
    const movement = run.findings.find((f) => f.finding.criterionKey === "camera_movement");
    if (movement) expect(movement.finding.result).toBe("unchecked");
    expect(run.findings.some((f) => f.finding.criterionKey === "camera")).toBe(false);
    // QA never touches creative state
    const after = await view();
    expect(after.attempt.reviewStatus).toBe("unreviewed");
    expect(after.attempt.approved).toBe(false);
  });

  it("an override changes the effective assessment only; the stored system finding stays as recorded", async () => {
    const data = await h.data();
    const v = await view();
    const inputs = computeQaInputs({ data, view: v, delivery: null, now: h.clock.now })!;
    const run = await runContinuityReview({ inputs, view: v, deps: deps() });
    const target = run.findings.find(
      (f) => f.finding.result === "pass" && f.finding.resultSource === "analyzer",
    )!;
    expect(target).toBeTruthy();
    const before = projectRun(run, inputs).assessment;
    expect(before.issues.some((i) => i.findingId === target.finding.id)).toBe(false);

    await qa.addOverride({
      runId: run.run.id,
      findingId: target.finding.id,
      result: "fail",
      notes: "Visibly wrong on the reviewer's monitor.",
      createdBy: "u1",
      now: "2026-10-27T12:00:00.000Z",
    });
    const stored = (await qa.getRun(run.run.id))!;
    const a = projectRun(stored, inputs).assessment;
    const issue = a.issues.find((i) => i.findingId === target.finding.id)!;
    expect(issue).toMatchObject({ kind: "fail", systemResult: "pass", result: "fail" });
    expect(a.overridesChangedResult).toBe(true);
    expect(a.suggestedRejectionReasons.find((s) => s.findingId === target.finding.id)).toMatchObject({
      fromOverride: true,
    });
    expect(stored.findings.find((f) => f.finding.id === target.finding.id)!.finding.result).toBe("pass");
    expect((await view()).attempt.reviewStatus).toBe("unreviewed");
  });

  it("a Production Frame-sourced attempt is judged against its FROZEN frame; a later selection makes the QA stale", async () => {
    const data = structuredClone(await h.data());
    const v1Asset = newUploadAsset(data.project.id, { label: "pf-3A-v1" });
    data.assets.push(v1Asset);
    const v1: ProductionFrame = { ...draftFor(data, "3A", { asset: v1Asset }), version: 1 };
    attach(data, [v1], v1);
    const v = asAnimatedFrom(await view(), v1, data);

    const inputs = computeQaInputs({ data, view: v, delivery: null, now: h.clock.now })!;
    const pf = inputs.criteria.find((c) => c.key === "production_frame")!;
    expect(pf).toMatchObject({ severity: "critical", title: "Opening image — Production Frame v1" });
    expect(inputs.references.items.find((i) => i.role === "production_frame")).toMatchObject({
      assetId: v1Asset.id,
      checksum: v1Asset.checksum,
    });
    const run = await runContinuityReview({ inputs, view: v, deps: deps() });
    const stored = run.findings.find((f) => f.finding.criterionKey === "production_frame")!;
    expect(stored.finding.severity).toBe("critical");
    expect(projectRun(run, inputs).assessment.freshness?.stale).toBe(false);

    // the filmmaker selects Production Frame v2 afterwards: the run is now stale, and says why
    const v2Asset = newUploadAsset(data.project.id, { label: "pf-3A-v2" });
    data.assets.push(v2Asset);
    const v2: ProductionFrame = { ...draftFor(data, "3A", { asset: v2Asset }), version: 2 };
    attach(data, [v1, v2], v2);
    const now = computeQaInputs({ data, view: v, delivery: null, now: h.clock.now })!;
    // the criterion still names the frame the attempt was generated from
    expect(now.criteria.find((c) => c.key === "production_frame")!.title).toBe(
      "Opening image — Production Frame v1",
    );
    const frozenRun = JSON.stringify(await qa.getRun(run.run.id));
    const a = projectRun((await qa.getRun(run.run.id))!, now).assessment;
    expect(a.state).toBe("qa_stale");
    expect(a.freshness!.reasons.join(" ")).toMatch(
      /now selects Production Frame v2; this output was generated from v1/,
    );
    expect(a.suggestedRejectionReasons).toEqual([]);
    expect(JSON.stringify(await qa.getRun(run.run.id))).toBe(frozenRun);
  });

  it("a historical 2c.1 run stays readable and explains that the rules changed", async () => {
    const data = await h.data();
    const v = await view();
    const inputs = computeQaInputs({ data, view: v, delivery: null, now: h.clock.now })!;
    const run = await runContinuityReview({ inputs, view: v, deps: deps() });
    const legacy = structuredClone(run);
    legacy.run.rulesVersion = "2c.1";
    legacy.run.criteriaFingerprint = "legacy-criteria";
    const a = projectRun(legacy, inputs).assessment;
    expect(a.state).toBe("qa_stale");
    expect(a.freshness!.reasons.join(" ")).toMatch(/rules 2c\.1 → 3a\.1/);
    expect(a.issues.length + a.counts.evaluated).toBeGreaterThan(0);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MediaQaRepository } from "@/data/media-qa-repository";
import { parseAdaptationPlan } from "@/domain/framing/adaptation";
import { MockContinuityAnalyzer } from "@/domain/continuity/analyzer";
import { buildCriteria, buildReferenceSet } from "@/domain/continuity/criteria";
import { approvalAdvisories } from "@/domain/continuity/status";
import { makeHarness, type Harness } from "@/generation/__tests__/helpers";
import type { LocalDiskSink } from "@/generation/sink";
import {
  conformAttemptOutput,
  ensureReviewArtifacts,
  readVerified,
  type MediaStorage,
} from "@/media/delivery";
import { FfmpegMediaProcessor } from "@/media/ffmpeg";
import { computeQaInputs, projectRun, runContinuityReview } from "../service";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const processor = new FfmpegMediaProcessor({ limits: { timeoutMs: 90_000 } });
const hasFfmpeg = await processor.available();
const media = hasFfmpeg ? describe : describe.skip;

const CHOICE = { framing: "overscan_for_crop", duration: "generate_longer_then_trim" } as const;

/** Shot 3A is the acceptance scenario: production 2.39:1, 4.5 s. The 16:9-only mock model needs adapting. */
async function generateAdapted(h: Harness) {
  const { attemptId, jobId, prepared } = await h.submit("3A", "mock-video-169", { adaptation: CHOICE });
  expect(attemptId, JSON.stringify(prepared.evaluation.gate)).toBeTruthy();
  const w = h.worker();
  for (let i = 0; i < 30; i++) {
    const j = (await h.repo.generation.getJob(jobId!))!;
    if (j.status === "succeeded" || j.status === "failed") break;
    await w.tick();
    h.clock.advance(1500);
  }
  return { attemptId: attemptId!, jobId: jobId! };
}

describe("framing adaptation in the generation pipeline (no ffmpeg needed)", () => {
  it("Shot 3A on a 16:9 / 5 s model is incompatible until the user chooses a strategy", async () => {
    const h = makeHarness();
    const r = await h.submit("3A", "mock-video-169", { acknowledge: false });
    expect(r.attemptId).toBeNull();
    const c = r.prepared.evaluation.compatibility!;
    expect(c.compatible).toBe(false);
    expect(c.errors.map((e) => e.id)).toEqual(
      expect.arrayContaining(["aspect_ratio.unsupported", "duration.unsupported"]),
    );
    expect(c.adaptation!.status).toBe("needs_choice");
    expect(c.adaptation!.framing.recommended).toBe("overscan_for_crop");
    expect(c.adaptation!.duration.recommended).toBe("generate_longer_then_trim");
  });

  it("an explicit choice makes it compatible but demands acknowledgement of each adaptation", async () => {
    const h = makeHarness();
    const noAck = await h.submit("3A", "mock-video-169", { adaptation: CHOICE, acknowledge: false });
    expect(noAck.attemptId).toBeNull();
    const ids = noAck.prepared.evaluation.gate.unacknowledged.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["adaptation.framing", "adaptation.duration"]));
    expect(noAck.prepared.evaluation.gate.blockers).toHaveLength(0);
  });

  it("freezes the plan with the attempt and leaves production intent untouched", async () => {
    const h = makeHarness();
    const before = (await h.data()).shots.find((s) => s.shotCode === "3A")!;
    const { attemptId } = await h.submit("3A", "mock-video-169", { adaptation: CHOICE });
    const data = await h.data();
    const attempt = data.attempts.find((a) => a.id === attemptId)!;
    const plan = parseAdaptationPlan(attempt.adaptationPlan)!;
    expect(plan).toBeTruthy();
    expect(plan.status).toBe("adapted");
    expect(plan.production).toMatchObject({ aspectRatio: "2.39:1", durationMs: 4500 });
    expect(plan.framing.providerLabel).toBe("16:9");
    expect(plan.duration).toMatchObject({ providerMs: 5000, trimToMs: 4500 });
    expect(plan.conform).toMatchObject({ required: true, steps: ["crop", "trim"] });
    // what the PROVIDER was asked for
    expect(attempt.modelSettings).toMatchObject({ aspectRatio: "16:9", durationMs: 5000 });
    // what the FILM is
    const snap = attempt.packageSnapshot as {
      timing: { durationMs: number };
      style: { aspectRatio: string };
    };
    expect(snap.timing.durationMs).toBe(4500);
    expect(snap.style.aspectRatio).toBe("2.39:1");
    const after = data.shots.find((s) => s.shotCode === "3A")!;
    expect(after.composition.aspectRatio).toBe(before.composition.aspectRatio);
    expect(after.targetDurationMs).toBe(before.targetDurationMs);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it("keeps the production instruction and the provider adaptation separate, and never edits camera intent", async () => {
    const h = makeHarness();
    const { attemptId } = await h.submit("3A", "mock-video-169", { adaptation: CHOICE });
    const attempt = (await h.data()).attempts.find((a) => a.id === attemptId)!;
    const sections = attempt.promptPlan!.sections;
    const adaptation = sections.find((s) => s.key === "provider_adaptation")!;
    expect(adaptation.lines.join(" ")).toMatch(/centered 2\.39:1 protected region/);
    const composition = sections.find((s) => s.key === "composition")!;
    expect(composition.lines.join(" ")).toMatch(/aspect ratio 2\.39:1/);
    expect(composition.lines.join(" ")).not.toMatch(/protected region/);
    const plan = parseAdaptationPlan(attempt.adaptationPlan)!;
    expect(plan.promptAdaptation.production.join(" ")).toMatch(/2\.39:1/);
  });

  it("older attempts without a plan stay readable and never get an invented plan", async () => {
    const h = makeHarness();
    const data = await h.data();
    const legacy = data.attempts[0];
    if (legacy) {
      expect(parseAdaptationPlan(legacy.adaptationPlan)).toBeNull();
    }
    // a native generation records a `native` plan (nothing adapted), also a fact worth keeping
    const { attemptId } = await h.submit("3A", "mock-video-1");
    const a = (await h.data()).attempts.find((x) => x.id === attemptId)!;
    expect(parseAdaptationPlan(a.adaptationPlan)?.status).toBe("native");
  });

  it("protected composition notes flow into the plan (manual production intent)", async () => {
    const h = makeHarness();
    const data = await h.data();
    const shot = data.shots.find((s) => s.shotCode === "3A")!;
    await h.repo.upsert(data.project.id, "shots", {
      ...shot,
      generation: { ...shot.generation, protectedComposition: ["Yumeko's eyes inside the crop"] },
      updatedAt: new Date(h.clock.now.getTime() - 1000).toISOString(),
    });
    const { attemptId } = await h.submit("3A", "mock-video-169", { adaptation: CHOICE });
    const attempt = (await h.data()).attempts.find((a) => a.id === attemptId)!;
    const plan = parseAdaptationPlan(attempt.adaptationPlan)!;
    expect(plan.framing.protectedNotes).toEqual(["Yumeko's eyes inside the crop"]);
    expect(plan.promptAdaptation.provider.join(" ")).toMatch(/Yumeko/);
  });
});

media("delivery conform, lineage and continuity QA (real ffmpeg)", () => {
  let root: string;
  let h: Harness;
  let storage: LocalDiskSink;
  let qa: MediaQaRepository;
  let attemptId: string;
  let originalId: string;

  const deps = () => ({ processor, storage, qa, userId: null, now: () => h.clock.now });
  const view = () => h.repo.generation.getAttemptView(attemptId).then((v) => v!);

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "prism-2c-"));
    h = makeHarness();
    // the worker's sink and the media storage are the same private store
    storage = h.sink;
    qa = h.repo.mediaQa;
    ({ attemptId } = await generateAdapted(h));
    originalId = (await view()).outputs.find((o) => o.output.role === "primary")!.asset.id;
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("the provider original is the fixture clip (16:9, 5 s) and stays the original", async () => {
    const v = await view();
    expect(v.attempt.status).toBe("succeeded");
    const original = v.outputs.find((o) => o.asset.id === originalId)!.asset;
    expect(original.source).toBe("provider_output");
    expect(original.width! / original.height!).toBeCloseTo(16 / 9, 2);
  });

  it("conforms to 2.39:1 / 4.5 s as a NEW derived asset with lineage; the original is untouched", async () => {
    const v = await view();
    const original = v.outputs.find((o) => o.asset.id === originalId)!.asset;
    const originalBytes = Buffer.from(await readVerified(original, storage));
    const plan = parseAdaptationPlan(v.attempt.adaptationPlan)!;

    const r = await conformAttemptOutput({
      attemptId,
      attemptLabel: "3A-a1",
      original,
      plan: plan.conform,
      deps: deps(),
    });
    expect(r.derived?.created).toBe(true);
    const out = r.deliveryAsset;
    expect(out.id).not.toBe(original.id);
    expect(out.source).toBe("derived");
    expect(out.purpose).toBe("generation_output");
    expect(out.width! / out.height!).toBeGreaterThan(2.3);
    expect(out.width! / out.height!).toBeLessThan(2.45);
    expect(out.durationMs!).toBeGreaterThan(4300);
    expect(out.durationMs!).toBeLessThan(4700);
    expect(r.derived!.derivation).toMatchObject({
      parentAssetId: original.id,
      childAssetId: out.id,
      operation: "conform",
      attemptId,
      slot: "delivery",
      version: 1,
    });
    // original bytes + record are unchanged
    const originalAfter = (await h.data()).assets.find((a) => a.id === original.id)!;
    expect(originalAfter.checksum).toBe(original.checksum);
    expect(Buffer.from(await readVerified(originalAfter, storage)).equals(originalBytes)).toBe(true);
    // the delivery master is selected, and visible in project assets (Asset Library)
    const delivery = await qa.getDelivery(attemptId);
    expect(delivery).toMatchObject({ assetId: out.id, originalAssetId: original.id });
    expect((await h.data()).assets.some((a) => a.id === out.id)).toBe(true);
  });

  it("is idempotent: the same conform again reuses the derived asset (no duplicates)", async () => {
    const v = await view();
    const original = v.outputs.find((o) => o.asset.id === originalId)!.asset;
    const plan = parseAdaptationPlan(v.attempt.adaptationPlan)!;
    const before = (await h.data()).assets.length;
    const again = await conformAttemptOutput({
      attemptId,
      attemptLabel: "3A-a1",
      original,
      plan: plan.conform,
      deps: deps(),
    });
    expect(again.derived?.created).toBe(false);
    expect((await h.data()).assets.length).toBe(before);
    expect(
      (await qa.listAttemptDerivations(attemptId)).filter((d) => d.derivation.slot === "delivery"),
    ).toHaveLength(1);
  });

  it("recovers from a crash after upload: the retry reuses the object and records ONE derivation", async () => {
    const h2 = makeHarness();
    const { attemptId: att } = await generateAdapted(h2);
    const v2 = (await h2.repo.generation.getAttemptView(att))!;
    const original = v2.outputs.find((o) => o.output.role === "primary")!.asset;
    const plan = parseAdaptationPlan(v2.attempt.adaptationPlan)!;

    let puts = 0;
    const countingStorage: MediaStorage = {
      name: h2.sink.name,
      bucket: h2.sink.bucket,
      get: (p) => h2.sink.get(p),
      remove: (p) => h2.sink.remove(p),
      put: async (p, b) => {
        puts += 1;
        return h2.sink.put(p, b);
      },
    };
    let crash = true;
    const crashing = Object.create(h2.repo.mediaQa) as MediaQaRepository;
    crashing.recordDerivation = async (input) => {
      if (crash) {
        crash = false;
        throw new Error("simulated crash before the database commit");
      }
      return h2.repo.mediaQa.recordDerivation(input);
    };
    const d = { processor, storage: countingStorage, qa: crashing, userId: null, now: () => h2.clock.now };

    await expect(
      conformAttemptOutput({ attemptId: att, attemptLabel: "3A-a1", original, plan: plan.conform, deps: d }),
    ).rejects.toThrow(/simulated crash/);
    expect(puts).toBe(1); // the object was uploaded...
    expect(await h2.repo.mediaQa.listAttemptDerivations(att)).toHaveLength(0); // ...but nothing is recorded

    const retry = await conformAttemptOutput({
      attemptId: att,
      attemptLabel: "3A-a1",
      original,
      plan: plan.conform,
      deps: d,
    });
    expect(puts).toBe(1); // identical bytes already there: not uploaded again
    expect(retry.derived?.created).toBe(true);
    expect(await h2.repo.mediaQa.listAttemptDerivations(att)).toHaveLength(1);
    expect(retry.deliveryAsset.id).toBe(
      (await import("@/media/delivery")).derivedAssetId(retry.derived!.derivation.derivationKey),
    );
  });

  it("extracts review frames and a contact sheet as derived assets (idempotent)", async () => {
    const v = await view();
    const delivery = (await qa.getDelivery(attemptId))!;
    const subject = (await h.data()).assets.find((a) => a.id === delivery.assetId)!;
    const art = await ensureReviewArtifacts({ attemptId, attemptLabel: "3A-a1", subject, deps: deps() });
    expect(art.frames.length).toBeGreaterThanOrEqual(4);
    expect(art.contactSheet?.asset.mime).toBe("image/png");
    expect(art.frames[0]!.atMs).toBe(0);
    const count = (await h.data()).assets.length;
    const again = await ensureReviewArtifacts({ attemptId, attemptLabel: "3A-a1", subject, deps: deps() });
    expect(again.frames.map((f) => f.derived.asset.id)).toEqual(art.frames.map((f) => f.derived.asset.id));
    expect((await h.data()).assets.length).toBe(count);
    void v;
  });

  it("deterministic QA: delivery master passes aspect ratio and duration; semantic criteria stay unchecked", async () => {
    const data = await h.data();
    const delivery = await qa.getDelivery(attemptId);
    const inputs = computeQaInputs({ data, view: await view(), delivery, now: h.clock.now })!;
    expect(inputs.subjectIsOriginal).toBe(false);
    const run = await runContinuityReview({
      inputs,
      view: await view(),
      deps: { ...deps(), analyzer: null },
    });
    const p = projectRun(run, inputs);
    const get = (k: string) => p.findings.find((f) => f.criterionKey === k)!;
    expect(get("aspect_ratio").result).toBe("pass");
    expect(get("duration").result).toBe("pass");
    expect(get("output").result).toBe("pass");
    expect(get("delivery_master").result).toBe("pass");
    expect(get("character_count") ?? { result: "unchecked" }).toBeTruthy();
    const semantic = p.findings.filter((f) => f.criterionKey.startsWith("identity:"));
    expect(semantic.length).toBeGreaterThan(0);
    expect(semantic.every((f) => f.systemResult === "unchecked")).toBe(true);
    expect(p.status).toBe("in_review");
    expect(p.freshness?.stale).toBe(false);
    expect(run.run.analyzerKind).toBe("deterministic");
  });

  it("the provider ORIGINAL is judged against the production frame and fails honestly", async () => {
    const data = await h.data();
    const v = await view();
    const inputs = computeQaInputs({ data, view: v, delivery: null, now: h.clock.now })!;
    expect(inputs.subjectIsOriginal).toBe(true);
    const run = await runContinuityReview({ inputs, view: v, deps: { ...deps(), analyzer: null } });
    const p = projectRun(run, inputs);
    expect(p.findings.find((f) => f.criterionKey === "aspect_ratio")!.result).toBe("fail");
    expect(p.findings.find((f) => f.criterionKey === "duration")!.result).toBe("fail");
    expect(p.findings.find((f) => f.criterionKey === "delivery_master")!.result).toBe("fail");
  });

  it("Mock analyzer: labelled MOCK ANALYSIS, deterministic, never approves anything", async () => {
    const data = await h.data();
    const v = await view();
    const delivery = await qa.getDelivery(attemptId);
    const inputs = computeQaInputs({ data, view: v, delivery, now: h.clock.now })!;
    const a = await runContinuityReview({
      inputs,
      view: v,
      deps: { ...deps(), analyzer: new MockContinuityAnalyzer() },
    });
    const b = await runContinuityReview({
      inputs,
      view: v,
      deps: { ...deps(), analyzer: new MockContinuityAnalyzer() },
    });
    expect(a.run.analysisStatus).toBe("complete");
    expect(a.run.analyzerKind).toBe("mock");
    const analyzed = a.findings.filter((f) => f.finding.resultSource === "analyzer");
    expect(analyzed.length).toBeGreaterThan(0);
    expect(analyzed.every((f) => /MOCK ANALYSIS/.test(f.finding.notes))).toBe(true);
    // deterministic across runs
    expect(a.findings.map((f) => [f.finding.criterionKey, f.finding.result])).toEqual(
      b.findings.map((f) => [f.finding.criterionKey, f.finding.result]),
    );
    expect(b.run.runNumber).toBe(a.run.runNumber + 1);
    // creative review state is untouched by QA
    expect((await view()).attempt.reviewStatus).toBe("unreviewed");
    expect((await view()).attempt.approved).toBe(false);
  });

  it("human overrides are explicit, preserved and the latest wins; finalizing yields a separate QA status", async () => {
    const data = await h.data();
    const v = await view();
    const delivery = await qa.getDelivery(attemptId);
    const inputs = computeQaInputs({ data, view: v, delivery, now: h.clock.now })!;
    const run = await runContinuityReview({
      inputs,
      view: v,
      deps: { ...deps(), analyzer: new MockContinuityAnalyzer() },
    });
    const target = run.findings.find((f) => f.finding.criterionKey.startsWith("identity:"))!;
    await qa.addOverride({
      runId: run.run.id,
      findingId: target.finding.id,
      result: "fail",
      notes: "face drifts",
      createdBy: "u1",
      now: "2026-10-12T12:10:00.000Z",
    });
    await qa.addOverride({
      runId: run.run.id,
      findingId: target.finding.id,
      result: "pass",
      notes: "re-checked",
      createdBy: "u1",
      now: "2026-10-12T12:20:00.000Z",
    });
    const after = (await qa.getRun(run.run.id))!;
    const f = after.findings.find((x) => x.finding.id === target.finding.id)!;
    expect(f.overrides).toHaveLength(2); // history preserved
    expect(f.finding.result).toBe(target.finding.result); // the system's own result is never rewritten
    const projected = projectRun(after, inputs);
    expect(projected.findings.find((x) => x.id === target.finding.id)).toMatchObject({
      result: "pass",
      override: { result: "pass", notes: "re-checked" },
    });
    expect(projected.status).toBe("in_review");

    // a critical failure prevents "continuity approved" but rejects nothing
    await qa.addOverride({
      runId: run.run.id,
      findingId: target.finding.id,
      result: "fail",
      notes: "wrong person",
      createdBy: "u1",
      now: "2026-10-12T12:30:00.000Z",
    });
    await qa.finalizeRun(run.run.id, { by: "u1", note: "closing", now: "2026-10-12T12:31:00.000Z" });
    const closed = projectRun((await qa.getRun(run.run.id))!, inputs);
    expect(closed.summary.criticalFailures).toBeGreaterThan(0);
    expect(closed.status).toBe("failed");
    expect((await view()).attempt.reviewStatus).toBe("unreviewed");
    expect(
      approvalAdvisories({ status: closed.status, stale: false, summary: closed.summary }).join(" "),
    ).toMatch(/critical continuity failure/);
  });

  it("goes STALE when the output, production truth or a reference changes; the old run is not mutated", async () => {
    const data = await h.data();
    const v = await view();
    const delivery = await qa.getDelivery(attemptId);
    const inputs = computeQaInputs({ data, view: v, delivery, now: h.clock.now })!;
    const run = await runContinuityReview({
      inputs,
      view: v,
      deps: { ...deps(), analyzer: new MockContinuityAnalyzer() },
    });
    const frozen = JSON.stringify(await qa.getRun(run.run.id));
    expect(projectRun(run, inputs).freshness!.stale).toBe(false);

    // 1) output: a different delivery master is selected
    const switched = computeQaInputs({ data, view: v, delivery: null, now: h.clock.now })!;
    const s1 = projectRun(run, switched).freshness!;
    expect(s1.stale).toBe(true);
    expect(s1.reasons.join(" ")).toMatch(/output|conform/i);

    // 2) production truth: a continuity note on the shot changes
    const shot = data.shots.find((s) => s.id === v.attempt.shotId)!;
    const changed = {
      ...data,
      shots: data.shots.map((s) =>
        s.id === shot.id ? { ...s, continuity: { ...s.continuity, weather: "heavy snow" } } : s,
      ),
    };
    const truth = computeQaInputs({ data: changed, view: v, delivery, now: h.clock.now })!;
    expect(projectRun(run, truth).freshness!.reasons.join(" ")).toMatch(/Production truth/);

    // 3) a Look reference asset changes checksum
    const refId = inputs.references.items.find((i) => i.role === "look" || i.role === "identity")?.assetId;
    if (refId) {
      const cdata = {
        ...data,
        assets: data.assets.map((a) => (a.id === refId ? { ...a, checksum: "f".repeat(64) } : a)),
      };
      const refChanged = computeQaInputs({ data: cdata, view: v, delivery, now: h.clock.now })!;
      expect(projectRun(run, refChanged).freshness!.reasons.join(" ")).toMatch(/reference/i);
    }
    // the stored run is byte-identical after all of that
    expect(JSON.stringify(await qa.getRun(run.run.id))).toBe(frozen);
  });

  it("criteria trace back to production truth and the reference set records exactly what was used", async () => {
    const data = await h.data();
    const v = await view();
    const inputs = computeQaInputs({
      data,
      view: v,
      delivery: await qa.getDelivery(attemptId),
      now: h.clock.now,
    })!;
    const wardrobe = inputs.criteria.filter((c) => c.category === "wardrobe");
    expect(wardrobe.length).toBeGreaterThan(0);
    for (const c of wardrobe) {
      expect(c.sourceRef).toMatch(/Look/);
      expect(c.expected.length).toBeGreaterThan(0);
    }
    expect(inputs.criteria.find((c) => c.key === "aspect_ratio")!.expected).toBe("2.39:1");
    expect(inputs.references.items.length).toBeGreaterThan(0);
    expect(inputs.references.items.find((i) => i.role === "framing")).toBeTruthy();
    const again = buildReferenceSet(inputs.pkg, inputs.adaptation);
    expect(again.fingerprint).toBe(buildReferenceSet(inputs.pkg, inputs.adaptation).fingerprint);
    expect(
      buildCriteria({ pkg: inputs.pkg, adaptation: null, protectedComposition: [], deliverySize: null }).some(
        (c) => c.key === "delivery_master",
      ),
    ).toBe(false);
  });
});

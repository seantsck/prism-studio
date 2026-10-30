import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { addAttempt, item, world } from "@/domain/continuity/__tests__/cut-fixtures";
import { NOT_CALIBRATED_SEQUENCE_REASON } from "@/domain/continuity/analysis/sequence-plan";
import { defaultQaPolicy, type ProjectQaPolicy } from "@/domain/continuity/automation";
import { buildEpisodeCuts, CUT_EDGE_POLICY } from "@/domain/continuity/sequence";
import { buildEpisodeEditView } from "@/domain/edit/view";
import type { Asset, ProjectData } from "@/domain/schemas";
import { MemoryRepository } from "@/data/memory-repository";
import { continuityPage } from "@/components/views/sequence-continuity-model";
import { memoryLogger } from "@/generation/log";
import { MOCK_VIDEO_WEBM_BASE64 } from "@/generation/providers/mock-video-fixture";
import { FfmpegMediaProcessor } from "@/media/ffmpeg";
import type { MediaStorage } from "@/media/delivery";
import { MockAnalysisProvider } from "../analysis/mock-provider";
import { ContinuityAnalysisWorker } from "../analysis/worker";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import { readGeminiConfig } from "../providers/gemini/config";
import { FakeGeminiTransport, answerAll } from "../providers/gemini/fake-transport";
import {
  ensureEdgeAssets,
  previewSequenceReview,
  SequenceReviewError,
  submitSequenceReview,
} from "../sequence-review";

/**
 * Phase 3A.4D end to end, offline: a persisted Episode Edit with a real video → video cut, the manual disclosure, the
 * gates, persisted cut-edge derivation (real ffmpeg), the atomic transition run + job, and the REAL worker executing it
 * with the MOCK provider. No network, no paid call.
 */

vi.setConfig({ testTimeout: 120_000 });
const processor = new FfmpegMediaProcessor({ limits: { timeoutMs: 60_000 } });
const hasFfmpeg = await processor.available();
const media = hasFfmpeg ? describe : describe.skip;

const NOW = new Date("2026-10-30T12:00:00.000Z");
const USER = "11111111-2222-4333-8444-555555555555";
const LIMITS = { maxActivePerProject: 3, maxJobAttempts: 3 };
const PAID = { enabled: false, maxUsdPerRun: null, maxUsdPerDay: null };
const WEBM = new Uint8Array(Buffer.from(MOCK_VIDEO_WEBM_BASE64, "base64"));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function memoryStorage(): MediaStorage & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    name: "local",
    bucket: null,
    objects,
    async get(p) {
      return objects.get(p) ?? null;
    },
    async put(p, b) {
      objects.set(p, b);
    },
    async remove(p) {
      objects.delete(p);
    },
  };
}

function clipOf(data: ProjectData, storage: ReturnType<typeof memoryStorage>, code: string) {
  const attempt = addAttempt(data, code);
  const id = randomUUID();
  const asset: Asset = {
    ...data.assets[0]!,
    id,
    projectId: data.project.id,
    type: "video",
    purpose: "generation_output",
    source: "generated",
    name: `${code}.webm`,
    originalFilename: `${code}.webm`,
    storageProvider: "local",
    bucket: null,
    objectPath: `${data.project.id}/${id}/${code}.webm`,
    mime: "video/webm",
    byteSize: WEBM.length,
    checksum: sha(WEBM),
    width: 192,
    height: 108,
    durationMs: 5000,
    frameRate: 8,
    tags: [],
    metadata: {},
  } as Asset;
  data.assets.push(asset);
  storage.objects.set(asset.objectPath!, WEBM);
  return { attempt, asset };
}

async function setup(policy: Partial<ProjectQaPolicy> = { directVideoAllowed: true }) {
  const w = world();
  const storage = memoryStorage();
  const a = clipOf(w.data, storage, "1A");
  const b = clipOf(w.data, storage, "1B");
  const facts = new Map(
    [a, b].map((c) => [
      c.attempt.id,
      {
        attemptId: c.attempt.id,
        outputs: [{ assetId: c.asset.id, role: "primary" as const }],
        deliveryVersions: [],
        deliveryAssetId: null,
      },
    ]),
  );
  const repo = new MemoryRepository([w.data]);
  // the clips are real primary outputs of their attempts (what the Episode Edit validates against)
  const outputs = (repo.generation as unknown as { outputs: Array<Record<string, unknown>> }).outputs;
  for (const c of [a, b])
    outputs.push({
      id: randomUUID(),
      projectId: w.data.project.id,
      attemptId: c.attempt.id,
      assetId: c.asset.id,
      role: "primary",
      position: 0,
      provenance: {},
      createdAt: NOW.toISOString(),
    });
  const visual = (c: typeof a, inMs: number, outMs: number) => ({
    kind: "video" as const,
    attemptId: c.attempt.id,
    assetId: c.asset.id,
    sourceInMs: inMs,
    sourceOutMs: outMs,
  });
  const items = [item(w.data, "1A", visual(a, 500, 4000)), item(w.data, "1B", visual(b, 1000, 4500))];
  const edit = await repo.episodeEdits.create({
    projectId: w.data.project.id,
    episodeId: w.data.episodes[0]!.id,
    editRate: { num: 24, den: 1 },
    items: items.map((i) => ({ ...i, id: undefined })) as never,
    userId: USER,
    now: NOW.toISOString(),
  });
  const view = buildEpisodeEditView(w.data, edit, { attempts: facts, bestPointers: [] });
  const cut = buildEpisodeCuts({ data: w.data, view })[0]!;
  const qaPolicy: ProjectQaPolicy = { ...defaultQaPolicy(w.data.project.id), ...policy };
  const deps = { processor, storage, qa: repo.mediaQa, userId: USER, now: () => NOW };
  const selection = {
    transitionKey: cut.transitionKey,
    subjectFingerprint: cut.truth.subjectFingerprint,
    criteriaFingerprint: cut.truth.criteriaFingerprint,
    referenceFingerprint: cut.truth.referenceFingerprint,
  };
  return { data: w.data, repo, view, cut, qaPolicy, deps, storage, selection, a, b, edit, facts };
}

const productionGemini = (calls: { n: number }) =>
  new GeminiAnalysisProvider({
    config: readGeminiConfig({
      PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
      GEMINI_API_KEY: "test-key-not-real",
      PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
    }),
    transport: {
      async generate(req) {
        calls.n += 1;
        return new FakeGeminiTransport(answerAll("pass")).generate(req);
      },
    },
  });

media("3A.4D manual sequence review (memory, real ffmpeg, mock analyzer)", () => {
  it("the disclosure is exact and derives NOTHING", async () => {
    const s = await setup();
    const assetsBefore = s.storage.objects.size;
    const d = previewSequenceReview({
      data: s.data,
      view: s.view,
      transitionKeys: [s.cut.transitionKey],
      provider: new MockAnalysisProvider(),
      qaPolicy: s.qaPolicy,
      paid: PAID,
      spentLast24hUsd: 0,
      projectSpentLast24hUsd: 0,
      now: NOW,
    });
    expect(d.blockers).toEqual([]);
    expect(d.audio).toBe("not sent");
    const c = d.cuts[0]!;
    expect(c.left.window).toEqual({ startMs: 2000, endMs: 4000, durationMs: 2000 });
    expect(c.right.window).toEqual({ startMs: 1000, endMs: 3000, durationMs: 2000 });
    expect(c.left.still?.frame).toBe("last_displayed");
    expect(c.right.still).toEqual({ atMs: 1000, frame: "first_displayed" });
    expect(c.left.sourceAssetId).toBe(s.a.asset.id);
    expect(c.planned.length).toBeGreaterThan(0);
    expect(s.storage.objects.size).toBe(assetsBefore);
    expect(await s.repo.mediaQa.listActiveProjectAnalysisJobs(s.data.project.id)).toEqual([]);
  });

  it("direct-video consent false blocks the batch; nothing is derived or queued", async () => {
    const s = await setup({ directVideoAllowed: false });
    const before = s.storage.objects.size;
    await expect(
      submitSequenceReview({
        data: s.data,
        view: s.view,
        selections: [s.selection],
        provider: new MockAnalysisProvider(),
        qaPolicy: s.qaPolicy,
        paid: PAID,
        deps: s.deps,
        confirmed: true,
        nonce: "n1",
        limits: LIMITS,
      }),
    ).rejects.toMatchObject({ code: "not_allowed" });
    expect(s.storage.objects.size).toBe(before);
  });

  it("production Gemini: every cut family is not calibrated; nothing derived, no provider call", async () => {
    const s = await setup({ directVideoAllowed: true, externalMediaAllowed: true });
    const calls = { n: 0 };
    const gemini = productionGemini(calls);
    expect(gemini.crossCutCalibration().acceptedFamilies).toEqual([]);
    expect(gemini.analysisVersion("sequence_transition")).toBe("gemini-sequence-1");
    expect(gemini.analysisVersion("direct_video")).toBe("3");
    const before = s.storage.objects.size;
    const err = await submitSequenceReview({
      data: s.data,
      view: s.view,
      selections: [s.selection],
      provider: gemini,
      qaPolicy: s.qaPolicy,
      paid: PAID,
      deps: s.deps,
      confirmed: true,
      nonce: "n1",
      limits: LIMITS,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SequenceReviewError);
    expect((err as SequenceReviewError).code).toBe("nothing_to_analyse");
    expect((err as Error).message).toContain(NOT_CALIBRATED_SEQUENCE_REASON);
    expect(s.storage.objects.size).toBe(before);
    expect(calls.n).toBe(0);
  });

  it("stale browser truth is refused before anything is derived", async () => {
    const s = await setup();
    const before = s.storage.objects.size;
    await expect(
      submitSequenceReview({
        data: s.data,
        view: s.view,
        selections: [{ ...s.selection, subjectFingerprint: "changed" }],
        provider: new MockAnalysisProvider(),
        qaPolicy: s.qaPolicy,
        paid: PAID,
        deps: s.deps,
        confirmed: true,
        nonce: "n1",
        limits: LIMITS,
      }),
    ).rejects.toMatchObject({ code: "cut_changed" });
    expect(s.storage.objects.size).toBe(before);
  });

  it("confirmed: derives exact edge media once, freezes run + job atomically, the worker completes it", async () => {
    const s = await setup();
    const submit = (nonce: string) =>
      submitSequenceReview({
        data: s.data,
        view: s.view,
        selections: [s.selection],
        provider: new MockAnalysisProvider(),
        qaPolicy: s.qaPolicy,
        paid: PAID,
        deps: s.deps,
        confirmed: true,
        nonce,
        limits: LIMITS,
      });
    const before = s.storage.objects.size;
    const [first] = await submit("nonce-1");
    expect(first!.duplicate).toBe(false);
    expect(s.storage.objects.size).toBe(before + 4); // 2 clips + 2 stills
    const job = first!.job;
    expect(job.subjectKind).toBe("transition");
    expect(job.attemptId).toBeNull();
    const input = job.inputSnapshot;
    expect(input.subjectKind).toBe("transition");
    if (input.subjectKind !== "transition") throw new Error("narrowing");
    expect(input.analyzerVersion).toBe("mock-sequence-1");
    expect(input.rubricVersion).toBe("sequence-rubric-1");
    expect(input.edgePolicy).toBe(CUT_EDGE_POLICY.id);
    expect(input.plan.batches.every((b) => b.mode === "sequence_transition")).toBe(true);
    const ids = input.media.map((m) => m.inputId);
    expect(ids).toEqual(expect.arrayContaining(["left:clip", "right:clip", "left:last", "right:first"]));
    const leftClip = input.media.find((m) => m.inputId === "left:clip")!;
    expect(leftClip.edge).toMatchObject({ startMs: 2000, endMs: 4000, parentAssetId: s.a.asset.id });
    expect(leftClip.durationMs!).toBeLessThanOrEqual(3000);
    expect(first!.run.run.analysisStatus).toBe("queued");
    expect(first!.run.subject.transitionKey).toBe(s.cut.transitionKey);
    // n_a never planned; every planned key is an applicable semantic criterion
    const na = s.cut.criteria.filter((c) => c.applicability === "n_a").map((c) => c.key);
    expect(input.plan.batches.flatMap((b) => b.criterionKeys).some((k) => na.includes(k))).toBe(false);

    // the SAME confirmed submission replays (no duplicate media, run or job)
    const [again] = await submit("nonce-1");
    expect(again!.duplicate).toBe(true);
    expect(again!.job.id).toBe(job.id);
    expect(s.storage.objects.size).toBe(before + 4);

    // the real worker executes it (mock provider, no network)
    const worker = new ContinuityAnalysisWorker({
      store: s.repo.mediaQa,
      providers: new Map([["mock-continuity", new MockAnalysisProvider()]]),
      media: { read: async (ref) => (ref.objectPath ? s.storage.get(ref.objectPath) : null) },
      processor,
      logger: memoryLogger(),
      paid: PAID,
      clock: () => NOW,
      heartbeatMs: 0,
    });
    await worker.tick();
    const done = (await s.repo.mediaQa.getAnalysisJob(job.id))!;
    expect(done.status).toBe("succeeded");
    expect(done.actualCostUsd).toBe(0);
    const run = (await s.repo.mediaQa.getTransitionRun(first!.run.run.id))!;
    expect(run.run.analysisStatus).toBe("complete");
    const findings = run.findings.map((f) => f.finding);
    const semantic = findings.filter((f) => f.resultSource === "analyzer");
    expect(semantic.length).toBe(input.plan.batches.flatMap((b) => b.criterionKeys).length);
    for (const f of semantic) {
      const items = (f.evidence as { items: Array<{ input: string }> }).items;
      expect(items.some((e) => e.input.startsWith("left:"))).toBe(true);
      expect(items.some((e) => e.input.startsWith("right:"))).toBe(true);
    }
    // n_a and deterministic findings are exactly as frozen
    for (const k of na) expect(findings.find((f) => f.criterionKey === k)!.result).toBe("n_a");

    // ── Supervisor projection of the run (read-only) ──
    const page = (await s.repo.loadProject(s.data.project.slug))!;
    const runsMap = new Map([[s.cut.transitionKey, [run]]]);
    const media = { attempts: s.facts, bestPointers: [] };
    const vm = continuityPage({
      data: page,
      episode: page.episodes[0]!,
      edit: s.edit,
      media,
      transitionRuns: runsMap,
    });
    const row = vm.rows[0]!;
    expect(row.state).not.toBe("no_sequence_qa");
    expect(row.runs[0]).toMatchObject({ freshness: "current", status: "Complete", mock: true });
    expect(row.runs[0]!.edgeMedia.map((e) => e.inputId).sort()).toEqual([
      "left:clip",
      "left:last",
      "right:clip",
      "right:first",
    ]);
    expect(row.runs[0]!.edgeMedia.every((e) => e.url)).toBe(true);
    const analysed = row.semantic.filter((f) => f.analyzed);
    expect(analysed.length).toBe(semantic.length);
    for (const f of analysed) {
      expect(f.analyzed!.mock).toBe(true);
      expect(f.evidence!.some((e) => e.side === "left")).toBe(true);
      expect(f.evidence!.some((e) => e.side === "right")).toBe(true);
      // Prism's mapping: clip-local -> source -> edit time
      expect(f.evidence!.find((e) => e.input === "left:clip")!.where).toMatch(/clip .* source .* edit /);
    }
    // deterministic criteria still come from the CURRENT projection
    expect(row.checks.concat(row.attention).every((f) => !f.analyzed)).toBe(true);

    // a trim that moves the left edge makes the run STALE (semantic findings back to unchecked)
    const trimmed = {
      ...s.edit,
      items: s.edit.items.map((i, n) =>
        n === 0 && i.visual.kind === "video" ? { ...i, visual: { ...i.visual, sourceOutMs: 3800 } } : i,
      ),
    };
    const stale = continuityPage({
      data: page,
      episode: page.episodes[0]!,
      edit: trimmed,
      media,
      transitionRuns: runsMap,
    });
    expect(stale.rows[0]!.state).toBe("sequence_stale");
    expect(stale.rows[0]!.runs[0]!.freshness).toBe("stale");
    expect(stale.rows[0]!.semantic.every((f) => !f.analyzed)).toBe(true);
  });

  it("edge derivation identity: reused; trim / parent checksum change it; unrelated edit facts do not", async () => {
    const s = await setup();
    const side = s.cut.left;
    const first = await ensureEdgeAssets({ side, which: "left", assets: s.data.assets, deps: s.deps });
    expect(first.clip.created).toBe(true);
    expect(first.clip.derivation.operation).toBe("trim");
    expect(first.still.derivation.operation).toBe("frame_extract");
    expect(first.clip.derivation.parentAssetId).toBe(s.a.asset.id);
    expect(first.clip.derivation.attemptId).toBeNull();
    expect(first.clip.asset.checksum).toBe(sha((await s.storage.get(first.clip.asset.objectPath!))!));
    const again = await ensureEdgeAssets({ side, which: "left", assets: s.data.assets, deps: s.deps });
    expect(again.clip.created).toBe(false);
    expect(again.clip.asset.id).toBe(first.clip.asset.id);
    expect(again.still.asset.id).toBe(first.still.asset.id);
    // an unrelated edit fact (item id / position) is not part of the identity
    const moved = { ...side, itemId: "another-item", index: 7 };
    expect(
      (await ensureEdgeAssets({ side: moved, which: "left", assets: s.data.assets, deps: s.deps })).clip.asset
        .id,
    ).toBe(first.clip.asset.id);
    // a trim boundary change is a different derivation
    const trimmed = { ...side, window: { ...side.window!, startMs: 2500 } };
    const t = await ensureEdgeAssets({ side: trimmed, which: "left", assets: s.data.assets, deps: s.deps });
    expect(t.clip.asset.id).not.toBe(first.clip.asset.id);
    // a different parent checksum is a different identity
    const p = side.picture;
    if (p.kind !== "video") throw new Error("narrowing");
    const reparented = { ...side, picture: { ...p, assetChecksum: "0".repeat(64) } };
    const r = await ensureEdgeAssets({
      side: reparented,
      which: "left",
      assets: s.data.assets,
      deps: s.deps,
    });
    expect(r.clip.derivation.derivationKey).not.toBe(first.clip.derivation.derivationKey);
  });

  it("a transition job frozen for another sequence version fails before any transport call", async () => {
    const s = await setup();
    const [r] = await submitSequenceReview({
      data: s.data,
      view: s.view,
      selections: [s.selection],
      provider: new MockAnalysisProvider(),
      qaPolicy: s.qaPolicy,
      paid: PAID,
      deps: s.deps,
      confirmed: true,
      nonce: "v",
      limits: LIMITS,
    });
    const inner = s.repo.mediaQa as unknown as {
      jobs: Map<string, { inputSnapshot: { analyzerVersion: string } }>;
    };
    inner.jobs.get(r!.job.id)!.inputSnapshot.analyzerVersion = "mock-sequence-0";
    let calls = 0;
    const provider = new MockAnalysisProvider();
    const spy = vi.spyOn(provider, "analyzeBatch").mockImplementation(async () => {
      calls += 1;
      throw new Error("must not run");
    });
    const worker = new ContinuityAnalysisWorker({
      store: s.repo.mediaQa,
      providers: new Map([["mock-continuity", provider]]),
      media: { read: async () => null },
      logger: memoryLogger(),
      paid: PAID,
      clock: () => NOW,
      heartbeatMs: 0,
    });
    await worker.tick();
    const failed = (await s.repo.mediaQa.getAnalysisJob(r!.job.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.lastErrorCode).toBe("analyzer_version_mismatch");
    expect(calls).toBe(0);
    spy.mockRestore();
  });
});

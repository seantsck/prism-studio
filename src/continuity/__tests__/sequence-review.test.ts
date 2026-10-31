import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AnalysisSpendPolicy } from "@/domain/continuity/analysis/cost";
import { addAttempt, item, world } from "@/domain/continuity/__tests__/cut-fixtures";
import { NOT_CALIBRATED_SEQUENCE_REASON } from "@/domain/continuity/analysis/sequence-plan";
import { defaultQaPolicy, type ProjectQaPolicy } from "@/domain/continuity/automation";
import { buildEpisodeCuts, CUT_EDGE_POLICY, type CutTransition } from "@/domain/continuity/sequence";
import type { MediaProcessor } from "@/media/types";
import { buildEpisodeEditView } from "@/domain/edit/view";
import type { Asset, ProjectData } from "@/domain/schemas";
import { MemoryRepository } from "@/data/memory-repository";
import { continuityPage } from "@/components/views/sequence-continuity-model";
import { memoryLogger } from "@/generation/log";
import { MOCK_VIDEO_WEBM_BASE64 } from "@/generation/providers/mock-video-fixture";
import { FfmpegMediaProcessor } from "@/media/ffmpeg";
import type { MediaStorage } from "@/media/delivery";
import { MockAnalysisProvider } from "../analysis/mock-provider";
import type { ContinuityAnalysisProvider } from "../analysis/provider";
import { newTransitionRun } from "../sequence-runs";
import type { TransitionRunView } from "@/data/media-qa-repository";
import { ContinuityAnalysisWorker } from "../analysis/worker";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import { readGeminiConfig } from "../providers/gemini/config";
import { FakeGeminiTransport, answerAll } from "../providers/gemini/fake-transport";
import {
  ensureEdgeAssets,
  findEdgeAssets,
  previewSequenceReview,
  SequenceReviewError,
  submitSequenceReview,
  type SequenceSelection,
} from "../sequence-review";

const NOT_SENT: SequenceSelection["transfer"] = { left: "not_sent", right: "not_sent" };

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

async function setup(
  policy: Partial<ProjectQaPolicy> = { directVideoAllowed: true },
  opts: { processor?: MediaProcessor } = {},
) {
  const w = world();
  const storage = memoryStorage();
  const a = clipOf(w.data, storage, "1A");
  const b = clipOf(w.data, storage, "1B");
  const c3 = clipOf(w.data, storage, "1C");
  const facts = new Map(
    [a, b, c3].map((c) => [
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
  for (const c of [a, b, c3])
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
  const items = [
    item(w.data, "1A", visual(a, 500, 4000)),
    item(w.data, "1B", visual(b, 1000, 4500)),
    item(w.data, "1C", visual(c3, 0, 3000)),
  ];
  const edit = await repo.episodeEdits.create({
    projectId: w.data.project.id,
    episodeId: w.data.episodes[0]!.id,
    editRate: { num: 24, den: 1 },
    items: items.map((i) => ({ ...i, id: undefined })) as never,
    userId: USER,
    now: NOW.toISOString(),
  });
  const view = buildEpisodeEditView(w.data, edit, { attempts: facts, bestPointers: [] });
  const [cut, cut2] = buildEpisodeCuts({ data: w.data, view }) as [CutTransition, CutTransition];
  const qaPolicy: ProjectQaPolicy = { ...defaultQaPolicy(w.data.project.id), ...policy };
  const deps = {
    processor: opts.processor ?? processor,
    storage,
    qa: repo.mediaQa,
    userId: USER,
    now: () => NOW,
  };
  const selectionOf = (
    c: CutTransition,
    transfer: SequenceSelection["transfer"] = NOT_SENT,
  ): SequenceSelection => ({
    transitionKey: c.transitionKey,
    subjectFingerprint: c.truth.subjectFingerprint,
    criteriaFingerprint: c.truth.criteriaFingerprint,
    referenceFingerprint: c.truth.referenceFingerprint,
    transfer,
  });
  const selection = selectionOf(cut);
  return {
    data: w.data,
    repo,
    view,
    cut,
    cut2,
    qaPolicy,
    deps,
    storage,
    selection,
    selectionOf,
    a,
    b,
    edit,
    facts,
  };
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
        confirmedMaxUsd: null,
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
      confirmedMaxUsd: null,
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
        confirmedMaxUsd: null,
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
        confirmedMaxUsd: null,
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
      confirmedMaxUsd: null,
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

// ───────────────────────── 3A.4D technical-review remediation ─────────────────────────

type Setup = Awaited<ReturnType<typeof setup>>;

const mockSubmit = (
  s: Setup,
  o: {
    selections: SequenceSelection[];
    nonce: string;
    max?: number;
    view?: Setup["view"];
    provider?: ContinuityAnalysisProvider;
    paid?: AnalysisSpendPolicy;
    confirmedMaxUsd?: number | null;
  },
) =>
  submitSequenceReview({
    data: s.data,
    view: o.view ?? s.view,
    selections: o.selections,
    provider: o.provider ?? new MockAnalysisProvider(),
    qaPolicy: s.qaPolicy,
    paid: o.paid ?? PAID,
    deps: s.deps,
    confirmed: true,
    confirmedMaxUsd: o.confirmedMaxUsd ?? null,
    nonce: o.nonce,
    limits: { maxActivePerProject: o.max ?? 3, maxJobAttempts: 3 },
  });

const mockWorker = (s: Setup, provider: ContinuityAnalysisProvider = new MockAnalysisProvider()) =>
  new ContinuityAnalysisWorker({
    store: s.repo.mediaQa,
    providers: new Map([[provider.id, provider]]),
    media: { read: async (ref) => (ref.objectPath ? s.storage.get(ref.objectPath) : null) },
    processor,
    logger: memoryLogger(),
    paid: PAID,
    clock: () => NOW,
    heartbeatMs: 0,
  });

const errOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as SequenceReviewError,
  );

media("3A.4D batch atomicity and shared capacity", () => {
  it("over capacity (2 new > 1 free): the WHOLE batch is refused before any derivation", async () => {
    const s = await setup();
    const before = s.storage.objects.size;
    const e = await errOf(
      mockSubmit(s, { selections: [s.selectionOf(s.cut), s.selectionOf(s.cut2)], nonce: "n", max: 1 }),
    );
    expect(e?.code).toBe("limit");
    expect(e?.message).toMatch(/needs 2 analysis slot\(s\) but the project has 1 free/);
    expect(s.storage.objects.size).toBe(before);
    expect(await s.repo.mediaQa.listActiveProjectAnalysisJobs(s.data.project.id)).toEqual([]);
  });

  it("active 1 + 2 new > max 2: refused whole, nothing derived for it", async () => {
    const s = await setup();
    await mockSubmit(s, { selections: [s.selectionOf(s.cut)], nonce: "first" });
    const before = s.storage.objects.size;
    const e = await errOf(
      mockSubmit(s, { selections: [s.selectionOf(s.cut), s.selectionOf(s.cut2)], nonce: "second", max: 2 }),
    );
    expect(e?.code).toBe("limit");
    expect(s.storage.objects.size).toBe(before);
    expect((await s.repo.mediaQa.listActiveProjectAnalysisJobs(s.data.project.id)).length).toBe(1);
  });

  it("an exact replay of the whole batch succeeds even with no free slot, in selection order", async () => {
    const s = await setup();
    const sel = [s.selectionOf(s.cut2), s.selectionOf(s.cut)];
    const first = await mockSubmit(s, { selections: sel, nonce: "same" });
    const again = await mockSubmit(s, { selections: sel, nonce: "same", max: 0 });
    expect(again.map((r) => r.duplicate)).toEqual([true, true]);
    expect(again.map((r) => r.job.id)).toEqual(first.map((r) => r.job.id));
    expect(again[0]!.run.subject.transitionKey).toBe(s.cut2.transitionKey);
  });

  it("replay + one new job: only the new job takes capacity", async () => {
    const s = await setup();
    await mockSubmit(s, { selections: [s.selectionOf(s.cut)], nonce: "mix" });
    const out = await mockSubmit(s, {
      selections: [s.selectionOf(s.cut), s.selectionOf(s.cut2)],
      nonce: "mix",
      max: 2,
    });
    expect(out.map((r) => r.duplicate)).toEqual([true, false]);
  });

  it("the repository re-checks capacity at commit: all or none (no partial run/job)", async () => {
    const s = await setup();
    const [x] = await mockSubmit(s, { selections: [s.selectionOf(s.cut)], nonce: "x" });
    const qa = s.repo.mediaQa;
    const runsBefore = (await qa.listTransitionRuns(s.data.project.id, s.cut2.transitionKey)).length;
    // a batch of two NEW entries against one free slot: refused, and neither is written
    const view = s.view;
    const mk = (cut: CutTransition, key: string) => ({
      limits: { maxActivePerProject: 2 },
      run: {
        ...newTransitionRun({ cut, view, userId: USER, now: NOW.toISOString() }),
        analysisStatus: "queued" as const,
      },
      job: {
        idempotencyKey: key,
        analyzer: "mock-continuity",
        model: "mock",
        snapshot: x!.job.inputSnapshot,
        inputAssetIds: [],
        maxAttempts: 3,
        estimate: { maxUsd: 0, expectedUsd: 0, usage: {}, pricingVersion: "free" },
      },
    });
    const e = await qa
      .createTransitionBatchWithJobs({
        entries: [mk(s.cut2, "k1"), mk(s.cut2, "k2")],
        limits: { maxActivePerProject: 2 },
      })
      .then(
        () => null,
        (err: unknown) => err as Error,
      );
    expect(e?.message).toMatch(/Nothing was queued/);
    expect((await qa.listTransitionRuns(s.data.project.id, s.cut2.transitionKey)).length).toBe(runsBefore);
    expect((await qa.listActiveProjectAnalysisJobs(s.data.project.id)).length).toBe(1);
  });

  it("a LATER cut's derived media failing validation queues NONE of the batch (Assets stay as derivations)", async () => {
    let calls = 0;
    const flaky: MediaProcessor = Object.assign(Object.create(processor) as MediaProcessor, {
      extractWindow: async (bytes: Uint8Array, start: number, end: number) =>
        // the third clip (cut 2's left side) comes out longer than the 3 s cut-edge bound
        ++calls === 3 ? processor.extractWindow(bytes, 0, 4000) : processor.extractWindow(bytes, start, end),
    });
    const s = await setup({ directVideoAllowed: true }, { processor: flaky });
    const e = await errOf(
      mockSubmit(s, { selections: [s.selectionOf(s.cut), s.selectionOf(s.cut2)], nonce: "m" }),
    );
    expect(e?.code).toBe("media");
    for (const c of [s.cut, s.cut2])
      expect(await s.repo.mediaQa.listTransitionRuns(s.data.project.id, c.transitionKey)).toEqual([]);
    expect(await s.repo.mediaQa.listActiveProjectAnalysisJobs(s.data.project.id)).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(3); // media WAS processed: honest, they are reusable derivations
  });
});

media("3A.4D exact transfer disclosure", () => {
  const gemini = (calls: { n: number }) =>
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
      testCrossCutCalibration: {
        version: "test-only",
        acceptedFamilies: ["screen_direction", "axis", "lighting"],
      },
    });
  const paidOn = { enabled: true, maxUsdPerRun: 5, maxUsdPerDay: 50 };
  const consent = {
    directVideoAllowed: true,
    externalMediaAllowed: true,
    maxCostPerRunUsd: 5,
    maxCostPerDayUsd: 50,
  };

  it("disclosed provider_file but the exact clip is inline: nothing queued, no transport call", async () => {
    const s = await setup(consent);
    const calls = { n: 0 };
    const e = await errOf(
      mockSubmit(s, {
        selections: [s.selectionOf(s.cut, { left: "provider_file", right: "provider_file" })],
        nonce: "t",
        provider: gemini(calls),
        paid: paidOn,
        confirmedMaxUsd: 5,
      }),
    );
    expect(e?.code).toBe("transfer_changed");
    expect(e?.message).toMatch(/review the disclosure again/);
    expect(await s.repo.mediaQa.listActiveProjectAnalysisJobs(s.data.project.id)).toEqual([]);
    expect(calls.n).toBe(0);
  });

  it("disclosed inline and the exact clips are inline: queued, the approved method frozen; no transport", async () => {
    const s = await setup(consent);
    const calls = { n: 0 };
    const [r] = await mockSubmit(s, {
      selections: [s.selectionOf(s.cut, { left: "inline", right: "inline" })],
      nonce: "t2",
      provider: gemini(calls),
      paid: paidOn,
      confirmedMaxUsd: 5,
    });
    const input = r!.job.inputSnapshot;
    expect(input.media.find((m) => m.inputId === "left:clip")!.edge!.transfer).toBe("inline");
    expect(calls.n).toBe(0);
  });

  it("a final cost above the confirmed ceiling queues nothing", async () => {
    const s = await setup(consent);
    const e = await errOf(
      mockSubmit(s, {
        selections: [s.selectionOf(s.cut, { left: "inline", right: "inline" })],
        nonce: "t3",
        provider: gemini({ n: 0 }),
        paid: paidOn,
        confirmedMaxUsd: 0.000001,
      }),
    );
    expect(e?.code).toBe("cost_changed");
    expect(await s.repo.mediaQa.listActiveProjectAnalysisJobs(s.data.project.id)).toEqual([]);
  });

  it("the mock never transfers anything (not_sent) and the disclosure says so", async () => {
    const s = await setup();
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
    expect([d.cuts[0]!.left.transfer, d.cuts[0]!.right.transfer]).toEqual(["not_sent", "not_sent"]);
  });

  it("after a derivation the disclosure is EXACT (read-only lookup by derivation key)", async () => {
    const s = await setup(consent);
    await ensureEdgeAssets({ side: s.cut.left, which: "left", assets: s.data.assets, deps: s.deps });
    await ensureEdgeAssets({ side: s.cut.right, which: "right", assets: s.data.assets, deps: s.deps });
    const before = s.storage.objects.size;
    const edge = await findEdgeAssets({
      cut: s.cut,
      processor,
      qa: s.repo.mediaQa,
      projectId: s.data.project.id,
    });
    expect(edge).not.toBeNull();
    const d = previewSequenceReview({
      data: s.data,
      view: s.view,
      transitionKeys: [s.cut.transitionKey],
      provider: gemini({ n: 0 }),
      qaPolicy: s.qaPolicy,
      paid: paidOn,
      spentLast24hUsd: 0,
      projectSpentLast24hUsd: 0,
      now: NOW,
      edges: new Map([[s.cut.transitionKey, edge!]]),
    });
    expect(d.cuts[0]!.left.transferBasis).toBe("exact");
    expect(d.cuts[0]!.left.clipBytes).toBe(edge!.left.clip.byteSize);
    expect(s.storage.objects.size).toBe(before);
  });
});

media("3A.4D frozen sequence input + edge file names", () => {
  it("a malformed sided input (left:clip claiming the right side) fails before any transport", async () => {
    const s = await setup();
    const [r] = await mockSubmit(s, { selections: [s.selection], nonce: "side" });
    const inner = s.repo.mediaQa as unknown as {
      jobs: Map<string, { inputSnapshot: { media: Array<{ inputId: string; side?: string }> } }>;
    };
    inner.jobs.get(r!.job.id)!.inputSnapshot.media.find((m) => m.inputId === "left:clip")!.side = "right";
    const provider = new MockAnalysisProvider();
    const spy = vi.spyOn(provider, "analyzeBatch");
    await mockWorker(s, provider).tick();
    const failed = (await s.repo.mediaQa.getAnalysisJob(r!.job.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.lastErrorCode).toBe("sequence_input_invalid");
    expect(spy).not.toHaveBeenCalled();
  });

  it("a WebM fallback edge clip is stored as .webm (MIME and path), an MP4 as .mp4; identity unchanged", async () => {
    const webm: MediaProcessor = Object.assign(Object.create(processor) as MediaProcessor, {
      extractWindow: async () => ({
        bytes: WEBM,
        mime: "video/webm",
        extension: "webm",
        probe: await processor.probe(WEBM),
      }),
    });
    const w = await setup({ directVideoAllowed: true }, { processor: webm });
    const a = await ensureEdgeAssets({
      side: w.cut.left,
      which: "left",
      assets: w.data.assets,
      deps: w.deps,
    });
    expect(a.clip.asset.mime).toBe("video/webm");
    expect(a.clip.asset.name.endsWith(".webm")).toBe(true);
    expect(a.clip.asset.objectPath!.endsWith(".webm")).toBe(true);
    const m = await setup();
    const b = await ensureEdgeAssets({
      side: m.cut.left,
      which: "left",
      assets: m.data.assets,
      deps: m.deps,
    });
    const ext = b.clip.asset.mime === "video/mp4" ? ".mp4" : ".webm";
    expect(b.clip.asset.name.endsWith(ext)).toBe(true);
    expect(b.clip.asset.objectPath!.endsWith(ext)).toBe(true);
    // the file name is not part of the derivation identity
    expect(a.clip.derivation.derivationKey).toBe(b.clip.derivation.derivationKey);
  });
});

media("3A.4D current-run selection (newest CURRENT run, not history[0])", () => {
  const project = async (s: Setup, edit: Setup["edit"], runs: TransitionRunView[]) => {
    const page = (await s.repo.loadProject(s.data.project.slug))!;
    return continuityPage({
      data: page,
      episode: page.episodes[0]!,
      edit,
      media: { attempts: s.facts, bestPointers: [] },
      transitionRuns: new Map([[s.cut.transitionKey, runs]]),
    }).rows[0]!;
  };
  const history = async (s: Setup) =>
    [...(await s.repo.mediaQa.listTransitionRuns(s.data.project.id, s.cut.transitionKey))].sort(
      (x, y) => y.run.runNumber - x.run.runNumber,
    );

  it("truth A → run #1, truth B → run #2, back to A: run #1 is current again and drives the projection", async () => {
    const s = await setup();
    await mockSubmit(s, { selections: [s.selection], nonce: "A" });
    await mockWorker(s).tick();
    const editB = {
      ...s.edit,
      items: s.edit.items.map((i, n) =>
        n === 0 && i.visual.kind === "video" ? { ...i, visual: { ...i.visual, sourceOutMs: 3800 } } : i,
      ),
    };
    const viewB = buildEpisodeEditView(s.data, editB, { attempts: s.facts, bestPointers: [] });
    const cutB = buildEpisodeCuts({ data: s.data, view: viewB })[0]!;
    await mockSubmit(s, { selections: [s.selectionOf(cutB)], nonce: "B", view: viewB });
    await mockWorker(s).tick();
    const runs = await history(s);
    expect(runs.map((r) => r.run.runNumber)).toEqual([2, 1]);

    const atA = await project(s, s.edit, runs);
    expect(atA.runs.map((r) => [r.runNumber, r.freshness])).toEqual([
      [2, "stale"],
      [1, "current"],
    ]);
    expect(atA.state).not.toBe("sequence_stale");
    expect(atA.state).not.toBe("no_sequence_qa");
    expect(atA.semantic.some((f) => f.analyzed)).toBe(true);

    const atB = await project(s, editB, runs);
    expect(atB.runs.map((r) => [r.runNumber, r.freshness])).toEqual([
      [2, "current"],
      [1, "stale"],
    ]);
    expect(atB.semantic.some((f) => f.analyzed)).toBe(true);
  });

  it("two runs of the same current truth: the NEWEST wins, even when it failed (no fallback to an older success)", async () => {
    const s = await setup();
    await mockSubmit(s, { selections: [s.selection], nonce: "ok" });
    await mockWorker(s).tick();
    const [r2] = await mockSubmit(s, { selections: [s.selection], nonce: "fails" });
    const inner = s.repo.mediaQa as unknown as {
      jobs: Map<string, { inputSnapshot: { analyzerVersion: string } }>;
    };
    inner.jobs.get(r2!.job.id)!.inputSnapshot.analyzerVersion = "mock-sequence-0";
    await mockWorker(s).tick();
    const row = await project(s, s.edit, await history(s));
    expect(row.runs.map((r) => [r.runNumber, r.status, r.freshness])).toEqual([
      [2, "Failed", "current"],
      [1, "Complete", "current"],
    ]);
    expect(row.semantic.some((f) => f.analyzed)).toBe(false);
    expect(row.semantic.some((f) => /run failed/.test(f.reason))).toBe(true);
  });
});

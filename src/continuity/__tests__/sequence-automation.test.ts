import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addAttempt, item, world } from "@/domain/continuity/__tests__/cut-fixtures";
import { defaultQaPolicy, type ProjectQaPolicy } from "@/domain/continuity/automation";
import { buildEpisodeCuts } from "@/domain/continuity/sequence";
import { emptySettlementClock, SEQUENCE_SETTLE_MS } from "@/domain/continuity/sequence-automation";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SequenceAutomationPanel } from "@/components/views/sequence-continuity-view";
import { buildEpisodeEditView } from "@/domain/edit/view";
import type { Asset, ProjectData } from "@/domain/schemas";
import { MemoryRepository } from "@/data/memory-repository";
import { MOCK_VIDEO_WEBM_BASE64 } from "@/generation/providers/mock-video-fixture";
import { FfmpegMediaProcessor } from "@/media/ffmpeg";
import type { MediaStorage } from "@/media/delivery";
import { buildShotContext } from "@/domain/context";
import { deterministicAutomationKey } from "@/domain/continuity/automation";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { MockAnalysisProvider } from "../analysis/mock-provider";
import type { ContinuityAnalysisProvider } from "../analysis/provider";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import { readGeminiConfig } from "../providers/gemini/config";
import { FakeGeminiTransport, answerAll } from "../providers/gemini/fake-transport";
import {
  AUTO_SEQUENCE_QUEUED_NOTE,
  loadSequenceAutoState,
  reconcileSequenceQa,
  sequenceAutoView,
  type SequenceAutoDeps,
} from "../sequence-automation";
import { sequenceIdempotencyKey, submitSequenceReview } from "../sequence-review";

/**
 * Phase 3A.4F end to end, offline: a persisted edit with real video cuts, settling through the memory clocks, the pure
 * plan, real ffmpeg derivation, the atomic wave. A fake Gemini transport only; nothing can leave the process.
 */
vi.setConfig({ testTimeout: 120_000 });
// the panel's client pieces and the view's server actions are not under test (and need a Next runtime)
vi.mock("@/components/continuity/sequence-automation", () => ({
  SequenceAutoReconciler: () => null,
  SequenceJobPoller: () => null,
}));
vi.mock("@/server/episode-edit-actions", () => ({ clearCutIntent: vi.fn(), setCutIntent: vi.fn() }));
vi.mock("@/server/sequence-review-actions", () => ({ startSequenceReview: vi.fn() }));
vi.mock("@/components/action-form", () => ({ ActionForm: () => null }));
afterEach(() => vi.useRealTimers());

const processor = new FfmpegMediaProcessor({ limits: { timeoutMs: 60_000 } });
const media = (await processor.available()) ? describe : describe.skip;
const USER = "11111111-2222-4333-8444-555555555555";
const WEBM = new Uint8Array(Buffer.from(MOCK_VIDEO_WEBM_BASE64, "base64"));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const CODES = ["2B", "2C", "2D", "2E"];
const NOT_PAID = { enabled: false, maxUsdPerRun: null, maxUsdPerDay: null };
const PAID = { enabled: true, maxUsdPerRun: 1, maxUsdPerDay: 50 };

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
  const asset = {
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

const standing = (projectId: string, patch: Partial<ProjectQaPolicy> = {}): ProjectQaPolicy => ({
  ...defaultQaPolicy(projectId),
  analyzer: "mock-continuity",
  externalMediaAllowed: true,
  directVideoAllowed: true,
  maxCostPerRunUsd: 1,
  maxCostPerDayUsd: 50,
  sequenceSemanticMode: "automatic",
  ...patch,
});

const gemini = (calls: { n: number } = { n: 0 }, env: Record<string, string> = {}) =>
  new GeminiAnalysisProvider({
    config: readGeminiConfig({
      PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
      GEMINI_API_KEY: "test-key-not-real",
      PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
      ...env,
    }),
    transport: {
      async generate(req: never) {
        calls.n += 1;
        return new FakeGeminiTransport(answerAll("pass")).generate(req);
      },
    } as never,
  });

async function setup(
  opts: { policy?: Partial<ProjectQaPolicy>; provider?: ContinuityAnalysisProvider } = {},
) {
  const w = world();
  const storage = memoryStorage();
  const clips = CODES.map((c) => clipOf(w.data, storage, c));
  const facts = new Map(
    clips.map((c) => [
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
  const outputs = (repo.generation as unknown as { outputs: Array<Record<string, unknown>> }).outputs;
  for (const c of clips)
    outputs.push({
      id: randomUUID(),
      projectId: w.data.project.id,
      attemptId: c.attempt.id,
      assetId: c.asset.id,
      role: "primary",
      position: 0,
      provenance: {},
      createdAt: new Date().toISOString(),
    });
  const projectId = w.data.project.id;
  const live = () => (repo as unknown as { projects: Map<string, ProjectData> }).projects.get(projectId)!;
  const data = live();
  for (const [i, c] of clips.entries()) {
    data.attempts.find((a) => a.id === c.attempt.id);
    void i;
  }
  const items = clips.map((c, i) =>
    item(data, CODES[i]!, {
      kind: "video",
      attemptId: c.attempt.id,
      assetId: c.asset.id,
      sourceInMs: 500,
      sourceOutMs: 4500,
    }),
  );
  const edit = await repo.episodeEdits.create({
    projectId,
    episodeId: data.episodes[0]!.id,
    editRate: { num: 24, den: 1 },
    items: items.map((i) => ({ ...i, id: undefined })) as never,
    userId: USER,
    now: new Date().toISOString(),
  });
  const viewOf = async () =>
    buildEpisodeEditView(live(), (await repo.episodeEdits.get(projectId, edit.id))!, {
      attempts: facts,
      bestPointers: [],
    });
  const provider = opts.provider ?? new MockAnalysisProvider();
  const policy = standing(projectId, opts.policy);
  const spy = {
    extractWindow: vi.spyOn(processor, "extractWindow"),
    extractFrame: vi.spyOn(processor, "extractFrame"),
  };
  spy.extractWindow.mockClear();
  spy.extractFrame.mockClear();
  const auto = (patch: Partial<SequenceAutoDeps> = {}): SequenceAutoDeps => ({
    qa: repo.mediaQa,
    edits: repo.episodeEdits,
    providers: new Map([[provider.id, provider]]),
    availability: [{ id: provider.id, usable: true, kind: provider.kind, missingConfig: [] }],
    paid: PAID,
    limits: { maxActivePerProject: 3, maxJobAttempts: 3 },
    ...patch,
  });
  const settled = () => new Date(Date.now() + SEQUENCE_SETTLE_MS + 1000);
  const deps = (now: Date) => ({ processor, storage, qa: repo.mediaQa, userId: USER, now: () => now });
  const reconcile = async (
    o: { now?: Date; policy?: Partial<ProjectQaPolicy>; auto?: Partial<SequenceAutoDeps> } = {},
  ) => {
    const now = o.now ?? settled();
    return reconcileSequenceQa({
      data: live(),
      view: await viewOf(),
      policy: { ...policy, ...o.policy },
      auto: auto(o.auto),
      deps: deps(now),
      now,
    });
  };
  const state = async (o: { now?: Date; policy?: Partial<ProjectQaPolicy> } = {}) =>
    loadSequenceAutoState({
      data: live(),
      view: await viewOf(),
      policy: { ...policy, ...o.policy },
      deps: auto(),
      now: o.now ?? settled(),
    });
  const jobs = () => repo.mediaQa.listEditTransitionAnalysisJobs(projectId, edit.id);
  return {
    repo,
    storage,
    projectId,
    edit,
    live,
    viewOf,
    policy,
    provider,
    reconcile,
    state,
    jobs,
    spy,
    settled,
    deps,
    auto,
    cuts: async () => buildEpisodeCuts({ data: live(), view: await viewOf() }),
  };
}
type World = Awaited<ReturnType<typeof setup>>;

const expectNothingHappened = async (s: World, objects = 4) => {
  expect(await s.jobs()).toEqual([]);
  expect(s.spy.extractWindow).not.toHaveBeenCalled();
  expect(s.spy.extractFrame).not.toHaveBeenCalled();
  expect(s.storage.objects.size).toBe(objects);
};

/** A prior job in the shared stores (active or costed), as a Shot QA submission would leave it. */
function priorJob(s: World, o: { status?: string; kind: "attempt" | "transition"; usd?: number }) {
  const qa = s.repo.mediaQa as unknown as {
    jobs: Map<string, Record<string, unknown>>;
    costs: Array<Record<string, unknown>>;
  };
  const id = randomUUID();
  qa.jobs.set(id, {
    id,
    projectId: s.projectId,
    runId: randomUUID(),
    subjectKind: o.kind,
    attemptId: o.kind === "attempt" ? randomUUID() : null,
    status: o.status ?? "queued",
    idempotencyKey: randomUUID(),
    createdAt: new Date().toISOString(),
  });
  if (o.usd != null)
    qa.costs.push({
      id: randomUUID(),
      projectId: s.projectId,
      jobId: id,
      kind: "estimated",
      amountUsd: o.usd,
      recordedAt: new Date().toISOString(),
    });
}

media("standing authorisation: nothing happens without all of it", () => {
  it("default mode off: zero derivations, jobs and provider calls", async () => {
    const calls = { n: 0 };
    const s = await setup({ provider: gemini(calls), policy: { sequenceSemanticMode: "off" } });
    expect((await s.reconcile()).outcome).toBe("off");
    await expectNothingHappened(s);
    expect(calls.n).toBe(0);
  });

  it("the real default policy opts into nothing", async () => {
    const s = await setup();
    const r = await s.reconcile({ policy: defaultQaPolicy(s.projectId) });
    expect(r.outcome).toBe("off");
    await expectNothingHappened(s);
  });

  it("Shot automatic alone: zero Sequence jobs", async () => {
    const s = await setup({ policy: { sequenceSemanticMode: "off", semanticMode: "automatic" } });
    expect((await s.reconcile()).outcome).toBe("off");
    await expectNothingHappened(s);
  });

  it("direct-video permission alone: zero Sequence jobs", async () => {
    const s = await setup({
      policy: {
        ...defaultQaPolicy("p"),
        projectId: undefined as never,
        directVideoAllowed: true,
        sequenceSemanticMode: "off",
      },
    });
    expect((await s.reconcile()).outcome).toBe("off");
    await expectNothingHappened(s);
  });

  it("suggest writes, derives, queues and spends nothing, yet says what is due", async () => {
    const calls = { n: 0 };
    const s = await setup({
      provider: gemini(calls),
      policy: { sequenceSemanticMode: "suggest", analyzer: "gemini" },
    });
    const r = await s.reconcile();
    expect(r.outcome).toBe("suggested");
    expect(r.dueCuts).toBeGreaterThan(0);
    await expectNothingHappened(s);
    expect(calls.n).toBe(0);
    const view = sequenceAutoView(await s.state());
    expect(view.due).toBe(false);
    expect(view.dueKey).toBeNull();
    expect(view.reviewBatch?.transitionKeys.length).toBeGreaterThan(0);
    expect(view.dueMaxUsd).toBeGreaterThan(0);
  });

  it("suggest bounds its review batch to the manual limit and says more remain", async () => {
    const s = await setup({ policy: { sequenceSemanticMode: "suggest" } });
    const view = sequenceAutoView(await s.state());
    expect(view.reviewBatch!.transitionKeys.length).toBeLessThanOrEqual(4);
    expect(view.counts.due).toBe(3);
    expect(view.reviewBatch!.more).toBe(0);
  });

  it.each([
    ["no analyzer", { analyzer: null }],
    ["no external media", { externalMediaAllowed: false }],
    ["no direct video", { directVideoAllowed: false }],
    ["no per-run ceiling", { maxCostPerRunUsd: null }],
    ["no daily ceiling", { maxCostPerDayUsd: null }],
  ])("automatic with %s: zero derivations", async (_n, policy) => {
    const s = await setup({ policy: policy as Partial<ProjectQaPolicy> });
    const r = await s.reconcile();
    expect(r.outcome).toBe("policy_blocked");
    expect(r.reasons.length).toBeGreaterThan(0);
    await expectNothingHappened(s);
  });

  it("an analyzer this server cannot run: zero derivations", async () => {
    const s = await setup();
    const r = await s.reconcile({
      auto: {
        availability: [{ id: s.provider.id, usable: false, kind: "mock", missingConfig: ["KEY"] }],
      },
    });
    expect(r.outcome).toBe("policy_blocked");
    await expectNothingHappened(s);
  });

  it("before 0047: not ready, nothing read beyond the check, zero derivations", async () => {
    const s = await setup();
    const clock = vi.spyOn(s.repo.episodeEdits, "getCutSettlementClock");
    const notReady = Object.assign(Object.create(s.repo.mediaQa), {
      sequenceAutomationReady: async () => false,
    });
    const r = await s.reconcile({ auto: { qa: notReady } });
    expect(r.outcome).toBe("not_ready");
    expect(clock).not.toHaveBeenCalled();
    await expectNothingHappened(s);
  });
});

media("calibration gating", () => {
  it("exact Gemini identity: nine families plan; eyeline never does", async () => {
    const s = await setup({ provider: gemini(), policy: { analyzer: "gemini" } });
    const st = await s.state();
    for (const c of st.cuts.filter((x) => x.status === "due"))
      expect(c.automationKey).toMatch(/^[0-9a-f]{64}$/);
    const view = sequenceAutoView(st);
    expect(view.calibration).toEqual({ version: "sequence-calibration-v1", acceptedFamilies: 9 });
    const r = await s.reconcile();
    expect(r.outcome).toBe("queued");
    for (const j of await s.jobs()) {
      const snapshot = j.inputSnapshot as unknown as {
        plan: { batches: Array<{ criterionKeys: string[] }> };
        calibration: { acceptedFamilies: string[] };
      };
      expect(snapshot.calibration.acceptedFamilies).not.toContain("eyeline");
      expect(snapshot.plan.batches.flatMap((b) => b.criterionKeys)).not.toContain("cut:eyeline");
    }
  });

  it.each([
    ["model", { PRISM_STUDIO_GEMINI_ANALYSIS_MODEL: "gemini-3.6-flash" }],
    ["thinking level", { PRISM_STUDIO_GEMINI_THINKING_LEVEL: "HIGH" }],
    ["timeout", { PRISM_STUDIO_GEMINI_TIMEOUT_MS: "5000" }],
  ])("an inference %s mismatch: no calibrated family, zero jobs", async (_n, env) => {
    const calls = { n: 0 };
    const s = await setup({ provider: gemini(calls, env), policy: { analyzer: "gemini" } });
    const r = await s.reconcile();
    expect(r.outcome).toBe("nothing_due");
    expect(r.blockedCuts).toBe(3);
    await expectNothingHappened(s);
    expect(calls.n).toBe(0);
  });

  it("the server video gate off: zero jobs", async () => {
    const provider = new GeminiAnalysisProvider({
      config: readGeminiConfig({
        PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
        GEMINI_API_KEY: "test-key-not-real",
      }),
      transport: new FakeGeminiTransport([]),
    });
    const s = await setup({ provider, policy: { analyzer: "gemini" } });
    expect((await s.reconcile()).outcome).toBe("nothing_due");
    await expectNothingHappened(s);
  });
});

media("settling", () => {
  it("before the window: zero derivations and jobs; at the window: a wave", async () => {
    const s = await setup();
    const soon = new Date(Date.now() + SEQUENCE_SETTLE_MS - 60_000);
    const r = await s.reconcile({ now: soon });
    expect(r.outcome).toBe("settling");
    expect(r.settlingCuts).toBe(3);
    await expectNothingHappened(s);
    expect(sequenceAutoView(await s.state({ now: soon })).due).toBe(false);
    expect((await s.reconcile()).outcome).toBe("queued");
  });

  it("trimming an item resets only the cuts touching it; a distant cut keeps its clock", async () => {
    const s = await setup();
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0 + SEQUENCE_SETTLE_MS + 5000);
    const edit = (await s.repo.episodeEdits.get(s.projectId, s.edit.id))!;
    const left = edit.items[0]!;
    await s.repo.episodeEdits.apply({
      projectId: s.projectId,
      editId: edit.id,
      expectedRevision: edit.revision,
      ops: [{ op: "trim", itemId: left.id, sourceInMs: 600, sourceOutMs: 4400 }],
      userId: USER,
      now: new Date().toISOString(),
    });
    const st = await s.state({ now: new Date() });
    const byLeft = new Map(st.cuts.map((c) => [c.cut.index, c.status]));
    expect(byLeft.get(0)).toBe("settling"); // A → B: its left item changed
    expect(byLeft.get(1)).toBe("due"); // B → C
    expect(byLeft.get(2)).toBe("due"); // C → D: the edit's revision moved, and it is still quiet
    expect(st.due.map((d) => d.cut.index)).toEqual([1, 2]);
  });

  it("editing the right item resets the cut into it", async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + SEQUENCE_SETTLE_MS + 5000);
    const edit = (await s.repo.episodeEdits.get(s.projectId, s.edit.id))!;
    await s.repo.episodeEdits.apply({
      projectId: s.projectId,
      editId: edit.id,
      expectedRevision: edit.revision,
      ops: [{ op: "trim", itemId: edit.items[3]!.id, sourceInMs: 600, sourceOutMs: 4400 }],
      userId: USER,
      now: new Date().toISOString(),
    });
    const st = await s.state({ now: new Date() });
    expect(st.cuts.find((c) => c.cut.index === 2)!.status).toBe("settling");
    expect(st.cuts.find((c) => c.cut.index === 0)!.status).toBe("due");
  });

  it("a reorder makes the new adjacency a new, unsettled cut (shifted items restart)", async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + SEQUENCE_SETTLE_MS + 5000);
    const before = new Set((await s.cuts()).map((c) => c.transitionKey));
    const edit = (await s.repo.episodeEdits.get(s.projectId, s.edit.id))!;
    const [a, b, c, d] = edit.items.map((i) => i.id) as [string, string, string, string];
    await s.repo.episodeEdits.apply({
      projectId: s.projectId,
      editId: edit.id,
      expectedRevision: edit.revision,
      ops: [{ op: "reorder", itemIds: [b, a, c, d] }],
      userId: USER,
      now: new Date().toISOString(),
    });
    const st = await s.state({ now: new Date() });
    const fresh = st.cuts.filter((x) => !before.has(x.cut.transitionKey));
    expect(fresh.length).toBeGreaterThan(0);
    for (const x of fresh) expect(x.status).toBe("settling");
    // C → D kept its adjacency and neither item shifted
    expect(st.cuts.find((x) => x.cut.index === 2)!.status).toBe("due");
  });

  it("a known upstream change resets every cut using it: a Shot's clock moved by clearing a selection", async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + SEQUENCE_SETTLE_MS + 5000);
    const cuts = await s.cuts();
    const shot = s.live().shots.find((x) => x.id === cuts[1]!.left.shotId)!;
    // the memory twin of 0047's trigger, reached the way the service reaches it
    (s.repo as unknown as { touchShot(p: string, id: string): void }).touchShot(s.projectId, shot.id);
    const st = await s.state({ now: new Date() });
    const status = (i: number) => st.cuts.find((c) => c.cut.index === i)!.status;
    expect(status(0)).toBe("settling"); // shot on its right
    expect(status(1)).toBe("settling"); // shot on its left
    expect(status(2)).toBe("due");
  });

  it("an unknown clock fails closed: never submitted, reported, manual review untouched", async () => {
    const s = await setup();
    const clock = await s.repo.episodeEdits.getCutSettlementClock(s.projectId, s.edit.id);
    const shotOfCut0 = (await s.cuts())[0]!.left.shotId;
    const missing = { ...clock, shots: { ...clock.shots } };
    delete (missing.shots as Record<string, string>)[shotOfCut0];
    const r = await s.reconcile({
      auto: { edits: { getCutSettlementClock: async () => missing } },
    });
    expect(r.outcome).toBe("queued");
    const jobs = await s.jobs();
    expect(jobs).toHaveLength(2); // the other two cuts
    const st = await loadSequenceAutoState({
      data: s.live(),
      view: await s.viewOf(),
      policy: s.policy,
      deps: s.auto({ edits: { getCutSettlementClock: async () => missing } }),
      now: s.settled(),
    });
    const stuck = st.cuts.find((c) => c.cut.index === 0)!;
    expect(stuck.status).toBe("settle_unknown");
    expect(sequenceAutoView(st).counts.unknown).toBe(1);
  });

  it("the edit's revision alone is never the clock: a performance-only edit restarts nothing", async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + SEQUENCE_SETTLE_MS + 5000);
    const edit = (await s.repo.episodeEdits.get(s.projectId, s.edit.id))!;
    const next = await s.repo.episodeEdits.apply({
      projectId: s.projectId,
      editId: edit.id,
      expectedRevision: edit.revision,
      ops: [{ op: "clear_performance", itemId: edit.items[0]!.id }],
      userId: USER,
      now: new Date().toISOString(),
    });
    expect(next.revision).toBe(edit.revision + 1);
    const st = await s.state({ now: new Date() });
    expect(st.due).toHaveLength(3);
  });
});

media("the fake analyzer speaks the sequence contract, as the E2E relies on", () => {
  it("a queued wave's job validates through the real analyzer path", async () => {
    const provider = gemini();
    const s = await setup({ provider, policy: { analyzer: "gemini", maxTransitionsPerBatch: 1 } });
    await s.reconcile();
    const [job] = await s.jobs();
    const input = job!.inputSnapshot as never as Parameters<typeof provider.analyzeBatch>[0]["input"];
    const res = await provider.analyzeBatch({
      batch: input.plan.batches[0]!,
      input,
      media: new Map(
        input.media.map((m) => [m.inputId, { inputId: m.inputId, mime: m.mime ?? "image/png", bytes: WEBM }]),
      ),
      ctx: { now: () => new Date(), sleep: async () => undefined, canCorrect: () => false },
    });
    expect(res.correctionUsed).toBe(false);
    expect(res.findings.length).toBeGreaterThan(0);
    for (const f of res.findings) {
      expect(f.evidence.map((e) => e.input)).toEqual(["left:last", "right:first"]);
      expect(f.result).toBe("pass");
    }
  });
});

media("settle_unknown is visible and safe", () => {
  it("every required clock missing: reported, shown as blocked, and nothing is derived, run, queued or called", async () => {
    const calls = { n: 0 };
    const s = await setup({ provider: gemini(calls), policy: { analyzer: "gemini" } });
    const unknown = { getCutSettlementClock: async () => emptySettlementClock() };
    const state = await loadSequenceAutoState({
      data: s.live(),
      view: await s.viewOf(),
      policy: s.policy,
      deps: s.auto({ edits: unknown }),
      now: s.settled(),
    });
    expect(state.cuts.map((c) => c.status)).toEqual(["settle_unknown", "settle_unknown", "settle_unknown"]);
    for (const c of state.cuts) {
      expect(c.settlement?.state).toBe("unknown");
      expect((c.settlement as { missing: string[] }).missing.length).toBeGreaterThan(0);
    }
    const view = sequenceAutoView(state);
    expect(view.counts).toMatchObject({ unknown: 3, due: 0, settling: 0 });
    expect(view).toMatchObject({ due: false, dueKey: null, waveCuts: 0 });

    const html = renderToStaticMarkup(
      createElement(SequenceAutomationPanel, {
        auto: view,
        projectSlug: "p",
        episodeId: "e",
        editId: "x",
        continuityHref: "/continuity",
      }),
    );
    expect(html).toContain('data-testid="sequence-auto-unknown"');
    expect(html).toContain("cannot be shown to have settled");
    expect(html).toContain("Manual review stays available");
    expect(html).toMatch(/data-testid="sequence-auto-due"[^>]*>0</);
    expect(html).toMatch(/data-testid="sequence-auto-blocked"[^>]*>3</);

    const r = await s.reconcile({ auto: { edits: unknown } });
    expect(r).toMatchObject({ outcome: "nothing_due", dueCuts: 0, blockedCuts: 3, queued: 0, jobIds: [] });
    expect(r.reasons.join(" ")).toMatch(/cannot be shown to have settled/);
    await expectNothingHappened(s);
    for (const c of await s.cuts())
      expect(await s.repo.mediaQa.listTransitionRuns(s.projectId, c.transitionKey)).toEqual([]);
    expect(calls.n).toBe(0);
  });

  it("the rule is not relaxed by waiting: unknown stays unknown long after the window", async () => {
    const s = await setup();
    const r = await s.reconcile({
      now: new Date(Date.now() + 365 * 86_400_000),
      auto: { edits: { getCutSettlementClock: async () => emptySettlementClock() } },
    });
    expect(r.queued).toBe(0);
    await expectNothingHappened(s);
  });
});

media("the wave", () => {
  it("is bounded by free slots and the batch cap, and repeating it is idempotent", async () => {
    const s = await setup({ policy: { maxTransitionsPerBatch: 2 } });
    const first = await s.reconcile();
    expect(first).toMatchObject({ outcome: "queued", queued: 2, remainingDue: 1 });
    expect(await s.jobs()).toHaveLength(2);
    const second = await s.reconcile();
    // one slot free, one cut left
    expect(second).toMatchObject({ outcome: "queued", queued: 1 });
    const third = await s.reconcile();
    expect(third.outcome).toBe("already_queued");
    expect(await s.jobs()).toHaveLength(3);
  });

  it("concurrent reconciliations make ONE job per automatic identity", async () => {
    const s = await setup();
    const now = s.settled();
    const rs = await Promise.all([s.reconcile({ now }), s.reconcile({ now }), s.reconcile({ now })]);
    const jobs = await s.jobs();
    expect(jobs).toHaveLength(3);
    expect(new Set(jobs.map((j) => j.idempotencyKey)).size).toBe(3);
    expect(rs.every((r) => r.outcome === "queued" || r.outcome === "already_queued")).toBe(true);
  });

  it("priority is critical-capable first, then edit order, whatever the store order", async () => {
    const s = await setup();
    const st = await s.state();
    const indexes = st.due.map((d) => d.cut.index);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("no capacity: zero derivations, and a transparent reason", async () => {
    const s = await setup();
    for (let i = 0; i < 3; i++) priorJob(s, { kind: "attempt" });
    const r = await s.reconcile();
    expect(r.outcome).toBe("capacity_blocked");
    expect(r.reasons.join(" ")).toMatch(/slot/);
    expect(s.spy.extractWindow).not.toHaveBeenCalled();
    expect(sequenceAutoView(await s.state()).due).toBe(false);
  });

  it("the same pool: Shot jobs reduce Sequence slots, and Sequence jobs reduce them too", async () => {
    const shots = await setup();
    priorJob(shots, { kind: "attempt" });
    priorJob(shots, { kind: "attempt" });
    expect(await shots.reconcile()).toMatchObject({ outcome: "queued", queued: 1 });
    const seq = await setup();
    priorJob(seq, { kind: "transition" });
    expect(await seq.reconcile()).toMatchObject({ outcome: "queued", queued: 2 });
    expect((await seq.state()).freeSlots).toBe(0);
  });

  it("the free-slot figure is part of dueKey, so a finished job makes the next wave due again", async () => {
    const s = await setup({ policy: { maxTransitionsPerBatch: 1 } });
    const a = sequenceAutoView(await s.state());
    priorJob(s, { kind: "attempt" });
    const b = sequenceAutoView(await s.state());
    expect(a.dueKey).not.toBe(b.dueKey);
    expect(a.dueKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

media("budget, on the shared ledger", () => {
  const costed = () => setup({ provider: gemini(), policy: { analyzer: "gemini" } });

  it("an exhausted day: zero derivations", async () => {
    const s = await costed();
    const r = await s.reconcile({ policy: { maxCostPerDayUsd: 0.0001, maxCostPerRunUsd: 0.0001 } });
    expect(r.outcome).toBe("budget_blocked");
    await expectNothingHappened(s);
  });

  it("prior Shot QA spend reduces what Sequence may spend", async () => {
    const s = await costed();
    const one = (await s.state()).due[0]!.maxUsd!;
    const free = await s.state({ policy: { maxCostPerDayUsd: one * 2.5 } });
    expect(free.wave).toHaveLength(2);
    priorJob(s, { kind: "attempt", status: "succeeded", usd: one });
    const after = await s.state({ policy: { maxCostPerDayUsd: one * 2.5 } });
    expect(after.wave).toHaveLength(1);
  });

  it("prior Sequence spend reduces the same budget: there is no second ledger", async () => {
    const s = await costed();
    const one = (await s.state()).due[0]!.maxUsd!;
    priorJob(s, { kind: "transition", status: "succeeded", usd: one });
    const after = await s.state({ policy: { maxCostPerDayUsd: one * 2.5 } });
    expect(after.wave).toHaveLength(1);
  });

  it("the wave's total never passes the remaining budget, and what does not fit stays due", async () => {
    const s = await costed();
    const one = (await s.state()).due[0]!.maxUsd!;
    const st = await s.state({ policy: { maxCostPerDayUsd: one * 1.5 } });
    expect(st.wave).toHaveLength(1);
    expect(st.waveMaxUsd).toBeLessThanOrEqual(one * 1.5);
    expect(st.remaining).toHaveLength(2);
    expect(st.waveStop).toBe("budget");
  });

  it("an unknown estimate: zero derivations", async () => {
    const provider = gemini();
    provider.estimate = ((...a: Parameters<typeof provider.estimate>) => ({
      ...GeminiAnalysisProvider.prototype.estimate.apply(provider, a),
      maxUsd: Number.POSITIVE_INFINITY,
    })) as typeof provider.estimate;
    const s = await setup({ provider, policy: { analyzer: "gemini" } });
    const r = await s.reconcile();
    expect(r.outcome).toBe("budget_blocked");
    await expectNothingHappened(s);
  });

  it("the exact media costing more refuses the WHOLE wave: none queued, derived Assets stay reusable", async () => {
    const provider = gemini();
    const real = GeminiAnalysisProvider.prototype.estimate;
    provider.estimate = ((input: Parameters<typeof real>[0], at: Date) => {
      const e = real.call(provider, input, at);
      const exact = input.media.some((m) => m.role === "edge_clip" && !m.checksum?.startsWith("pending:"));
      return exact ? { ...e, maxUsd: 40 } : e;
    }) as typeof provider.estimate;
    const s = await setup({ provider, policy: { analyzer: "gemini", maxCostPerRunUsd: 50 } });
    const r = await s.reconcile({ auto: { paid: { enabled: true, maxUsdPerRun: 50, maxUsdPerDay: 1000 } } });
    expect(r.outcome).toBe("budget_blocked");
    expect(r.reasons.join(" ")).toMatch(/Nothing was queued/);
    expect(await s.jobs()).toEqual([]);
    expect(r.queued).toBe(0);
    // the media was really derived and remains, reusable by derivation key
    expect(s.spy.extractWindow).toHaveBeenCalled();
    expect(s.storage.objects.size).toBeGreaterThan(4);
  });
});

media("automatic identity", () => {
  it("automatic runs carry their key and an automatic event; manual runs carry none", async () => {
    const s = await setup({ policy: { maxTransitionsPerBatch: 1 } });
    await s.reconcile();
    const [job] = await s.jobs();
    const run = await s.repo.mediaQa.getTransitionRun(job!.runId);
    expect(run!.run.automationKey).toBe(job!.idempotencyKey);
    expect(run!.run.automationKey).toMatch(/^[0-9a-f]{64}$/);
    const events = (s.repo.mediaQa as unknown as { events: Array<{ jobId: string; note: string }> }).events;
    expect(events.find((e) => e.jobId === job!.id)!.note).toBe(AUTO_SEQUENCE_QUEUED_NOTE);

    const cut = (await s.cuts()).find((c) => c.transitionKey !== run!.subject.transitionKey)!;
    const [manual] = await submitSequenceReview({
      data: s.live(),
      view: await s.viewOf(),
      selections: [
        {
          transitionKey: cut.transitionKey,
          subjectFingerprint: cut.truth.subjectFingerprint,
          criteriaFingerprint: cut.truth.criteriaFingerprint,
          referenceFingerprint: cut.truth.referenceFingerprint,
          transfer: { left: "not_sent", right: "not_sent" },
        },
      ],
      provider: s.provider,
      qaPolicy: s.policy,
      paid: NOT_PAID,
      deps: s.deps(new Date()),
      confirmed: true,
      confirmedMaxUsd: 0,
      nonce: "fresh-manual-nonce",
      limits: { maxActivePerProject: 3, maxJobAttempts: 3 },
    });
    expect(manual!.run.run.automationKey).toBeNull();
    expect(events.find((e) => e.jobId === manual!.job.id)!.note).toBe("Sequence review submitted by user");
  });

  it("a manual run does not cover the automatic identity, and keeps its own audit trail", async () => {
    const s = await setup();
    const cut = (await s.cuts())[0]!;
    await submitSequenceReview({
      data: s.live(),
      view: await s.viewOf(),
      selections: [
        {
          transitionKey: cut.transitionKey,
          subjectFingerprint: cut.truth.subjectFingerprint,
          criteriaFingerprint: cut.truth.criteriaFingerprint,
          referenceFingerprint: cut.truth.referenceFingerprint,
          transfer: { left: "not_sent", right: "not_sent" },
        },
      ],
      provider: s.provider,
      qaPolicy: s.policy,
      paid: NOT_PAID,
      deps: s.deps(new Date()),
      confirmed: true,
      confirmedMaxUsd: 0,
      nonce: "fresh-manual-nonce",
      limits: { maxActivePerProject: 3, maxJobAttempts: 3 },
    });
    const st = await s.state();
    expect(st.cuts.find((c) => c.cut.transitionKey === cut.transitionKey)!.status).toBe("due");
  });

  it("the key is stable for identical truth, and changes with truth and with the calibration identity", async () => {
    const s = await setup();
    const cut = (await s.cuts())[0]!;
    const key = (provider: ContinuityAnalysisProvider, truth = cut.truth) =>
      sequenceIdempotencyKey(truth, provider, "continuity-gemini-transition-v1", "auto-sequence-v1");
    const g = gemini();
    expect(key(g)).toBe(key(gemini()));
    expect(key(g, { ...cut.truth, subjectFingerprint: "changed" })).not.toBe(key(g));
    expect(key(g, { ...cut.truth, criteriaFingerprint: "changed" })).not.toBe(key(g));
    expect(key(g, { ...cut.truth, referenceFingerprint: "changed" })).not.toBe(key(g));
    const other = new GeminiAnalysisProvider({
      config: readGeminiConfig({ GEMINI_API_KEY: "x", PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini" }),
      transport: new FakeGeminiTransport([]),
      testCrossCutCalibration: { version: "sequence-calibration-v2", acceptedFamilies: ["axis"] },
    });
    expect(key(other)).not.toBe(key(g));
    // no timestamp: a later reconciliation names the same identity
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 86_400_000);
    expect(key(g)).toBe(key(gemini()));
  });

  it("never collides with a Shot automatic key, and a transition run is no Shot coverage", async () => {
    const s = await setup();
    await s.reconcile();
    const jobs = await s.jobs();
    const shotKey = deterministicAutomationKey({
      attemptId: "a",
      subjectFingerprint: "s",
      criteriaFingerprint: "c",
      referenceFingerprint: "r",
      packageFingerprint: "p",
      rulesVersion: "3a.4",
    });
    expect(jobs.map((j) => j.idempotencyKey)).not.toContain(shotKey);
    const data = s.live();
    for (const attempt of data.attempts.slice(0, 2))
      expect(await s.repo.mediaQa.listAttemptRuns(attempt.id)).toEqual([]);
  });
});

media("read purity and outcomes", () => {
  it.each(["off", "suggest", "automatic"] as const)(
    "reading in %s mode writes, derives and calls nothing",
    async (mode) => {
      const calls = { n: 0 };
      const s = await setup({
        provider: gemini(calls),
        policy: { analyzer: "gemini", sequenceSemanticMode: mode },
      });
      sequenceAutoView(await s.state());
      await expectNothingHappened(s);
      expect(calls.n).toBe(0);
    },
  );

  it("the worker is not involved: queued jobs stay frozen and a policy change does not cancel them", async () => {
    const s = await setup();
    await s.reconcile();
    const before = await s.jobs();
    expect(before).toHaveLength(3);
    const r = await s.reconcile({ policy: { sequenceSemanticMode: "off" } });
    expect(r.outcome).toBe("off");
    expect((await s.jobs()).map((j) => j.status)).toEqual(before.map((j) => j.status));
  });

  it("a failure is never collapsed into ok", async () => {
    const s = await setup();
    const r = await s.reconcile({
      auto: {
        edits: {
          getCutSettlementClock: async () => {
            throw new Error("the clock read failed");
          },
        },
      },
    });
    expect(r.outcome).toBe("failed");
    expect(r.reasons.join(" ")).toMatch(/the clock read failed/);
  });
});

describe("what else reads these clocks", () => {
  it("a Shot's or Character's updated_at alone never changes the package fingerprint: nothing goes stale from a touch", () => {
    const w = world();
    const shot = w.data.shots.find((s) => s.shotCode === "2B")!;
    const before = assembleGenerationPackage(buildShotContext(w.data, shot.id), new Date(0));
    shot.updatedAt = "2031-01-01T00:00:00.000Z";
    for (const c of w.data.characters) c.updatedAt = "2031-01-01T00:00:00.000Z";
    const after = assembleGenerationPackage(buildShotContext(w.data, shot.id), new Date(0));
    expect(after.provenance.fingerprint).toBe(before.provenance.fingerprint);
    expect(after.provenance.parts.overall).toBe(before.provenance.parts.overall);
    // the one place it is kept: informational source versions
    expect(after.provenance.sourceVersions.shotUpdatedAt).toBe("2031-01-01T00:00:00.000Z");
  });
});

describe("the memory twins of migration 0047", () => {
  const fixture = () => {
    const w = world();
    const repo = new MemoryRepository([w.data]);
    const projectId = w.data.project.id;
    const data = (repo as unknown as { projects: Map<string, ProjectData> }).projects.get(projectId)!;
    const stampOf = async () => {
      const edit = await repo.episodeEdits.create({
        projectId,
        episodeId: data.episodes[0]!.id,
        editRate: { num: 24, den: 1 },
        items: [],
        userId: null,
        now: new Date().toISOString(),
      });
      return () => repo.episodeEdits.getCutSettlementClock(projectId, edit.id);
    };
    return { repo, projectId, data, stampOf };
  };
  const later = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
  };

  it("deleting a Prop removes it from its Shots and moves only those Shots' clocks", async () => {
    const { repo, projectId, data, stampOf } = fixture();
    const prop = data.props[0]!;
    const [using, other] = data.shots as [(typeof data.shots)[number], (typeof data.shots)[number]];
    using.propIds = [prop.id];
    other.propIds = [];
    const clock = await stampOf();
    const before = await clock();
    const updatedAt = using.updatedAt;
    later();
    await repo.remove(projectId, "props", prop.id);
    const after = await clock();
    expect(using.propIds).toEqual([]);
    expect(using.updatedAt).not.toBe(updatedAt);
    expect(after.shots[using.id]).not.toBe(before.shots[using.id]);
    expect(after.shots[other.id]).toBe(before.shots[other.id]);
  });

  it("deleting an identity reference's Asset sets it null and moves the Character's clock", async () => {
    const { repo, projectId, data, stampOf } = fixture();
    const ref = data.identityRefs.find((r) => r.assetId)!;
    const clock = await stampOf();
    const before = await clock();
    later();
    await repo.remove(projectId, "assets", ref.assetId!);
    expect(data.identityRefs.find((r) => r.id === ref.id)!.assetId).toBeNull();
    expect((await clock()).characters[ref.characterId]).not.toBe(before.characters[ref.characterId]);
  });

  it("any identity reference write moves the Character's clock, and only that clock", async () => {
    const { repo, projectId, data, stampOf } = fixture();
    const ref = data.identityRefs[0]!;
    const clock = await stampOf();
    const before = await clock();
    const creative = JSON.stringify({
      ...data.characters.find((c) => c.id === ref.characterId),
      updatedAt: 0,
    });
    later();
    await repo.upsert(projectId, "identityRefs", { ...ref, label: "changed" });
    const mid = await clock();
    expect(mid.characters[ref.characterId]).not.toBe(before.characters[ref.characterId]);
    expect(JSON.stringify({ ...data.characters.find((c) => c.id === ref.characterId), updatedAt: 0 })).toBe(
      creative,
    );
    vi.setSystemTime(Date.now() + 60_000);
    await repo.remove(projectId, "identityRefs", ref.id);
    expect((await clock()).characters[ref.characterId]).not.toBe(mid.characters[ref.characterId]);
  });

  it("clearing a Location View or Lock selection moves the Shot's clock; clearing nothing does not", async () => {
    const { repo, projectId, data, stampOf } = fixture();
    const shot = data.shots[0]!;
    const clock = await stampOf();
    const before = await clock();
    later();
    await repo.locationViews.clearForShot({ projectId, shotId: shot.id });
    expect((await clock()).shots[shot.id]).toBe(before.shots[shot.id]);
    (repo.locationViews as unknown as { selections: Map<string, unknown> }).selections.set(shot.id, {
      shotId: shot.id,
      projectId,
      locationViewId: "v",
      locationId: "l",
    });
    await repo.locationViews.clearForShot({ projectId, shotId: shot.id });
    const afterView = await clock();
    expect(afterView.shots[shot.id]).not.toBe(before.shots[shot.id]);

    const characterId = "character-of-the-assignment";
    const lockSelections = (repo.characterContinuity as unknown as { selections: Map<string, unknown> })
      .selections;
    lockSelections.set(`${shot.id}:${characterId}`, { shotId: shot.id, characterId, projectId });
    vi.setSystemTime(Date.now() + 60_000);
    await repo.characterContinuity.clearForAssignment({ projectId, shotId: shot.id, characterId });
    expect(lockSelections.size).toBe(0);
    expect((await clock()).shots[shot.id]).not.toBe(afterView.shots[shot.id]);
  });

  it("a touch makes an in-progress generation stale, the intended consequence: the package would change", async () => {
    const { repo, projectId, data } = fixture();
    const shot = data.shots[0]!;
    const revision = await repo.generation.projectRevision(data.project.slug);
    (repo.locationViews as unknown as { selections: Map<string, unknown> }).selections.set(shot.id, {
      shotId: shot.id,
      projectId,
      locationViewId: "v",
      locationId: "l",
    });
    const updatedAt = shot.updatedAt;
    later();
    await repo.locationViews.clearForShot({ projectId, shotId: shot.id });
    expect(shot.updatedAt).not.toBe(updatedAt);
    expect((await repo.generation.projectRevision(data.project.slug))!.revision).not.toBe(revision!.revision);
  });
});

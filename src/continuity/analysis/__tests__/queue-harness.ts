import { createHash } from "node:crypto";
import type { AnalysisSpendPolicy } from "@/domain/continuity/analysis/cost";
import { parseAdaptationPlan } from "@/domain/framing/adaptation";
import { makeHarness, type Harness } from "@/generation/__tests__/helpers";
import { memoryLogger } from "@/generation/log";
import { encodeMockPng } from "@/generation/providers/mock-image";
import { conformAttemptOutput } from "@/media/delivery";
import { FfmpegMediaProcessor } from "@/media/ffmpeg";
import { computeQaInputs } from "../../service";
import { submitAnalysis } from "../submit";
import { ContinuityAnalysisWorker } from "../worker";
import type { ContinuityAnalysisProvider } from "../provider";

/**
 * Shared queue harness for provider-level queue tests: a real (synthetic) adapted attempt, stocked references,
 * a submit helper and a worker factory. Uses the in-memory store and the fake transports only.
 */
export const processor = new FfmpegMediaProcessor({ limits: { timeoutMs: 90_000 } });

export const PAID: AnalysisSpendPolicy = { enabled: true, maxUsdPerRun: 0.5, maxUsdPerDay: 5 };
export const CLOSED: AnalysisSpendPolicy = { enabled: false, maxUsdPerRun: null, maxUsdPerDay: null };
export const LIMITS = { maxActivePerProject: 3, maxJobAttempts: 3 };

async function adaptedAttempt(h: Harness) {
  const { attemptId, jobId } = await h.submit("3A", "mock-video-169", {
    adaptation: { framing: "overscan_for_crop", duration: "generate_longer_then_trim" },
  });
  const w = h.worker();
  for (let i = 0; i < 30; i++) {
    const j = (await h.repo.generation.getJob(jobId!))!;
    if (j.status === "succeeded" || j.status === "failed") break;
    await w.tick();
    h.clock.advance(1500);
  }
  const view = (await h.repo.generation.getAttemptView(attemptId!))!;
  const original = view.outputs.find((o) => o.output.role === "primary")!.asset;
  const plan = parseAdaptationPlan(view.attempt.adaptationPlan)!;
  const deps = { processor, storage: h.sink, qa: h.repo.mediaQa, userId: null, now: () => h.clock.now };
  await conformAttemptOutput({
    attemptId: attemptId!,
    attemptLabel: "3A-a1",
    original,
    plan: plan.conform,
    deps,
  });
  return { attemptId: attemptId!, deps };
}

/** Gives every reference in the frozen set a real (synthetic) image so the plan has something to send. */
async function stockReferences(h: Harness, attemptId: string) {
  const data = await h.data();
  const view = (await h.repo.generation.getAttemptView(attemptId))!;
  const delivery = await h.repo.mediaQa.getDelivery(attemptId);
  const inputs = computeQaInputs({ data, view, delivery, now: h.clock.now })!;
  let seed = 1;
  for (const item of inputs.references.items) {
    if (!item.assetId) continue;
    const a = data.assets.find((x) => x.id === item.assetId);
    if (!a || a.type !== "image") continue;
    const bytes = encodeMockPng(64, 36, seed++);
    const path = `${a.projectId}/${a.id}/ref.png`;
    await h.sink.put(path, bytes);
    await h.repo.upsert(a.projectId, "assets", {
      ...a,
      storageProvider: "local",
      bucket: null,
      objectPath: path,
      mime: "image/png",
      byteSize: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      width: 64,
      height: 36,
    });
  }
  const data2 = await h.data();
  const delivery2 = await h.repo.mediaQa.getDelivery(attemptId);
  return {
    data: data2,
    view,
    inputs: computeQaInputs({ data: data2, view, delivery: delivery2, now: h.clock.now })!,
  };
}

export async function setup() {
  const h = makeHarness();
  const { attemptId, deps } = await adaptedAttempt(h);
  const s = await stockReferences(h, attemptId);
  return { h, attemptId, deps, ...s };
}
export type QueueCtx = Awaited<ReturnType<typeof setup>>;

const reader = (h: Harness) => ({
  read: async (ref: { objectPath: string | null }) => (ref.objectPath ? h.sink.get(ref.objectPath) : null),
});

export function makeWorker(
  h: Harness,
  provider: ContinuityAnalysisProvider,
  paid = PAID,
  extra: Partial<ConstructorParameters<typeof ContinuityAnalysisWorker>[0]> = {},
) {
  const logger = memoryLogger();
  const w = new ContinuityAnalysisWorker({
    store: h.repo.mediaQa,
    providers: new Map([[provider.id, provider]]),
    media: reader(h),
    processor,
    logger,
    paid,
    clock: () => h.clock.now,
    workerId: "test-worker",
    heartbeatMs: 0,
    leaseMs: 5000,
    sleep: async () => undefined,
    retryDelayMs: 100,
    ...extra,
  });
  return { w, logger };
}

export const submit = async (
  ctx: QueueCtx,
  provider: ContinuityAnalysisProvider,
  over: {
    policy?: AnalysisSpendPolicy;
    acknowledged?: boolean;
    nonce?: string;
    limits?: { maxActivePerProject: number; maxJobAttempts: number };
  } = {},
) =>
  submitAnalysis({
    inputs: ctx.inputs,
    view: ctx.view,
    assets: ctx.data.assets,
    provider,
    policy: over.policy ?? PAID,
    deps: ctx.deps,
    acknowledged: over.acknowledged ?? true,
    nonce: over.nonce ?? "n1",
    limits: over.limits ?? LIMITS,
    now: ctx.h.clock.now,
  });

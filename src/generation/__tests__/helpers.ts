import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryRepository } from "@/data/memory-repository";
import type { ProjectData } from "@/domain/schemas";
import { readGenerationConfig, type GenerationConfig } from "../config";
import { silentLogger } from "../log";
import type { GenerationProviderAdapter } from "../provider";
import { createRegistry, ModelRegistry } from "../registry";
import { LocalDiskSink } from "../sink";
import { prepareSubmission } from "../submission";
import { GenerationWorker } from "../worker";

export interface Harness {
  repo: MemoryRepository;
  registry: ModelRegistry;
  config: GenerationConfig;
  sink: LocalDiskSink;
  clock: { now: Date; advance(ms: number): void };
  worker(opts?: { workerId?: string; leaseMs?: number }): GenerationWorker;
  data(): Promise<ProjectData>;
  shotId(code: string): Promise<string>;
  submit(
    code: string,
    modelId?: string,
    opts?: { acknowledge?: boolean; key?: string; userId?: string | null; provider?: string },
  ): Promise<{
    prepared: ReturnType<typeof prepareSubmission>;
    attemptId: string | null;
    jobId: string | null;
  }>;
}

/** Fresh in-memory project + mock provider with zero latency and a controllable clock. */
export function makeHarness(
  env: Record<string, string> = {},
  opts: { extraAdapters?: GenerationProviderAdapter[]; replaceRegistry?: boolean } = {},
): Harness {
  const fullEnv = {
    NODE_ENV: "test",
    PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
    PRISM_STUDIO_WORKER_LEASE_MS: "5000",
    ...env,
  };
  const config = readGenerationConfig(fullEnv);
  const base = createRegistry(fullEnv, config);
  const registry = opts.extraAdapters
    ? new ModelRegistry(
        [...(opts.replaceRegistry ? [] : base.adapters()), ...opts.extraAdapters],
        config,
        fullEnv,
      )
    : base;
  const repo = new MemoryRepository();
  const sink = new LocalDiskSink(mkdtempSync(path.join(tmpdir(), "prism-gen-")));
  const clock = {
    now: new Date("2026-10-12T12:00:00.000Z"),
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };

  return {
    repo,
    registry,
    config,
    sink,
    clock,
    worker: (opts = {}) =>
      new GenerationWorker({
        store: repo.generation,
        registry,
        sink,
        config: opts.leaseMs ? { ...config, worker: { ...config.worker, leaseMs: opts.leaseMs } } : config,
        logger: silentLogger,
        clock: () => clock.now,
        workerId: opts.workerId ?? "test-worker",
        retryPolicy: { baseDelayMs: 100, maxDelayMs: 1000, jitter: 0 },
        random: () => 0,
        heartbeatMs: 0,
      }),
    data: async () => (await repo.loadProject("ojousama"))!,
    shotId: async (code) => {
      const d = (await repo.loadProject("ojousama"))!;
      const s = d.shots.find((x) => x.shotCode === code);
      if (!s) throw new Error(`no shot ${code}`);
      return s.id;
    },
    submit: async (code, modelId = "mock-video-1", opts = {}) => {
      const data = (await repo.loadProject("ojousama"))!;
      const shot = data.shots.find((x) => x.shotCode === code)!;
      const next =
        Math.max(0, ...data.attempts.filter((a) => a.shotId === shot.id).map((a) => a.attemptNumber)) + 1;
      const prepared = prepareSubmission({
        data,
        shotId: shot.id,
        registry,
        provider: opts.provider ?? "mock",
        modelId,
        acknowledged: opts.acknowledge === false ? [] : ["__all__"],
        userId: opts.userId ?? null,
        idempotencyKey: opts.key ?? `test-key-${code}-${next}-${modelId}`,
        config,
        now: clock.now,
      });
      // "__all__" is a test convenience: acknowledge exactly the ignored features this model produces.
      const ignored = prepared.evaluation.compatibility?.ignoredFeatures.map((f) => f.id) ?? [];
      const final =
        opts.acknowledge === false
          ? prepared
          : prepareSubmission({
              data,
              shotId: shot.id,
              registry,
              provider: opts.provider ?? "mock",
              modelId,
              acknowledged: ignored,
              userId: opts.userId ?? null,
              idempotencyKey: opts.key ?? `test-key-${code}-${next}-${modelId}`,
              config,
              now: clock.now,
            });
      if (!final.input) return { prepared: final, attemptId: null, jobId: null };
      const created = await repo.generation.createAttemptWithJob(final.input);
      return { prepared: final, attemptId: created.attempt.id, jobId: created.job.id };
    },
  };
}

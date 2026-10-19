import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrevisError } from "@/data/previs-repository";
import { MAX_SPLAT_BYTES, UNKNOWN_CALIBRATION } from "@/domain/previs/splat";
import {
  isTerminal,
  sanitizeErrorMessage,
  type JobErrorCode,
  type JobEvent,
  type JobPatch,
  type ReconstructionJobRecord,
} from "@/domain/reconstruction/job";
import { inspectSplat } from "@/lib/splat/inspect";
import { ingestReconstructionResult } from "@/server/reconstruction-jobs";
import {
  DEFAULT_ENGINE_LIMITS,
  runLocalReconstruction,
  type LocalEngineLimits,
  type ToolchainForRun,
} from "../local/engine";
import { SPZ_ENCODER } from "../local/spz";
import type { LocalToolchainProbe } from "../local/toolchain";
import {
  LOCAL_RUN_SCHEMA,
  LocalReconstructionError,
  SUPPORTED_INPUT_MIMES,
  type LocalReconstructionProgress,
  type LocalRunMetadata,
  type SupportedInputMime,
} from "../local/types";
import { isWithin } from "../local/workspace";
import {
  jobFailureFor,
  LOCAL_QUALITY,
  localProvenance,
  newRunId,
  operationIdFor,
  runIdOf,
  sourceListProblem,
  STOPPED_MESSAGE,
  toEngineRequest,
  type RecordedTools,
} from "./adapter";
import {
  acquireWorkerLock,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_SCHEMA,
  newWorkerId,
  removeHeartbeat,
  summarizeToolchain,
  WORKER_VERSION,
  workRootId,
  writeHeartbeat,
  type ToolchainReadiness,
} from "./runtime";
import { LOCAL_PROVIDER_ID, type LocalJobRef, type LocalWorkerStore, type OwnerScope } from "./store";

/**
 * The durable, SAME-HOST local reconstruction worker (Phase 2F M2D.3B): a separate long-lived process that turns QUEUED
 * `local_capture` jobs into immutable generated reconstructions. A browser tab is never the worker; closing it changes
 * nothing.
 *
 *   queued ──claim (CAS)──▶ submitting ──sources verified, workspace──▶ running ──engine (COLMAP → Brush → SPZ)──▶
 *   ingesting ──shared M2D.2 ingestion (private Asset + immutable reconstruction + success, atomic)──▶ succeeded
 *
 * Rules:
 *   - ONE worker per work root (exclusive lock) and ONE reconstruction at a time (one GPU); queued jobs wait.
 *   - Only `local_capture` jobs are ever claimed; the queued → submitting compare-and-set elects exactly one claimer.
 *   - Progress is throttled (stage changes immediately, otherwise at most every ~1.5 s); every Brush iteration is NOT
 *     an event. The job is re-read every ~1.5 s: a cancelled job aborts the engine (process tree) promptly.
 *   - Before importing, the job is re-read and moved running → ingesting by compare-and-set: a cancel that won is
 *     final (the result is discarded); an import that won makes a later cancel impossible (terminal history).
 *   - A crash never silently re-runs COLMAP/Brush. On restart, a run whose VALIDATED result is retained (manifest,
 *     run identity, source checksums, tool provenance and output checksum all match) is imported; anything else is
 *     failed with a clear message, and Retry creates a new attempt.
 *   - Workspaces are removed after success, reduced to bounded diagnostics after failure, and swept by age.
 */

export interface LocalWorkerTiming {
  /** how often to look for queued jobs while idle */
  pollMs: number;
  /** how often a running job is re-read to notice cancellation */
  cancelCheckMs: number;
  /** minimum time between two progress writes within one stage */
  progressWriteMs: number;
  heartbeatMs: number;
  /** how often the toolchain is re-probed while idle */
  probeEveryMs: number;
  /** how long shutdown waits for an aborted run to stop and clean up */
  shutdownGraceMs: number;
  /** run directories older than this are removed by the sweeper (never the active one) */
  staleWorkspaceMs: number;
  /** attempts to store a validated result before the job fails */
  ingestAttempts: number;
  ingestRetryMs: number;
}

export const DEFAULT_TIMING: LocalWorkerTiming = {
  pollMs: 3_000,
  cancelCheckMs: 1_500,
  progressWriteMs: 1_500,
  heartbeatMs: HEARTBEAT_INTERVAL_MS,
  probeEveryMs: 60_000,
  shutdownGraceMs: 20_000,
  staleWorkspaceMs: 3 * 24 * 60 * 60 * 1000,
  ingestAttempts: 3,
  ingestRetryMs: 2_000,
};

export interface LocalWorkerOptions {
  store: LocalWorkerStore;
  workRoot: string;
  /** the M2D.3A toolchain probe (production: probeLocalToolchain over the real environment) */
  probe: () => Promise<LocalToolchainProbe>;
  /** the M2D.3A engine (tests may wrap it to observe calls; the default is the real engine) */
  engine?: typeof runLocalReconstruction;
  limits?: LocalEngineLimits;
  timing?: Partial<LocalWorkerTiming>;
  workerId?: string;
  now?: () => string;
  newId?: () => string;
  log?: (entry: Record<string, unknown>) => void;
  /** test seams around the race-critical moments; never configured in production */
  hooks?: { beforeIngestClaim?: (job: ReconstructionJobRecord) => Promise<void> };
}

interface ActiveRun {
  jobId: string;
  runId: string;
  controller: AbortController;
  done: Promise<void>;
}

type AbortReason = "cancelled" | "shutdown" | "lost";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const isRace = (e: unknown) => e instanceof PrevisError && (e.code === "conflict" || e.code === "invalid");

export class LocalReconstructionWorker {
  readonly workerId: string;
  readonly rootId: string;
  private readonly timing: LocalWorkerTiming;
  private readonly limits: LocalEngineLimits;
  private readonly engine: typeof runLocalReconstruction;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly startedAt: string;
  private readiness: { probe: LocalToolchainProbe; summary: ToolchainReadiness; at: number } | null = null;
  /** Brush found no usable GPU adapter in a run: not ready until the worker restarts */
  private gpuFailed = false;
  private active: ActiveRun | null = null;
  private lock: { release: () => Promise<void> } | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** the heartbeat write in flight (awaited on stop, so a late write can never resurrect a stopped worker) */
  private beating: Promise<void> = Promise.resolve();
  private heartbeatClosed = false;
  private stopping = false;
  private stopped: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private lastSweep = 0;

  constructor(private readonly opts: LocalWorkerOptions) {
    if (!path.isAbsolute(opts.workRoot)) throw new Error("The local worker's work root must be absolute.");
    this.workerId = opts.workerId ?? newWorkerId();
    this.rootId = workRootId(opts.workRoot);
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.limits = opts.limits ?? DEFAULT_ENGINE_LIMITS;
    this.engine = opts.engine ?? runLocalReconstruction;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.newId = opts.newId ?? (() => randomUUID());
    this.startedAt = this.now();
  }

  private log(entry: Record<string, unknown>) {
    (this.opts.log ?? ((e) => console.info(JSON.stringify(e))))({
      event: "local_reconstruction.worker",
      worker: this.workerId,
      ...entry,
    });
  }

  get busy(): boolean {
    return this.active !== null;
  }

  // ───────────────────────── lifecycle ─────────────────────────

  /**
   * Takes the work-root lock (refused while another live worker holds it), probes the toolchain, starts the
   * heartbeat, resolves runs a previous worker left behind, and sweeps old workspaces. Claims nothing yet.
   */
  async start(): Promise<void> {
    await mkdir(this.opts.workRoot, { recursive: true });
    const lock = await acquireWorkerLock(this.opts.workRoot, {
      workerId: this.workerId,
      pid: process.pid,
      startedAt: this.startedAt,
    });
    this.lock = lock;
    if (lock.recoveredStale)
      this.log({ lock: "recovered_stale", previousWorker: lock.recoveredStale.workerId });
    try {
      await this.refreshReadiness(true);
      await this.beat();
      this.heartbeatTimer = setInterval(() => void this.beat(), this.timing.heartbeatMs);
      this.heartbeatTimer.unref?.();
      await this.recover();
      await this.sweep(true);
    } catch (e) {
      await this.stop();
      throw e;
    }
  }

  /** Runs until `stop()`: one claim attempt per poll while idle, one reconstruction at a time. */
  async run(): Promise<void> {
    if (!this.lock) await this.start();
    while (!this.stopping) {
      const worked = await this.tick().catch((e: unknown) => {
        this.log({ tick: "error", error: errMsg(e) });
        return false;
      });
      if (!worked && !this.stopping)
        await new Promise<void>((r) => {
          const t = setTimeout(r, this.timing.pollMs);
          this.wake = () => {
            clearTimeout(t);
            r();
          };
        });
      this.wake = null;
    }
    await this.stopped;
  }

  /**
   * Stops claiming, aborts an active run (COLMAP/Brush process trees stop), waits a bounded grace period for it to
   * record a truthful outcome and clean up, removes the heartbeat and releases the lock.
   */
  stop(): Promise<void> {
    this.stopped ??= (async () => {
      this.stopping = true;
      this.wake?.();
      const run = this.active;
      if (run) {
        run.controller.abort("shutdown" satisfies AbortReason);
        await Promise.race([run.done, sleep(this.timing.shutdownGraceMs)]);
      }
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.heartbeatClosed = true;
      await this.beating;
      await removeHeartbeat(this.opts.workRoot, this.workerId).catch(() => undefined);
      await this.lock?.release().catch(() => undefined);
      this.lock = null;
    })();
    return this.stopped;
  }

  /** Processes queued jobs until none is left (one-shot runs and tests). */
  async runUntilIdle(maxJobs = 100): Promise<number> {
    if (!this.lock) await this.start();
    let n = 0;
    while (n < maxJobs && !this.stopping && (await this.tick())) n++;
    return n;
  }

  // ───────────────────────── heartbeat / readiness ─────────────────────────

  private async refreshReadiness(force = false): Promise<ToolchainReadiness> {
    const fresh = this.readiness && Date.now() - this.readiness.at < this.timing.probeEveryMs;
    if (!force && fresh) return this.readiness!.summary;
    try {
      const probe = await this.opts.probe();
      this.readiness = {
        probe,
        summary: summarizeToolchain(probe, this.now(), this.gpuFailed),
        at: Date.now(),
      };
    } catch (e) {
      this.log({ probe: "failed", error: errMsg(e) });
      if (!this.readiness) throw e;
    }
    return this.readiness!.summary;
  }

  private beat(): Promise<void> {
    this.beating = this.beating.then(() => this.writeBeat());
    return this.beating;
  }

  private async writeBeat(): Promise<void> {
    if (!this.readiness || this.heartbeatClosed) return;
    try {
      await writeHeartbeat(this.opts.workRoot, {
        schema: HEARTBEAT_SCHEMA,
        workerId: this.workerId,
        pid: process.pid,
        startedAt: this.startedAt,
        lastHeartbeatAt: this.now(),
        workerVersion: WORKER_VERSION,
        workRoot: this.rootId,
        toolchain: {
          ...this.readiness.summary,
          state: this.gpuFailed ? "gpu_unavailable" : this.readiness.summary.state,
        },
        busy: this.busy,
      });
    } catch (e) {
      this.log({ heartbeat: "write_failed", error: errMsg(e) });
    }
  }

  private recordedTools(): RecordedTools | null {
    const p = this.readiness?.probe;
    if (!p?.colmap.fingerprint || !p.colmap.version || !p.brush.version) return null;
    return {
      colmap: { version: p.colmap.version, ...p.colmap.fingerprint },
      brush: { version: p.brush.version },
      spzEncoder: SPZ_ENCODER,
    };
  }

  // ───────────────────────── claim loop ─────────────────────────

  /** One idle step: sweep if due, re-probe if due, and claim + run at most one queued job. True when a job ran. */
  async tick(): Promise<boolean> {
    if (this.stopping || this.active) return false;
    if (Date.now() - this.lastSweep > 60 * 60 * 1000) await this.sweep();
    const summary = await this.refreshReadiness();
    if (summary.state !== "ready" || this.gpuFailed) return false;
    const queued = await this.opts.store.listQueued(5);
    for (const ref of queued) {
      if (this.stopping) return false;
      if (await this.claimAndRun(ref)) return true;
    }
    return false;
  }

  private async claimAndRun(ref: LocalJobRef): Promise<boolean> {
    if (ref.ownerId === null) {
      this.log({ jobId: ref.id, skip: "no owner" });
      return false;
    }
    const scope = await this.opts.store.scopeFor(ref);
    let job = await scope.repo.getReconstructionJob(ref.id);
    // never another provider's job, never a job that already moved on
    if (
      !job ||
      job.provider !== LOCAL_PROVIDER_ID ||
      job.status !== "queued" ||
      job.projectId !== ref.projectId
    )
      return false;
    const tools = this.recordedTools();
    const probe = this.readiness?.probe;
    if (!tools || !probe?.commands.colmap || !probe.commands.brush) return false;
    const runId = newRunId(job);
    try {
      job = await scope.repo.updateReconstructionJob(
        job.id,
        job.revision,
        {
          status: "submitting",
          providerOperationId: operationIdFor(runId),
          providerOperation: this.operation(runId, tools, "claimed", "Claimed by the local worker"),
        },
        this.now(),
      );
    } catch (e) {
      if (isRace(e)) {
        this.log({ jobId: ref.id, claim: "lost" });
        return false;
      }
      throw e;
    }
    this.log({ jobId: job.id, transition: "queued->submitting", runId });
    const toolchain: ToolchainForRun = {
      colmap: probe.commands.colmap,
      brush: probe.commands.brush,
      versions: { colmap: tools.colmap.version, brush: tools.brush.version },
    };
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    this.active = { jobId: job.id, runId, controller, done };
    void this.beat();
    try {
      await this.execute(scope, job, runId, tools, toolchain, controller);
    } catch (e) {
      // an unexpected worker error (e.g. the database went away): never leave a silent "running" if it can be helped
      this.log({ jobId: job.id, runId, error: errMsg(e) });
      await this.failIfActive(
        scope,
        job.id,
        runId,
        "provider_failed",
        "The local worker hit an unexpected error.",
      );
      await this.removeRun(runId);
    } finally {
      await rm(this.stagingDir(runId), { recursive: true, force: true }).catch(() => undefined);
      this.active = null;
      finish();
      void this.beat();
    }
    return true;
  }

  private operation(
    runId: string,
    tools: RecordedTools,
    stage: string,
    description: string,
  ): Record<string, unknown> {
    return {
      runner: "local_worker",
      workerId: this.workerId,
      runId,
      workRoot: this.rootId,
      quality: LOCAL_QUALITY,
      tools,
      stage,
      description,
    };
  }

  // ───────────────────────── one job ─────────────────────────

  private stagingDir(runId: string) {
    return path.join(this.opts.workRoot, ".staging", runId);
  }
  private runDir(runId: string) {
    return path.join(this.opts.workRoot, runId);
  }
  private async removeRun(runId: string) {
    for (const d of [this.runDir(runId), this.stagingDir(runId)])
      if (isWithin(this.opts.workRoot, d) && d !== this.opts.workRoot)
        await rm(d, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }

  private async event(scope: OwnerScope, job: ReconstructionJobRecord, ev: JobEvent, detail = {}) {
    await scope.repo.appendReconstructionJobEvent({
      projectId: job.projectId,
      jobId: job.id,
      event: ev,
      detail,
      now: this.now(),
    });
  }

  private async fail(
    scope: OwnerScope,
    job: ReconstructionJobRecord,
    code: JobErrorCode,
    message: string,
    extra: JobPatch = {},
  ): Promise<ReconstructionJobRecord | null> {
    try {
      const next = await scope.repo.updateReconstructionJob(
        job.id,
        job.revision,
        { ...extra, status: "failed", errorCode: code, errorMessage: sanitizeErrorMessage(message) },
        this.now(),
      );
      await this.event(scope, next, "failed", { code });
      this.log({ jobId: job.id, transition: `${job.status}->failed`, code });
      return next;
    } catch (e) {
      if (isRace(e)) return null; // the job ended another way first (e.g. the user cancelled): that is final
      throw e;
    }
  }

  /** Fails the job if it is still this run's and not finished (used after unexpected errors and on shutdown). */
  private async failIfActive(
    scope: OwnerScope,
    jobId: string,
    runId: string,
    code: JobErrorCode,
    message: string,
  ) {
    try {
      const job = await scope.repo.getReconstructionJob(jobId);
      if (job && !isTerminal(job.status) && runIdOf(job) === runId)
        await this.fail(scope, job, code, message);
    } catch (e) {
      this.log({ jobId, fail: "not_recorded", error: errMsg(e) });
    }
  }

  private async execute(
    scope: OwnerScope,
    claimed: ReconstructionJobRecord,
    runId: string,
    tools: RecordedTools,
    toolchain: ToolchainForRun,
    controller: AbortController,
  ): Promise<void> {
    let job = claimed;

    // ── submitting: verify every source against the frozen job, from PRIVATE storage, then stage it ──
    const staged = await this.stageSources(scope, job, runId, controller.signal);
    if (typeof staged === "string") {
      if (controller.signal.aborted) await this.fail(scope, job, "provider_failed", STOPPED_MESSAGE);
      else await this.fail(scope, job, "invalid_sources", staged);
      await this.removeRun(runId);
      return;
    }

    // ── running ──
    try {
      job = await scope.repo.updateReconstructionJob(
        job.id,
        job.revision,
        {
          status: "running",
          progress: 0,
          providerOperation: this.operation(runId, tools, "preparing", "Preparing the photographs"),
          lastPolledAt: this.now(),
        },
        this.now(),
      );
    } catch (e) {
      if (isRace(e)) return void (await this.removeRun(runId));
      throw e;
    }
    await this.event(scope, job, "submitted", { operation: `…${runId.slice(-8)}`, runner: "local_worker" });
    await this.event(scope, job, "provider_running", { stage: "preparing" });
    this.log({ jobId: job.id, transition: "submitting->running", runId });

    // a single write chain: progress writes and the final transition never race each other
    let writes: Promise<void> = Promise.resolve();
    let lastStage = "preparing";
    let lastWrite = Date.now();
    let pending: LocalReconstructionProgress | null = null;
    const abort = (reason: AbortReason) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const write = (p: LocalReconstructionProgress, stageChange: boolean) => {
      writes = writes.then(async () => {
        if (controller.signal.aborted) return;
        try {
          job = await scope.repo.updateReconstructionJob(
            job.id,
            job.revision,
            {
              status: "running",
              progress: p.progress,
              providerOperation: this.operation(runId, tools, p.stage, p.message),
            },
            this.now(),
          );
          if (stageChange) await this.event(scope, job, "progress", { stage: p.stage, progress: p.progress });
        } catch (e) {
          if (!isRace(e)) return this.log({ jobId: job.id, progress: "write_failed", error: errMsg(e) });
          // someone else changed the job: only a cancel (or another terminal outcome) can, so stop
          const current = await scope.repo.getReconstructionJob(job.id).catch(() => null);
          if (!current || current.status !== "running" || runIdOf(current) !== runId)
            abort(current?.status === "cancelled" ? "cancelled" : "lost");
          else job = current;
        }
      });
    };
    let stagingRemoved = false;
    const onProgress = (p: LocalReconstructionProgress) => {
      if (p.stage === "complete") return; // the import transition records completion
      if (p.stage !== "preparing" && !stagingRemoved) {
        // the engine has its own verified copies now: do not keep a second copy of every photograph during training
        stagingRemoved = true;
        void rm(this.stagingDir(runId), { recursive: true, force: true }).catch(() => undefined);
      }
      if (p.stage !== lastStage) {
        lastStage = p.stage;
        lastWrite = Date.now();
        pending = null;
        write(p, true);
      } else pending = p;
    };
    const flusher = setInterval(
      () => {
        if (pending && Date.now() - lastWrite >= this.timing.progressWriteMs) {
          const p = pending;
          pending = null;
          lastWrite = Date.now();
          write(p, false);
        }
      },
      Math.max(100, Math.min(this.timing.progressWriteMs, 1000)),
    );
    // the cancellation watch: a cancelled (or otherwise finished) job stops the tools within seconds
    const watcher = setInterval(() => {
      void scope.repo
        .getReconstructionJob(job.id)
        .then((current) => {
          if (!current || current.status !== "running" || runIdOf(current) !== runId)
            abort(current?.status === "cancelled" ? "cancelled" : "lost");
        })
        .catch(() => undefined); // a transient read failure is not a cancellation
    }, this.timing.cancelCheckMs);

    let result: Awaited<ReturnType<typeof runLocalReconstruction>> | null = null;
    let failure: LocalReconstructionError | null = null;
    try {
      result = await this.engine(toEngineRequest(runId, staged), {
        toolchain,
        workRoot: this.opts.workRoot,
        limits: this.limits,
        onProgress,
        signal: controller.signal,
        now: this.now,
      });
    } catch (e) {
      failure =
        e instanceof LocalReconstructionError
          ? e
          : new LocalReconstructionError("workspace_failed", `Unexpected engine failure: ${errMsg(e)}`);
    } finally {
      clearInterval(flusher);
      clearInterval(watcher);
      await writes;
    }
    await rm(this.stagingDir(runId), { recursive: true, force: true }).catch(() => undefined);

    if (failure)
      return this.afterFailure(scope, job, runId, failure, controller.signal.reason as AbortReason);
    await this.importResult(scope, job, runId, tools, result!.metadata, result!.checksum);
  }

  /** Verifies and stages each source in order. Returns the staged files, or a user-facing reason. */
  private async stageSources(
    scope: OwnerScope,
    job: ReconstructionJobRecord,
    runId: string,
    signal: AbortSignal,
  ): Promise<Array<{ ordinal: number; path: string; checksum: string; mime: string }> | string> {
    const problem = sourceListProblem(job, this.limits);
    if (problem) return problem;
    const dir = this.stagingDir(runId);
    await mkdir(dir, { recursive: true });
    const out = [];
    const changed = "A reference image changed or is no longer readable. Create a new job.";
    for (const s of job.sources) {
      if (signal.aborted) return STOPPED_MESSAGE;
      const asset = await scope.findAsset(s.assetId);
      if (
        !asset ||
        asset.projectId !== job.projectId ||
        asset.type !== "image" ||
        asset.mime !== s.mime ||
        asset.checksum !== s.checksum
      )
        return changed;
      const bytes = await scope.readAssetBytes(asset);
      if (!bytes || createHash("sha256").update(bytes).digest("hex") !== s.checksum) return changed;
      const file = path.join(
        dir,
        `${String(s.ordinal + 1).padStart(6, "0")}.${SUPPORTED_INPUT_MIMES[s.mime as SupportedInputMime]}`,
      );
      await writeFile(file, bytes, { flag: "wx" });
      out.push({ ordinal: s.ordinal, path: file, checksum: s.checksum!, mime: s.mime! });
    }
    return out;
  }

  private async afterFailure(
    scope: OwnerScope,
    job: ReconstructionJobRecord,
    runId: string,
    err: LocalReconstructionError,
    reason: AbortReason | undefined,
  ) {
    if (err.code === "cancelled") {
      // the user cancelled (already terminal) or the job ended elsewhere: nothing to write, nothing kept
      if (reason === "shutdown") await this.fail(scope, job, "provider_failed", STOPPED_MESSAGE);
      this.log({ jobId: job.id, runId, outcome: reason === "shutdown" ? "stopped" : "cancelled" });
      await this.removeRun(runId);
      return;
    }
    if (err.code === "gpu_unavailable") {
      this.gpuFailed = true;
      void this.beat();
    }
    const f = jobFailureFor(err);
    await this.fail(scope, job, f.code, f.message, {
      providerOperation: { ...(job.providerOperation ?? {}), stage: "failed", localError: f.detail },
    });
    // the engine already removed inputs, COLMAP/Brush work and partial output; only bounded logs + the failure
    // manifest stay (removed by the sweeper after the retention period)
    this.log({ jobId: job.id, runId, outcome: "failed", localCode: err.code, stage: err.stage });
  }

  // ───────────────────────── import (shared M2D.2 ingestion) ─────────────────────────

  private async importResult(
    scope: OwnerScope,
    running: ReconstructionJobRecord,
    runId: string,
    tools: RecordedTools,
    metadata: LocalRunMetadata,
    checksum: string,
  ): Promise<void> {
    await this.opts.hooks?.beforeIngestClaim?.(running);
    // a cancel that won is final; the re-read and the compare-and-set below decide, never a stale copy
    let job = await scope.repo.getReconstructionJob(running.id);
    if (!job || runIdOf(job) !== runId || (job.status !== "running" && job.status !== "ingesting")) {
      this.log({ jobId: running.id, runId, outcome: "discarded", status: job?.status ?? "missing" });
      await this.removeRun(runId);
      return;
    }
    if (job.status === "running") {
      try {
        job = await scope.repo.updateReconstructionJob(
          job.id,
          job.revision,
          {
            status: "ingesting",
            progress: 1,
            providerOperation: this.operation(runId, tools, "ingesting", "Importing the result"),
          },
          this.now(),
        );
      } catch (e) {
        if (!isRace(e)) throw e;
        this.log({ jobId: running.id, runId, outcome: "discarded", reason: "lost the import claim" });
        await this.removeRun(runId);
        return;
      }
      await this.event(scope, job, "provider_succeeded", { runner: "local_worker" });
      await this.event(scope, job, "ingesting");
    }

    const spzPath = path.join(this.runDir(runId), "output", "splat.spz");
    const bytes = new Uint8Array(await readFile(spzPath));
    const location = await scope.locationName(job.locationId);
    const deps = {
      repo: scope.repo,
      store: scope.store,
      storage: scope.storage,
      userId: scope.userId,
      now: this.now,
      newId: this.newId,
      locationName: () => location,
      log: (e: Record<string, unknown>) => this.log(e),
    };
    const providerResult = localProvenance(metadata, tools, { workerId: this.workerId, runId });
    for (let attempt = 1; ; attempt++) {
      const out = await ingestReconstructionResult(deps, job, {
        bytes,
        label: `local-${metadata.quality}`,
        fileHint: ".spz",
        // COLMAP/Brush scale is arbitrary: never inferred as metres; manual calibration stays authoritative
        calibration: { ...UNKNOWN_CALIBRATION },
        providerResult,
        expectedChecksum: checksum,
      });
      if (out.kind === "succeeded" || out.kind === "lost_race") {
        this.log({ jobId: job.id, runId, outcome: out.kind === "succeeded" ? "succeeded" : "lost_race" });
        break;
      }
      if (out.kind === "invalid") {
        await this.fail(scope, job, out.code, out.message);
        break;
      }
      if (attempt >= this.timing.ingestAttempts) {
        await this.fail(scope, job, "ingest_failed", `Storing the result failed: ${out.message}`);
        break;
      }
      this.log({ jobId: job.id, runId, ingest: "retry", attempt, error: out.message.slice(0, 200) });
      await sleep(this.timing.ingestRetryMs * attempt);
      const current = await scope.repo.getReconstructionJob(job.id);
      if (!current || current.status !== "ingesting" || runIdOf(current) !== runId) break;
      job = current;
    }
    // Prism's private Asset is now the durable copy (or the job failed): nothing of the run is kept
    await this.removeRun(runId);
  }

  // ───────────────────────── restart recovery ─────────────────────────

  /**
   * Runs at startup, holding the lock (so no other worker on this root is working on them). Only jobs claimed from
   * THIS work root are touched; another root's jobs belong to its own worker.
   */
  async recover(): Promise<{ resumed: number; failed: number }> {
    let resumed = 0;
    let failed = 0;
    for (const ref of await this.opts.store.listInFlight()) {
      if (ref.ownerId === null) continue;
      try {
        const scope = await this.opts.store.scopeFor(ref);
        const job = await scope.repo.getReconstructionJob(ref.id);
        if (!job || job.provider !== LOCAL_PROVIDER_ID || isTerminal(job.status)) continue;
        if (job.providerOperation?.workRoot !== this.rootId) continue;
        const runId = runIdOf(job);
        if (runId && (job.status === "running" || job.status === "ingesting")) {
          const retained = await this.verifyRetained(job, runId);
          if (retained.ok) {
            this.log({ jobId: job.id, runId, recovery: "resume_import" });
            await this.importResult(scope, job, runId, retained.tools, retained.metadata, retained.checksum);
            resumed++;
            continue;
          }
          this.log({ jobId: job.id, runId, recovery: "fail", reason: retained.reason });
        }
        await this.fail(scope, job, "provider_failed", STOPPED_MESSAGE);
        if (runId) await this.removeRun(runId);
        failed++;
      } catch (e) {
        // one unreadable job must not keep the worker from starting; it is retried on the next start
        this.log({ jobId: ref.id, recovery: "error", error: errMsg(e) });
      }
    }
    return { resumed, failed };
  }

  /**
   * A retained run may be imported only when EVERYTHING matches: the run manifest (schema, succeeded, this run id),
   * the job's ordered source checksums, the tool provenance recorded on the job (and the still-verified COLMAP build),
   * and the output (size cap, sha256 against the manifest, splat validation, Gaussian count). Arbitrary SPZ files in
   * the work root are never imported.
   */
  private async verifyRetained(
    job: ReconstructionJobRecord,
    runId: string,
  ): Promise<
    | { ok: true; metadata: LocalRunMetadata; tools: RecordedTools; checksum: string }
    | { ok: false; reason: string }
  > {
    const no = (reason: string) => ({ ok: false as const, reason });
    const op = job.providerOperation ?? {};
    if (op.runId !== runId) return no("run identity");
    const tools = op.tools as RecordedTools | undefined;
    if (!tools?.colmap?.binarySha256 || !tools.brush?.version) return no("no recorded tools");
    let manifest: {
      schema?: unknown;
      status?: unknown;
      runId?: unknown;
      inputs?: Array<{ checksum?: unknown }>;
      metadata?: LocalRunMetadata;
      outputs?: { spz?: unknown };
    };
    try {
      manifest = JSON.parse(await readFile(path.join(this.runDir(runId), "manifest.json"), "utf8"));
    } catch {
      return no("no manifest");
    }
    if (manifest.schema !== LOCAL_RUN_SCHEMA || manifest.status !== "succeeded" || manifest.runId !== runId)
      return no("manifest identity");
    const inputs = manifest.inputs ?? [];
    if (
      inputs.length !== job.sources.length ||
      job.sources.some((s, i) => inputs[i]?.checksum !== s.checksum)
    )
      return no("source checksums");
    const m = manifest.metadata;
    if (!m || m.tools?.colmap !== tools.colmap.version || m.tools.brush !== tools.brush.version)
      return no("tool versions");
    if (this.readiness?.probe.colmap.fingerprint?.binarySha256 !== tools.colmap.binarySha256)
      return no("COLMAP provenance changed");
    if (manifest.outputs?.spz !== "output/splat.spz") return no("output");
    const spzPath = path.join(this.runDir(runId), "output", "splat.spz");
    const s = await stat(spzPath).catch(() => null);
    if (!s?.isFile() || s.size > MAX_SPLAT_BYTES || s.size !== m.spz?.byteSize) return no("output size");
    const bytes = await readFile(spzPath);
    const sum = createHash("sha256").update(bytes).digest("hex");
    if (sum !== m.spz.checksum) return no("output checksum");
    const inspected = inspectSplat(new Uint8Array(bytes), "splat.spz");
    if (!inspected.ok || inspected.gaussianCount !== m.spz.gaussianCount) return no("output validation");
    return { ok: true, metadata: m, tools, checksum: sum };
  }

  // ───────────────────────── workspace sweeper ─────────────────────────

  /** Removes this worker's old run and staging directories by age; never the active run. */
  async sweep(force = false): Promise<number> {
    if (!force && Date.now() - this.lastSweep < 60 * 60 * 1000) return 0;
    this.lastSweep = Date.now();
    let removed = 0;
    const cutoff = Date.now() - this.timing.staleWorkspaceMs;
    const candidates = [
      ...(await readdir(this.opts.workRoot).catch(() => [] as string[])).map((n) =>
        path.join(this.opts.workRoot, n),
      ),
      ...(await readdir(path.join(this.opts.workRoot, ".staging")).catch(() => [] as string[])).map((n) =>
        path.join(this.opts.workRoot, ".staging", n),
      ),
    ];
    for (const dir of candidates) {
      const name = path.basename(dir);
      if (!name.startsWith("lr-") || name === this.active?.runId) continue;
      const s = await stat(dir).catch(() => null);
      if (!s?.isDirectory() || s.mtimeMs > cutoff) continue;
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      removed++;
    }
    if (removed) this.log({ sweep: "removed", count: removed });
    return removed;
  }
}

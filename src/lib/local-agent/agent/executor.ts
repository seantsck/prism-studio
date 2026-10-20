import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { MAX_SPLAT_BYTES } from "@/domain/previs/splat";
import { inspectSplat } from "@/lib/splat/inspect";
import {
  DEFAULT_ENGINE_LIMITS,
  runLocalReconstruction,
  type LocalEngineLimits,
  type ToolchainForRun,
} from "../../reconstruction/local/engine";
import {
  LOCAL_RUN_SCHEMA,
  LocalReconstructionError,
  SUPPORTED_INPUT_MIMES,
  type LocalReconstructionResult,
  type LocalStage,
} from "../../reconstruction/local/types";
import { assertRunId } from "../../reconstruction/local/workspace";
import {
  finalResultSchema,
  KEEPALIVE_INTERVAL_MS,
  REMOTE_QUALITY,
  type AgentFailureCode,
  type FinalResult,
  type Lease,
  type ProgressRequest,
  type RemoteStage,
} from "../protocol";
import { AgentRequestError, FATAL_CODES, type AgentClient } from "./client";
import { AgentStateError } from "./store";
import { clearJobState, writeJobState, type JobStage, type JobState } from "./job-state";

/**
 * Runs ONE leased remote reconstruction on this workstation (Phase 2F M2D.3C2):
 *
 *   persist the lease → download exactly its photographs (verified) → M2D.3A engine (COLMAP → Brush → PLY → SPZ)
 *   → declare the validated result (final progress) → upload the one SPZ → Prism imports it → clean up
 *
 * Throughout, a signed keepalive renews the lease about every 10 s. Authority is the lease, nothing else:
 *   - Prism says the job was cancelled        → abort the engine (process tree), upload nothing, clean up
 *   - Prism says the lease/job is gone        → abort, upload nothing, clean up
 *   - Prism cannot be reached until the lease would have expired (as measured from the last renewal, on THIS clock)
 *                                             → abort: never keep training under expired authority
 * A restart never silently re-runs COLMAP/Brush: a retained VALIDATED result is uploaded; anything else is reported
 * failed and the user's Retry creates a new attempt.
 */

export interface JobToolchain {
  /** how to run COLMAP and Brush (from the M2D.3A probe; ready only) */
  run: ToolchainForRun;
  /** the verified identity of what runs (must equal what Prism recorded at lease time) */
  tools: { colmap: FinalResult["colmap"]; brush: FinalResult["brush"] };
}

export interface ExecutorOptions {
  client: Pick<AgentClient, "progress" | "fail" | "downloadSource" | "uploadResult" | "device">;
  profileDir: string;
  /** absolute, outside the repository: run workspaces live here (one directory per run) */
  workRoot: string;
  toolchain: JobToolchain | null;
  engine?: typeof runLocalReconstruction;
  limits?: LocalEngineLimits;
  keepaliveMs?: number;
  /** abort renewing this long before the lease would expire (clock jitter, request time) */
  marginMs?: number;
  /** the agent is shutting down */
  signal?: AbortSignal;
  log?: (line: string) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type JobOutcome =
  | { kind: "succeeded"; jobId: string }
  | { kind: "failed"; jobId: string; code: string }
  | { kind: "cancelled"; jobId: string }
  /** the lease or job is gone (expired, reaped, revoked, refused): nothing uploaded */
  | { kind: "lost"; jobId: string; reason: string }
  /** Prism could not be told yet (network); the state is kept and the agent tries again later */
  | { kind: "deferred"; jobId: string }
  | { kind: "fatal"; jobId: string; code: string; message: string };

type AbortReason = "cancelled" | "lost" | "lease_lost" | "shutdown" | "fatal";

const LOST_CODES = new Set(["lease_expired", "lease_mismatch", "job_not_available"]);

export const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/** `ra-<job>-a<attempt>-<random>`: the run workspace's directory name (no path, no secret). */
export function newRemoteRunId(jobId: string, attempt: number): string {
  const id = `ra-${jobId.replace(/[^0-9a-f]/g, "").slice(0, 12)}-a${attempt}-${randomBytes(4).toString("hex")}`;
  assertRunId(id);
  return id;
}

/** The final result declaration, built from the engine's own metadata (safe facts only: no path, host or user). */
export function finalResultFrom(r: LocalReconstructionResult, tools: JobToolchain["tools"]): FinalResult {
  const m = r.metadata;
  return finalResultSchema.parse({
    format: "spz",
    sha256: r.checksum,
    byteSize: r.byteSize,
    gaussianCount: r.gaussianCount,
    shDegree: m.spz.shDegreeOut,
    inputImages: m.colmap.metrics.inputImages,
    registeredImages: m.colmap.metrics.registeredImages,
    registrationRatio: Math.min(1, Math.max(0, m.colmap.metrics.registrationRatio)),
    sparsePoints: m.colmap.metrics.sparsePoints,
    quality: REMOTE_QUALITY,
    colmap: tools.colmap,
    brush: tools.brush,
    spzEncoder: m.tools.spzEncoder,
    spzVersion: m.spz.spzVersion,
    lossless: false,
    clamped: m.spz.clamped,
  });
}

/** The lease deadline on THIS clock: renewed from each answer's remaining time (server clocks are never compared). */
class LeaseClock {
  private deadline: number;
  constructor(remainingMs: number) {
    this.deadline = Date.now() + remainingMs;
  }
  renew(a: { leaseExpiresAt: string; serverTime: string }) {
    const remaining = Date.parse(a.leaseExpiresAt) - Date.parse(a.serverTime);
    if (Number.isFinite(remaining)) this.deadline = Date.now() + remaining;
  }
  remaining() {
    return this.deadline - Date.now();
  }
}

class Run {
  readonly controller = new AbortController();
  private stage: RemoteStage = "downloading";
  private progressValue = 0;
  private message = "Downloading the photographs";
  private result: FinalResult | undefined;
  private wake: (() => void) | null = null;
  private stopped = false;
  private loop: Promise<void> = Promise.resolve();
  private readonly sleep: NonNullable<ExecutorOptions["sleep"]>;

  constructor(
    readonly o: ExecutorOptions,
    readonly state: JobState,
    readonly clock: LeaseClock,
  ) {
    this.sleep = o.sleep ?? defaultSleep;
    const onShutdown = () => this.abort("shutdown");
    if (o.signal?.aborted) onShutdown();
    else o.signal?.addEventListener("abort", onShutdown, { once: true });
  }

  get signal() {
    return this.controller.signal;
  }
  get reason(): AbortReason | undefined {
    return this.controller.signal.reason as AbortReason | undefined;
  }
  get currentStage() {
    return this.stage;
  }
  log(line: string) {
    this.o.log?.(`job …${this.state.jobId.slice(-8)}: ${line}`);
  }

  abort(reason: AbortReason) {
    if (!this.controller.signal.aborted) {
      this.log(`stopping (${reason})`);
      this.controller.abort(reason);
    }
  }

  async persist(stage: JobStage, extra: Partial<JobState> = {}) {
    Object.assign(this.state, extra, { stage, updatedAt: new Date().toISOString() });
    await writeJobState(this.o.profileDir, this.state);
  }

  set(stage: RemoteStage, progress: number, message: string, result?: FinalResult) {
    const changed = stage !== this.stage;
    this.stage = stage;
    this.progressValue = progress;
    this.message = message.slice(0, 300);
    if (result) this.result = result;
    if (changed) this.wake?.();
  }

  /** One signed keepalive with the current progress. Returns false when the run must stop. */
  async tick(): Promise<boolean> {
    if (this.signal.aborted) return false;
    const body: Omit<ProgressRequest, "protocol"> = {
      stage: this.stage,
      progress: this.progressValue,
      message: this.message,
      ...(this.result ? { result: this.result } : {}),
    };
    try {
      const r = await this.o.client.progress(this.state.jobId, this.state.leaseId, body);
      this.clock.renew(r);
      return true;
    } catch (e) {
      // local state gone or unreadable (profile forgotten, revoked locally): this device cannot sign again
      if (e instanceof AgentStateError) {
        this.abort("fatal");
        return false;
      }
      if (!(e instanceof AgentRequestError)) {
        this.log(`keepalive error (${e instanceof Error ? e.name : "unknown"}); retrying`);
        if (this.clock.remaining() <= (this.o.marginMs ?? 5_000)) this.abort("lease_lost");
        return !this.signal.aborted;
      }
      if (e.code === "job_cancelled") this.abort("cancelled");
      else if (LOST_CODES.has(e.code) || e.code === "result_rejected") this.abort("lost");
      else if (FATAL_CODES.has(e.code)) this.abort("fatal");
      else this.log(`keepalive failed (${e.code}); retrying`);
      if (this.clock.remaining() <= (this.o.marginMs ?? 5_000)) this.abort("lease_lost");
      return !this.signal.aborted;
    }
  }

  start() {
    const every = this.o.keepaliveMs ?? KEEPALIVE_INTERVAL_MS;
    this.loop = (async () => {
      while (!this.stopped && !this.signal.aborted) {
        const margin = this.o.marginMs ?? 5_000;
        // wake early enough to renew, and never sleep past the point where the lease must be given up
        const wait = Math.max(0, Math.min(every, this.clock.remaining() - margin));
        await new Promise<void>((resolve) => {
          const t = setTimeout(done, wait);
          const stop = () => done();
          this.signal.addEventListener("abort", stop, { once: true });
          this.wake = done;
          function done() {
            clearTimeout(t);
            resolve();
          }
        });
        this.wake = null;
        if (this.stopped || this.signal.aborted) break;
        if (this.clock.remaining() <= margin) {
          // the last renewal is about to lapse: one last try, then stop the tools
          await this.tick();
          if (this.clock.remaining() <= margin) this.abort("lease_lost");
          continue;
        }
        await this.tick();
      }
    })();
  }

  async stop() {
    this.stopped = true;
    this.wake?.();
    await this.loop;
  }

  wait(ms: number) {
    return this.sleep(ms, this.signal);
  }
}

// ───────────────────────── workspace helpers ─────────────────────────

const runDir = (o: ExecutorOptions, runId: string) => path.join(o.workRoot, runId);
const stagingDir = (o: ExecutorOptions, runId: string) => path.join(o.workRoot, ".staging", runId);

/** After failure/cancellation: only the engine's bounded logs and manifest may stay (removed by the sweeper later). */
async function reduceRun(o: ExecutorOptions, runId: string) {
  await rm(stagingDir(o, runId), { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  for (const sub of ["input", "output", "colmap", "brush"])
    await rm(path.join(runDir(o, runId), sub), { recursive: true, force: true, maxRetries: 3 }).catch(
      () => undefined,
    );
}

async function removeRun(o: ExecutorOptions, runId: string) {
  await rm(stagingDir(o, runId), { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  await rm(runDir(o, runId), { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
}

/** Removes this agent's run directories older than `maxAgeMs` (never following a link out of the work root). */
export async function sweepRuns(workRoot: string, maxAgeMs = 3 * 24 * 60 * 60 * 1000, keep?: string) {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const base of [workRoot, path.join(workRoot, ".staging")])
    for (const name of await readdir(base).catch(() => [] as string[])) {
      if (!name.startsWith("ra-") || name === keep) continue;
      const dir = path.join(base, name);
      const s = await lstat(dir).catch(() => null);
      if (!s?.isDirectory() || s.isSymbolicLink() || s.mtimeMs > cutoff) continue;
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      removed++;
    }
  return removed;
}

// ───────────────────────── reporting ─────────────────────────

const ENGINE_TO_REMOTE: Partial<Record<LocalStage, RemoteStage>> = {
  preparing: "preparing",
  camera_reconstruction: "camera_reconstruction",
  splat_training: "splat_training",
  validating_ply: "validating_ply",
  converting_spz: "converting_spz",
  validating_spz: "validating_spz",
};

/** Tells Prism the attempt failed (the server chooses the job error). Network trouble → "deferred". */
async function report(
  run: Run,
  code: AgentFailureCode,
  message: string,
): Promise<"reported" | "gone" | "cancelled" | "deferred"> {
  try {
    await run.o.client.fail(run.state.jobId, run.state.leaseId, {
      code,
      stage: run.currentStage,
      message: message.replace(/\p{Cc}/gu, " ").slice(0, 300),
    });
    return "reported";
  } catch (e) {
    if (!(e instanceof AgentRequestError)) throw e;
    if (e.code === "job_cancelled") return "cancelled";
    if (LOST_CODES.has(e.code) || FATAL_CODES.has(e.code)) return "gone";
    return "deferred";
  }
}

async function finish(
  run: Run,
  outcome: JobOutcome,
  keep: "remove" | "reduce" | "state",
): Promise<JobOutcome> {
  await run.stop();
  if (keep === "remove") await removeRun(run.o, run.state.runId);
  if (keep === "reduce") await reduceRun(run.o, run.state.runId);
  if (outcome.kind !== "deferred") await clearJobState(run.o.profileDir);
  run.log(`outcome ${outcome.kind}${"code" in outcome ? ` (${outcome.code})` : ""}`);
  return outcome;
}

/** The outcome after the run was stopped for `reason` (never uploads anything). */
async function stoppedOutcome(run: Run): Promise<JobOutcome> {
  const jobId = run.state.jobId;
  switch (run.reason) {
    case "cancelled":
      return finish(run, { kind: "cancelled", jobId }, "reduce");
    case "shutdown": {
      // the agent is stopping on purpose: say so (the attempt fails cleanly; Retry creates a new one)
      const r = await report(run, "cancelled", "The Local Agent was stopped.");
      return finish(
        run,
        r === "deferred" ? { kind: "deferred", jobId } : { kind: "failed", jobId, code: "cancelled" },
        r === "deferred" ? "state" : "reduce",
      );
    }
    case "fatal":
      return finish(
        run,
        { kind: "fatal", jobId, code: "fatal", message: "The device can no longer sign requests." },
        "reduce",
      );
    default:
      return finish(run, { kind: "lost", jobId, reason: run.reason ?? "lost" }, "reduce");
  }
}

// ───────────────────────── run a new lease ─────────────────────────

/** Runs `body`; an unexpected error never leaves the keepalive running (the persisted state decides on restart). */
async function guarded(run: Run, body: () => Promise<JobOutcome>): Promise<JobOutcome> {
  try {
    return await body();
  } catch (e) {
    run.abort("shutdown");
    await run.stop();
    throw e;
  }
}

export async function executeLease(
  o: ExecutorOptions,
  lease: Lease,
  serverTime: string,
): Promise<JobOutcome> {
  const d = o.client.device;
  const state: JobState = {
    schema: "prism.local-agent-job.v1",
    deviceId: d.deviceId,
    projectId: d.projectId,
    jobId: lease.jobId,
    attempt: lease.attempt,
    leaseId: lease.leaseId,
    leaseExpiresAt: lease.leaseExpiresAt,
    sources: lease.sources.map((s) => ({
      ordinal: s.ordinal,
      mime: s.mime,
      byteSize: s.byteSize,
      sha256: s.sha256,
    })),
    runId: newRemoteRunId(lease.jobId, lease.attempt),
    stage: "leased",
    result: null,
    updatedAt: new Date().toISOString(),
  };
  // the lease is persisted BEFORE anything is downloaded: a restart knows this job exists
  await writeJobState(o.profileDir, state);
  const clock = new LeaseClock(Date.parse(lease.leaseExpiresAt) - Date.parse(serverTime));
  const run = new Run(o, state, clock);
  return guarded(run, () => executeLeased(o, run, lease));
}

async function executeLeased(o: ExecutorOptions, run: Run, lease: Lease): Promise<JobOutcome> {
  const state = run.state;
  run.log(`leased (attempt ${lease.attempt}, ${lease.sources.length} photographs)`);
  if (!o.toolchain) {
    const r = await report(run, "toolchain_missing", "The local toolchain is not ready.");
    return finish(
      run,
      r === "deferred"
        ? { kind: "deferred", jobId: lease.jobId }
        : { kind: "failed", jobId: lease.jobId, code: "toolchain_missing" },
      r === "deferred" ? "state" : "remove",
    );
  }
  run.start();
  // tell Prism right away that the workstation has it (and renew the lease)
  run.set("downloading", 0, "Downloading the photographs");
  if (!(await run.tick())) return stoppedOutcome(run);

  // ── download exactly this lease's photographs, verified ──
  await run.persist("downloading");
  const staging = stagingDir(o, state.runId);
  await mkdir(staging, { recursive: true });
  const files: Array<{ ordinal: number; path: string; checksum: string; mime: string }> = [];
  for (const s of lease.sources) {
    const file = path.join(
      staging,
      `${String(s.ordinal + 1).padStart(6, "0")}.${SUPPORTED_INPUT_MIMES[s.mime]}`,
    );
    for (let attempt = 1; ; attempt++) {
      if (run.signal.aborted) return stoppedOutcome(run);
      try {
        await o.client.downloadSource(s, file, run.signal);
        break;
      } catch (e) {
        if (!(e instanceof AgentRequestError)) throw e;
        if (e.code === "source_mismatch") {
          const r = await report(run, "source_invalid", e.message);
          if (r === "deferred") return finish(run, { kind: "deferred", jobId: lease.jobId }, "state");
          return finish(run, { kind: "failed", jobId: lease.jobId, code: "source_invalid" }, "remove");
        }
        if (e.code === "aborted") return stoppedOutcome(run);
        if (e.code === "job_cancelled") run.abort("cancelled");
        else if (LOST_CODES.has(e.code) || e.code === "source_unavailable") run.abort("lost");
        else if (FATAL_CODES.has(e.code)) run.abort("fatal");
        else if (run.clock.remaining() <= (o.marginMs ?? 5_000) || attempt >= 20) run.abort("lease_lost");
        if (run.signal.aborted) return stoppedOutcome(run);
        run.log(`download of photograph ${s.ordinal + 1} failed (${e.code}); retrying`);
        await run.wait(Math.min(10_000, 1_000 * attempt));
      }
    }
    files.push({ ordinal: s.ordinal, path: file, checksum: s.sha256, mime: s.mime });
    run.set(
      "downloading",
      Math.round(((s.ordinal + 1) / lease.sources.length) * 0.02 * 1000) / 1000,
      `Downloaded ${s.ordinal + 1} of ${lease.sources.length} photographs`,
    );
  }

  // ── the M2D.3A engine, exactly as on the same-host worker ──
  await run.persist("reconstructing");
  let stagingRemoved = false;
  let result: LocalReconstructionResult;
  try {
    result = await (o.engine ?? runLocalReconstruction)(
      {
        runId: state.runId,
        quality: REMOTE_QUALITY,
        inputs: files.map((f) => ({
          ordinal: f.ordinal,
          source: { kind: "file", path: f.path },
          checksum: f.checksum,
          mime: f.mime,
        })),
      },
      {
        toolchain: o.toolchain.run,
        workRoot: o.workRoot,
        limits: o.limits ?? DEFAULT_ENGINE_LIMITS,
        signal: run.signal,
        onProgress: (p) => {
          if (p.stage === "complete") return;
          if (p.stage !== "preparing" && !stagingRemoved) {
            // the engine has its own verified copies now: no second copy of every photograph during training
            stagingRemoved = true;
            void rm(staging, { recursive: true, force: true }).catch(() => undefined);
          }
          const stage = ENGINE_TO_REMOTE[p.stage];
          if (stage) run.set(stage, p.progress, p.message);
        },
      },
    );
  } catch (e) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (run.signal.aborted) return stoppedOutcome(run);
    const err =
      e instanceof LocalReconstructionError
        ? e
        : new LocalReconstructionError("workspace_failed", "Unexpected engine failure.");
    run.log(`engine failed: ${err.code}`);
    const r = await report(run, err.code, err.message);
    if (r === "deferred") return finish(run, { kind: "deferred", jobId: lease.jobId }, "state");
    return finish(
      run,
      r === "cancelled"
        ? { kind: "cancelled", jobId: lease.jobId }
        : { kind: "failed", jobId: lease.jobId, code: err.code },
      "reduce",
    );
  }
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  // a cancellation that won the race is never reported as success
  if (run.signal.aborted) return stoppedOutcome(run);

  const declared = finalResultFrom(result, o.toolchain.tools);
  await run.persist("result_ready", { result: declared });
  return upload(run, declared);
}

// ───────────────────────── declare + upload (new runs and resumed ones) ─────────────────────────

async function upload(run: Run, declared: FinalResult): Promise<JobOutcome> {
  const jobId = run.state.jobId;
  run.set("uploading", 1, "Uploading the result", declared);
  // the declaration must be accepted (and frozen) before the bytes go
  if (!(await run.tick())) return stoppedOutcome(run);
  await run.persist("uploading");
  const spz = path.join(runDir(run.o, run.state.runId), "output", "splat.spz");
  const bytes = new Uint8Array(await readFile(spz));
  if (bytes.length !== declared.byteSize || sha256(bytes) !== declared.sha256) {
    const r = await report(run, "spz_invalid", "The retained result changed on disk before upload.");
    return finish(
      run,
      r === "deferred" ? { kind: "deferred", jobId } : { kind: "failed", jobId, code: "spz_invalid" },
      r === "deferred" ? "state" : "reduce",
    );
  }
  for (let attempt = 1; ; attempt++) {
    if (run.signal.aborted) return stoppedOutcome(run);
    try {
      const out = await run.o.client.uploadResult(jobId, run.state.leaseId, bytes);
      if (out.job.status === "succeeded") {
        run.log(`imported by Prism (reconstruction ${out.job.reconstructionId ?? "?"})`);
        // Prism's private Asset is now the durable copy: nothing of the run is kept
        return finish(run, { kind: "succeeded", jobId }, "remove");
      }
      return finish(
        run,
        out.job.status === "cancelled"
          ? { kind: "cancelled", jobId }
          : { kind: "failed", jobId, code: out.job.status },
        "reduce",
      );
    } catch (e) {
      if (!(e instanceof AgentRequestError)) throw e;
      if (e.code === "job_cancelled") return finish(run, { kind: "cancelled", jobId }, "reduce");
      if (e.code === "result_rejected")
        return finish(run, { kind: "failed", jobId, code: "result_rejected" }, "reduce");
      if (LOST_CODES.has(e.code)) return finish(run, { kind: "lost", jobId, reason: e.code }, "reduce");
      if (FATAL_CODES.has(e.code)) {
        run.abort("fatal");
        return stoppedOutcome(run);
      }
      // result_pending (Prism is importing an earlier upload) or a network failure: ask again with a NEW request
      if (attempt >= 40) {
        run.abort("lease_lost");
        return stoppedOutcome(run);
      }
      run.log(`upload: ${e.code}; asking again`);
      await run.wait(e.code === "result_pending" ? 3_000 : Math.min(15_000, 2_000 * attempt));
      if (e.code !== "result_pending" && !(await run.tick())) return stoppedOutcome(run);
    }
  }
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * A retained result may be uploaded after a restart only when EVERYTHING matches: the run manifest (schema, succeeded,
 * this run id, the lease's ordered source checksums), and the SPZ on disk (size cap, size, sha256, SPZ validation and
 * Gaussian count) against the declaration persisted before the crash. Arbitrary files are never uploaded.
 */
export async function verifyRetained(
  workRoot: string,
  state: JobState,
): Promise<{ ok: true; result: FinalResult } | { ok: false; reason: string }> {
  const no = (reason: string) => ({ ok: false as const, reason });
  const declared = state.result;
  if (!declared) return no("no declared result");
  const dir = path.join(workRoot, state.runId);
  let manifest: {
    schema?: unknown;
    status?: unknown;
    runId?: unknown;
    inputs?: Array<{ checksum?: unknown }>;
  };
  try {
    manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return no("no manifest");
  }
  if (
    manifest.schema !== LOCAL_RUN_SCHEMA ||
    manifest.status !== "succeeded" ||
    manifest.runId !== state.runId
  )
    return no("manifest identity");
  const inputs = manifest.inputs ?? [];
  if (
    inputs.length !== state.sources.length ||
    state.sources.some((s, i) => inputs[i]?.checksum !== s.sha256)
  )
    return no("source checksums");
  const spz = path.join(dir, "output", "splat.spz");
  const s = await stat(spz).catch(() => null);
  if (!s?.isFile() || s.size > MAX_SPLAT_BYTES || s.size !== declared.byteSize) return no("output size");
  const bytes = new Uint8Array(await readFile(spz));
  if (sha256(bytes) !== declared.sha256) return no("output checksum");
  const inspected = inspectSplat(bytes, "splat.spz");
  if (!inspected.ok || inspected.gaussianCount !== declared.gaussianCount) return no("output validation");
  return { ok: true, result: declared };
}

/**
 * After a restart: the persisted job decides. A validated, retained result is uploaded (the lease is renewed first);
 * an interrupted run is reported failed (never re-run). Prism's answer wins when the job ended meanwhile.
 */
export async function resumeJob(o: ExecutorOptions, state: JobState): Promise<JobOutcome> {
  const run = new Run(o, { ...state }, new LeaseClock(KEEPALIVE_INTERVAL_MS * 3));
  return guarded(run, () => resumeRun(o, run, state));
}

async function resumeRun(o: ExecutorOptions, run: Run, state: JobState): Promise<JobOutcome> {
  run.log(`found an unfinished job at stage ${state.stage}`);
  if (state.stage === "result_ready" || state.stage === "uploading") {
    const v = await verifyRetained(o.workRoot, state);
    if (v.ok) {
      run.log("a validated result is retained: uploading it (no re-run)");
      run.start();
      return upload(run, v.result);
    }
    run.log(`the retained result cannot be used (${v.reason})`);
  }
  const r = await report(run, "interrupted", "The Local Agent restarted before the run completed.");
  if (r === "deferred") return finish(run, { kind: "deferred", jobId: state.jobId }, "state");
  if (r === "cancelled") return finish(run, { kind: "cancelled", jobId: state.jobId }, "reduce");
  if (r === "gone") return finish(run, { kind: "lost", jobId: state.jobId, reason: "gone" }, "reduce");
  return finish(run, { kind: "failed", jobId: state.jobId, code: "interrupted" }, "reduce");
}

import { createHash, randomBytes } from "node:crypto";
import { PrevisError } from "@/data/previs-repository";
import { MAX_SPLAT_BYTES, SPLAT_FORMAT_INFO, UNKNOWN_CALIBRATION } from "@/domain/previs/splat";
import {
  isTerminal,
  sanitizeErrorMessage,
  type JobErrorCode,
  type JobEvent,
  type JobPatch,
  type ReconstructionJobRecord,
} from "@/domain/reconstruction/job";
import {
  failRequestSchema,
  finalResultSchema,
  INGEST_GRACE_MS,
  jobPaths,
  LEASE_TTL_MS,
  leaseRequestSchema,
  MAX_SOURCE_BYTES,
  MIN_PROGRESS_WRITE_MS,
  PROTOCOL,
  progressRequestSchema,
  REMOTE_QUALITY,
  type AgentFailureCode,
  type FinalResult,
  type JobOutcomeResponse,
  type Lease,
  type LeaseResponse,
  type ProgressResponse,
} from "@/lib/local-agent/protocol";
import {
  agentCanExecute,
  leaseExpired,
  operationIdForLease,
  REMOTE_AGENT_PROVIDER_ID,
  remoteLeaseOf,
  type RecordedAgentTools,
  type RemoteLease,
} from "@/lib/reconstruction/remote-agent-capture";
import { inspectSplat } from "@/lib/splat/inspect";
import { ingestReconstructionResult, reconcileRemoteLease } from "../../reconstruction-jobs";
import {
  AgentProtocolError,
  authenticateRequest,
  type AgentServiceDeps,
  type Authenticated,
  type IncomingRequest,
} from "../service";
import type { DeviceRecord } from "../store";
import type { RemoteJobRef, RemoteJobScope, RemoteJobStore } from "./store";

/**
 * The Prism SERVER side of remote Local Agent jobs (Phase 2F M2D.3C2). Framework-free and unit-tested; the route
 * handlers are thin wrappers.
 *
 * Every operation first authenticates the signed request (Ed25519 + the atomic counter, M2D.3C1), and only then acts,
 * always for the authenticated DEVICE's own project with its owner's authority. The job row is the lease record:
 *
 *   queued ──lease: queued → submitting → running (compare-and-set; exactly one agent wins)──▶ running
 *   running ──keepalive/progress (renews leaseExpiresAt)──▶ running
 *   running ──fail (agent code → server-chosen job code)──▶ failed
 *   running ──result: re-validate, running → ingesting (compare-and-set), shared M2D.2 ingestion──▶ succeeded
 *   running/submitting with an expired lease ──reaped (never re-leased)──▶ failed (provider_timeout)
 *
 * A request naming a job, lease, ordinal or Asset the device does not hold gets the SAME answer as one naming nothing
 * (`lease_mismatch`): there is no way to probe another project's jobs.
 */

export interface RemoteJobDeps {
  agent: AgentServiceDeps;
  jobs: RemoteJobStore;
  /** reconstruction jobs on, and the server can serve remote jobs (Storage authority present) */
  available: boolean;
  newId: () => string;
  newLeaseId?: () => string;
  /** test override of LEASE_TTL_MS (never configurable in production) */
  leaseTtlMs?: number;
  log?: (entry: Record<string, unknown>) => void;
  /** test seams around race-critical moments; never configured in production */
  hooks?: { beforeIngestClaim?: (job: ReconstructionJobRecord) => Promise<void> };
}

const fail = (code: AgentProtocolError["code"], message?: string): never => {
  throw new AgentProtocolError(code, message);
};
const iso = (ms: number) => new Date(ms).toISOString();
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const isRace = (e: unknown) => e instanceof PrevisError && (e.code === "conflict" || e.code === "invalid");
const ttl = (deps: RemoteJobDeps) => deps.leaseTtlMs ?? LEASE_TTL_MS;

function log(deps: RemoteJobDeps, entry: Record<string, unknown>) {
  (deps.log ?? ((e) => console.info(JSON.stringify(e))))({ event: "local_agent.job", ...entry });
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return fail("malformed_request");
  }
}

function parseBody<T>(
  body: Uint8Array,
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
): T {
  const json = parseJson(body);
  if (json && typeof json === "object" && "protocol" in json && json.protocol !== PROTOCOL)
    fail("protocol_unsupported");
  const r = schema.safeParse(json);
  if (!r.success) fail("malformed_request");
  return r.data as T;
}

async function event(
  scope: RemoteJobScope,
  now: () => number,
  job: ReconstructionJobRecord,
  ev: JobEvent,
  detail: Record<string, unknown> = {},
) {
  await scope.repo.appendReconstructionJobEvent({
    projectId: job.projectId,
    jobId: job.id,
    event: ev,
    detail,
    now: iso(now()),
  });
}

function toolsOf(d: DeviceRecord): RecordedAgentTools | null {
  const c = d.capabilities;
  const fp = c?.toolchain.colmap.fingerprint;
  if (!c || !fp || !c.toolchain.colmap.version || !c.toolchain.brush.version) return null;
  return {
    colmap: {
      version: c.toolchain.colmap.version,
      sourceCommit: fp.sourceCommit,
      binarySha256: fp.binarySha256,
    },
    brush: { version: c.toolchain.brush.version },
  };
}

function operation(
  d: DeviceRecord,
  leaseId: string,
  expiresMs: number,
  nowMs: number,
  tools: RecordedAgentTools | null,
  stage: string,
  description: string,
  result: Record<string, unknown> | null = null,
): Record<string, unknown> {
  return {
    runner: "remote_agent",
    agentId: d.id,
    agentVersion: d.agentVersion,
    leaseId,
    leaseExpiresAt: iso(expiresMs),
    lastProgressAt: nowMs,
    quality: REMOTE_QUALITY,
    ...(tools ? { tools } : {}),
    stage,
    description,
    ...(result ? { result } : {}),
  };
}

/** Why a queued job's frozen inputs cannot run remotely (the M2D.3A input rules), or null. */
function sourceListProblem(job: ReconstructionJobRecord): string | null {
  const n = job.sources.length;
  if (n < 3 || n > 300) return `Remote Local Agent needs 3-300 photographs (this job has ${n}).`;
  for (const [i, s] of job.sources.entries()) {
    if (s.ordinal !== i) return "The photographs are not in a valid order.";
    if (s.kind !== "image") return "Remote Local Agent accepts photographs only (no video).";
    if (s.mime !== "image/jpeg" && s.mime !== "image/png")
      return "Remote Local Agent accepts JPEG or PNG photographs only.";
    if (!s.checksum || !/^[0-9a-f]{64}$/.test(s.checksum))
      return "A photograph has no recorded checksum, so its content cannot be verified.";
    if (s.byteSize === null || s.byteSize < 1)
      return "A photograph has no recorded size, so its transfer cannot be bounded.";
    if (s.byteSize > MAX_SOURCE_BYTES) return "A photograph is larger than the 64 MB per-image limit.";
  }
  return null;
}

function leaseView(job: ReconstructionJobRecord, lease: RemoteLease, resumed: boolean, ttlMs: number): Lease {
  const paths = jobPaths(job.id, lease.leaseId);
  return {
    jobId: job.id,
    attempt: job.attempt,
    leaseId: lease.leaseId,
    leaseExpiresAt: lease.leaseExpiresAt,
    leaseTtlMs: ttlMs,
    resumed,
    quality: REMOTE_QUALITY,
    sources: job.sources.map((s) => ({
      ordinal: s.ordinal,
      assetId: s.assetId,
      mime: s.mime as "image/jpeg" | "image/png",
      byteSize: s.byteSize!,
      sha256: s.checksum!,
      path: paths.source(s.ordinal),
    })),
  };
}

// ───────────────────────── lease ─────────────────────────

/**
 * Leases the authenticated agent ONE job of ITS project: first its own live lease (a lost response must never make an
 * agent run two jobs), else the oldest queued `local_agent_capture` job it can claim by compare-and-set. Expired leases
 * of the project are reaped first (failed, never re-leased).
 */
export async function leaseJob(deps: RemoteJobDeps, req: IncomingRequest): Promise<LeaseResponse> {
  parseBody(req.body, leaseRequestSchema);
  const a = await authenticateRequest(deps.agent, req);
  const d = a.device;
  const now = deps.agent.now;
  const reply = (lease: Lease | null, idle: LeaseResponse["idle"]): LeaseResponse => ({
    protocol: PROTOCOL,
    ok: true,
    serverTime: iso(now()),
    lease,
    idle,
  });
  if (!deps.available) return reply(null, "remote_jobs_unavailable");
  const scope = await deps.jobs.scope(d.projectId, d.createdBy);

  // reap this project's expired leases; find this agent's own live one
  for (const ref of await deps.jobs.listInFlight(d.projectId)) {
    let job = await scope.repo.getReconstructionJob(ref.id);
    if (!job || job.projectId !== d.projectId) continue;
    job = await reconcileRemoteLease(
      { repo: scope.repo, now: () => iso(now()), log: (e) => log(deps, e) },
      job,
    );
    const lease = remoteLeaseOf(job);
    if (isTerminal(job.status) || lease?.agentId !== d.id) continue;
    if (job.status === "ingesting") return reply(null, "no_job"); // its result is being imported: nothing to run
    const renewed = await renew(deps, scope, job, lease, d, "leased", "Leased by the paired workstation");
    if (renewed) {
      log(deps, { jobId: job.id, agent: d.id, lease: "resumed" });
      return reply(leaseView(renewed.job, renewed.lease, true, ttl(deps)), null);
    }
  }

  if (!agentCanExecute(d, now())) return reply(null, "toolchain_not_ready");
  const tools = toolsOf(d);
  if (!tools) return reply(null, "toolchain_not_ready");

  for (const ref of await deps.jobs.listQueued(d.projectId, 5)) {
    const claimed = await claim(deps, scope, ref, d, tools);
    if (claimed) return reply(claimed, null);
  }
  return reply(null, "no_job");
}

async function claim(
  deps: RemoteJobDeps,
  scope: RemoteJobScope,
  ref: RemoteJobRef,
  d: DeviceRecord,
  tools: RecordedAgentTools,
): Promise<Lease | null> {
  const now = deps.agent.now;
  let job = await scope.repo.getReconstructionJob(ref.id);
  // never another provider's job, another project's job, or a job that already moved on
  if (
    !job ||
    job.provider !== REMOTE_AGENT_PROVIDER_ID ||
    job.projectId !== d.projectId ||
    job.status !== "queued"
  )
    return null;
  const problem = sourceListProblem(job);
  if (problem) {
    try {
      const failed = await scope.repo.updateReconstructionJob(
        job.id,
        job.revision,
        { status: "failed", errorCode: "invalid_sources", errorMessage: problem },
        iso(now()),
      );
      await event(scope, now, failed, "failed", { code: "invalid_sources" });
    } catch (e) {
      if (!isRace(e)) throw e;
    }
    return null;
  }
  const leaseId = (deps.newLeaseId ?? (() => randomBytes(16).toString("hex")))();
  const t = now();
  try {
    job = await scope.repo.updateReconstructionJob(
      job.id,
      job.revision,
      {
        status: "submitting",
        providerOperationId: operationIdForLease(leaseId),
        providerOperation: operation(
          d,
          leaseId,
          t + ttl(deps),
          t,
          tools,
          "leased",
          "Leased by the paired workstation",
        ),
      },
      iso(t),
    );
  } catch (e) {
    if (isRace(e)) {
      log(deps, { jobId: ref.id, agent: d.id, claim: "lost" });
      return null;
    }
    throw e;
  }
  // the lease IS execution authority: running at once (the user can cancel immediately)
  try {
    job = await scope.repo.updateReconstructionJob(
      job.id,
      job.revision,
      { status: "running", progress: 0, lastPolledAt: iso(t) },
      iso(t),
    );
  } catch (e) {
    if (isRace(e)) return null;
    throw e;
  }
  await event(scope, now, job, "submitted", { runner: "remote_agent", agent: d.id });
  await event(scope, now, job, "provider_running", { stage: "leased" });
  log(deps, { jobId: job.id, agent: d.id, transition: "queued->running", lease: `…${leaseId.slice(-6)}` });
  return leaseView(job, remoteLeaseOf(job)!, false, ttl(deps));
}

/** Renews a live lease (compare-and-set). Null when it could not be renewed (the job moved on). */
async function renew(
  deps: RemoteJobDeps,
  scope: RemoteJobScope,
  job: ReconstructionJobRecord,
  lease: RemoteLease,
  d: DeviceRecord,
  stage: string,
  description: string,
  extra: { progress?: number; result?: Record<string, unknown> } = {},
): Promise<{ job: ReconstructionJobRecord; lease: RemoteLease } | null> {
  const t = deps.agent.now();
  const patch: JobPatch = {
    status: "running",
    ...(extra.progress !== undefined ? { progress: extra.progress } : {}),
    providerOperation: operation(
      d,
      lease.leaseId,
      t + ttl(deps),
      t,
      lease.tools,
      stage,
      description,
      extra.result ?? lease.result,
    ),
  };
  try {
    // a job still in `submitting` (a claim interrupted between its two writes) moves on to running here
    const next = await scope.repo.updateReconstructionJob(job.id, job.revision, patch, iso(t));
    return { job: next, lease: remoteLeaseOf(next)! };
  } catch (e) {
    if (isRace(e)) return null;
    throw e;
  }
}

// ───────────────────────── lease authority for one request ─────────────────────────

interface Held {
  auth: Authenticated;
  scope: RemoteJobScope;
  job: ReconstructionJobRecord;
  lease: RemoteLease;
}

/**
 * The authenticated device holds THIS lease of THIS job of ITS OWN project. Anything else is `lease_mismatch` (the
 * same answer whether the job exists elsewhere or not at all). Then the job state decides.
 */
async function held(
  deps: RemoteJobDeps,
  req: IncomingRequest,
  jobId: string,
  leaseId: string,
  allow: { ingesting?: boolean; succeeded?: boolean; signedAtCounts?: boolean } = {},
): Promise<Held> {
  const auth = await authenticateRequest(deps.agent, req);
  const d = auth.device;
  if (!deps.available) fail("job_not_available");
  const scope = await deps.jobs.scope(d.projectId, d.createdBy);
  const job = await scope.repo.getReconstructionJob(jobId);
  const lease = job ? remoteLeaseOf(job) : null;
  if (!job || !lease || job.projectId !== d.projectId || lease.agentId !== d.id || lease.leaseId !== leaseId)
    return fail("lease_mismatch");
  if (job.status === "cancelled") fail("job_cancelled");
  if (job.status === "succeeded" && allow.succeeded) return { auth, scope, job, lease };
  if (job.status === "ingesting" && allow.ingesting) return { auth, scope, job, lease };
  if (job.status !== "running" && job.status !== "submitting") fail("job_not_available");
  const now = deps.agent.now();
  // a result upload is judged by when it was SIGNED (a long upload that started under a valid lease still counts)
  const valid = !leaseExpired(lease, now) || (allow.signedAtCounts && !leaseExpired(lease, auth.timestamp));
  if (!valid) {
    await reconcileRemoteLease({ repo: scope.repo, now: () => iso(now), log: (e) => log(deps, e) }, job);
    fail("lease_expired");
  }
  return { auth, scope, job, lease };
}

// ───────────────────────── sources ─────────────────────────

/**
 * Exactly one frozen photograph of the held lease, read server-side from private storage and re-verified against
 * the job's frozen checksum. A changed or unreadable source fails the job (`invalid_sources`); nothing else is served.
 */
export async function serveSource(
  deps: RemoteJobDeps,
  req: IncomingRequest,
  jobId: string,
  leaseId: string,
  ordinal: number,
): Promise<{ bytes: Uint8Array; mime: string; sha256: string }> {
  if (req.body.length > 0) fail("malformed_request");
  const h = await held(deps, req, jobId, leaseId);
  const s = h.job.sources[ordinal];
  if (!s || s.ordinal !== ordinal) return fail("source_unavailable");
  const asset = await h.scope.findAsset(s.assetId);
  const bytes =
    asset &&
    asset.projectId === h.job.projectId &&
    asset.type === "image" &&
    asset.mime === s.mime &&
    asset.checksum === s.checksum
      ? await h.scope.readAssetBytes(asset)
      : null;
  if (!bytes || bytes.length > MAX_SOURCE_BYTES || sha256(bytes) !== s.checksum) {
    await failHeld(
      deps,
      h,
      "invalid_sources",
      "A reference image changed or is no longer readable. Create a new job.",
    );
    return fail("source_unavailable");
  }
  return { bytes, mime: s.mime!, sha256: s.checksum! };
}

async function failHeld(
  deps: RemoteJobDeps,
  h: Held,
  code: JobErrorCode,
  message: string,
  extra: JobPatch = {},
) {
  try {
    const next = await h.scope.repo.updateReconstructionJob(
      h.job.id,
      h.job.revision,
      {
        ...extra,
        status: "failed",
        errorCode: code,
        errorMessage: sanitizeErrorMessage(message),
      },
      iso(deps.agent.now()),
    );
    await event(h.scope, deps.agent.now, next, "failed", { code, agent: h.lease.agentId });
    log(deps, { jobId: h.job.id, transition: `${h.job.status}->failed`, code });
    return next;
  } catch (e) {
    if (isRace(e)) return null; // it ended another way first (e.g. the user cancelled): that is final
    throw e;
  }
}

// ───────────────────────── progress / keepalive ─────────────────────────

function sameResult(a: Record<string, unknown>, b: FinalResult) {
  return JSON.stringify(finalResultSchema.safeParse(a).data ?? null) === JSON.stringify(b);
}

/**
 * Keepalive + progress: renews the lease. A stage change is written (and is an event) at once; a same-stage update at
 * most every MIN_PROGRESS_WRITE_MS (a faster agent is acknowledged without a write). The final result metadata is
 * frozen here, once, before the bytes are uploaded; it must name the toolchain recorded when the job was leased.
 */
export async function progress(
  deps: RemoteJobDeps,
  req: IncomingRequest,
  jobId: string,
  leaseId: string,
): Promise<ProgressResponse> {
  const body = parseBody(req.body, progressRequestSchema);
  let h = await held(deps, req, jobId, leaseId);
  const d = h.auth.device;
  if (body.result) {
    const r = body.result;
    const t = h.lease.tools;
    if (
      body.stage !== "uploading" ||
      !t ||
      r.colmap.binarySha256 !== t.colmap.binarySha256 ||
      r.colmap.sourceCommit !== t.colmap.sourceCommit ||
      r.colmap.version !== t.colmap.version ||
      r.brush.version !== t.brush.version ||
      r.inputImages !== h.job.sources.length ||
      r.registeredImages > r.inputImages
    )
      return fail(
        "result_rejected",
        "The result does not match the job or the toolchain recorded at lease time.",
      );
    if (h.lease.result && !sameResult(h.lease.result, r))
      return fail("result_rejected", "A different result was already declared for this lease.");
  }
  const now = deps.agent.now();
  const stageChanged = body.stage !== h.lease.stage;
  const due = h.lease.lastProgressAt === null || now - h.lease.lastProgressAt >= MIN_PROGRESS_WRITE_MS;
  // the lease must also be written before it gets close to expiring, whatever the cadence says
  const nearExpiry = Date.parse(h.lease.leaseExpiresAt) - now < ttl(deps) / 2;
  if (!stageChanged && !body.result && !due && !nearExpiry && h.job.status === "running")
    return {
      protocol: PROTOCOL,
      ok: true,
      serverTime: iso(now),
      leaseExpiresAt: h.lease.leaseExpiresAt,
      leaseTtlMs: ttl(deps),
    };
  for (let attempt = 0; ; attempt++) {
    const renewed = await renew(deps, h.scope, h.job, h.lease, d, body.stage, body.message, {
      progress: body.progress,
      ...(body.result ? { result: { ...body.result } } : {}),
    });
    if (renewed) {
      if (stageChanged)
        await event(h.scope, deps.agent.now, renewed.job, "progress", {
          stage: body.stage,
          progress: body.progress,
        });
      return {
        protocol: PROTOCOL,
        ok: true,
        serverTime: iso(deps.agent.now()),
        leaseExpiresAt: renewed.lease.leaseExpiresAt,
        leaseTtlMs: ttl(deps),
      };
    }
    // someone else wrote the job (the owner cancelled, a reaper, a concurrent request): judge the current state
    const current = await h.scope.repo.getReconstructionJob(jobId);
    if (current?.status === "cancelled") fail("job_cancelled");
    const lease = current ? remoteLeaseOf(current) : null;
    if (!current || !lease || lease.leaseId !== leaseId || current.status !== "running" || attempt >= 2)
      fail("job_not_available");
    h = { ...h, job: current!, lease: lease! };
  }
}

// ───────────────────────── failure ─────────────────────────

/**
 * The nearest truthful job error for an agent-reported failure. The SERVER decides; the workstation never picks a job
 * status or error code, and can never claim a cancellation the server did not record.
 */
export const REMOTE_FAILURE_MAP: Record<AgentFailureCode, JobErrorCode> = {
  invalid_inputs: "invalid_sources",
  source_invalid: "invalid_sources",
  insufficient_camera_registration: "provider_failed",
  timeout: "provider_timeout",
  result_too_large: "result_too_large",
  ply_missing: "result_missing",
  ply_invalid: "result_invalid",
  spz_invalid: "result_invalid",
  spz_conversion_failed: "result_invalid",
  toolchain_missing: "provider_failed",
  unsupported_version: "provider_failed",
  gpu_unavailable: "provider_failed",
  out_of_memory: "provider_failed",
  brush_failed: "provider_failed",
  colmap_failed: "provider_failed",
  workspace_failed: "provider_failed",
  // the agent stopped on its own (shutdown, lost lease, restart): the job was NOT cancelled by anyone in Prism
  cancelled: "provider_failed",
  interrupted: "provider_failed",
};

export const REMOTE_STOPPED_MESSAGE =
  "The paired workstation stopped before the run completed. Retry creates a new attempt.";

/** Absolute paths, drive letters and UNC prefixes are never stored from an agent message. */
const PATHLIKE = /([A-Za-z]:[\\/][^\s"']*|\\\\[^\s"']+|(?:^|\s)\/(?:[^\s/"']+\/)+[^\s"']*)/g;

export function agentFailureMessage(code: AgentFailureCode, message: string): string {
  if (code === "cancelled" || code === "interrupted") return REMOTE_STOPPED_MESSAGE;
  const clean = message.replace(PATHLIKE, " [path]").replace(/\s+/g, " ").trim().slice(0, 300);
  return sanitizeErrorMessage(`Remote Local Agent: ${clean || "the reconstruction failed."}`);
}

export async function failJob(
  deps: RemoteJobDeps,
  req: IncomingRequest,
  jobId: string,
  leaseId: string,
): Promise<JobOutcomeResponse> {
  const body = parseBody(req.body, failRequestSchema);
  const h = await held(deps, req, jobId, leaseId);
  const code = REMOTE_FAILURE_MAP[body.code];
  const next = await failHeld(deps, h, code, agentFailureMessage(body.code, body.message), {
    providerOperation: {
      ...(h.job.providerOperation ?? {}),
      stage: "failed",
      agentError: { code: body.code, stage: body.stage },
    },
  });
  const current = next ?? (await h.scope.repo.getReconstructionJob(jobId));
  if (current?.status === "cancelled") fail("job_cancelled");
  if (!current || current.status !== "failed") fail("job_not_available");
  return outcome(deps, current!);
}

function outcome(deps: RemoteJobDeps, job: ReconstructionJobRecord): JobOutcomeResponse {
  return {
    protocol: PROTOCOL,
    ok: true,
    serverTime: iso(deps.agent.now()),
    job: {
      id: job.id,
      status: job.status as "succeeded" | "failed" | "cancelled",
      reconstructionId: job.resultReconstructionId,
    },
  };
}

// ───────────────────────── result ─────────────────────────

/**
 * Before reading a (up to 50 MB) result body: is there a running, leased remote job whose lease names the CLAIMED
 * device and this lease, with frozen result metadata of exactly the declared length? An unrelated caller is refused
 * without the server buffering anything. (The full, signed check follows after the body is read.)
 */
export async function resultUploadGate(
  deps: RemoteJobDeps,
  claimedAgentId: string | null,
  jobId: string,
  leaseId: string,
  declaredLength: number | null,
): Promise<number> {
  if (!deps.available) fail("job_not_available");
  const peek = await deps.jobs.peek(jobId);
  const lease = peek
    ? remoteLeaseOf({
        provider: REMOTE_AGENT_PROVIDER_ID,
        providerOperationId: peek.providerOperationId,
        providerOperation: peek.providerOperation,
      })
    : null;
  if (!peek || !lease || lease.agentId !== claimedAgentId || lease.leaseId !== leaseId)
    return fail("lease_mismatch");
  const frozen = lease.result ? finalResultSchema.safeParse(lease.result) : null;
  if (!frozen?.success)
    return fail(
      "result_rejected",
      "Declare the result (final progress with its metadata) before uploading it.",
    );
  if (declaredLength === null || declaredLength !== frozen.data.byteSize)
    return fail("result_rejected", "The upload length does not match the declared result.");
  return frozen.data.byteSize;
}

/** The provenance stored with the job result and the reconstruction: safe facts only (no path, host or user). */
export function remoteProvenance(r: FinalResult, d: DeviceRecord): Record<string, unknown> {
  return {
    engine: "prism-local-reconstruction",
    runner: "remote_agent",
    quality: r.quality,
    colmap: r.colmap,
    brush: r.brush,
    spzEncoder: r.spzEncoder,
    inputImages: r.inputImages,
    registeredImages: r.registeredImages,
    registrationRatio: r.registrationRatio,
    sparsePoints: r.sparsePoints,
    shDegree: r.shDegree,
    spzVersion: r.spzVersion,
    lossless: false,
    clamped: r.clamped,
    // an opaque device identity (a label can change and is never identity)
    agentId: d.id,
    agentFingerprint: d.fingerprint.slice(0, 16),
    agentVersion: d.agentVersion,
  };
}

/**
 * The one result of a lease: authenticated, re-validated (signed bytes = declared checksum and size, a valid SPZ with
 * the declared Gaussian count), claimed running → ingesting by compare-and-set (a cancel that won is final; an import
 * that won makes a later cancel impossible), then the SHARED M2D.2 ingestion. A repeated upload of an imported result
 * returns the existing outcome; nothing is ever imported twice.
 */
export async function uploadResult(
  deps: RemoteJobDeps,
  req: IncomingRequest,
  jobId: string,
  leaseId: string,
): Promise<JobOutcomeResponse> {
  const h = await held(deps, req, jobId, leaseId, { ingesting: true, succeeded: true, signedAtCounts: true });
  const d = h.auth.device;
  const bytes = req.body;
  const sum = sha256(bytes);
  const frozen = h.lease.result ? finalResultSchema.safeParse(h.lease.result) : null;
  if (!frozen?.success) return fail("result_rejected", "No result was declared for this lease.");
  const declared = frozen.data;
  if (h.job.status === "succeeded") {
    // a repeat after a lost response: the same bytes get the same, existing outcome
    if (sum !== declared.sha256 || !h.job.resultReconstructionId) fail("job_not_available");
    return outcome(deps, h.job);
  }
  if (h.job.status === "ingesting") fail("result_pending");

  if (bytes.length !== declared.byteSize || bytes.length > MAX_SPLAT_BYTES || sum !== declared.sha256) {
    await failHeld(
      deps,
      h,
      "result_invalid",
      "The uploaded result does not match the result the workstation declared.",
    );
    return fail("result_rejected", "The uploaded bytes do not match the declared result.");
  }
  const inspected = inspectSplat(bytes, "result.spz");
  if (!inspected.ok || inspected.format !== "spz" || inspected.gaussianCount !== declared.gaussianCount) {
    await failHeld(
      deps,
      h,
      "result_invalid",
      `The result is not a valid SPZ splat: ${inspected.ok ? "its Gaussian count differs from the declared one" : inspected.error}`,
    );
    return fail("result_rejected", "The result is not a valid SPZ splat.");
  }

  await deps.hooks?.beforeIngestClaim?.(h.job);
  // claim the import: exactly one writer moves running → ingesting
  let job: ReconstructionJobRecord;
  const t = deps.agent.now();
  try {
    job = await h.scope.repo.updateReconstructionJob(
      h.job.id,
      h.job.revision,
      {
        status: "ingesting",
        progress: 1,
        providerOperation: {
          ...(h.job.providerOperation ?? {}),
          stage: "ingesting",
          description: "Importing the result",
          leaseExpiresAt: iso(t + INGEST_GRACE_MS),
          lastProgressAt: t,
        },
      },
      iso(t),
    );
  } catch (e) {
    if (!isRace(e)) throw e;
    const current = await h.scope.repo.getReconstructionJob(jobId);
    if (current?.status === "cancelled") fail("job_cancelled");
    if (current?.status === "ingesting") fail("result_pending");
    if (current?.status === "succeeded" && remoteLeaseOf(current)?.leaseId === leaseId)
      return outcome(deps, current);
    return fail("job_not_available");
  }
  await event(h.scope, deps.agent.now, job, "provider_succeeded", { runner: "remote_agent" });
  await event(h.scope, deps.agent.now, job, "ingesting");

  const location = await h.scope.locationName(job.locationId);
  const ingestDeps = {
    repo: h.scope.repo,
    store: h.scope.store,
    storage: h.scope.storage,
    userId: h.scope.userId,
    now: () => iso(deps.agent.now()),
    newId: deps.newId,
    locationName: () => location,
    log: (e: Record<string, unknown>) => log(deps, e),
  };
  for (let attempt = 1; ; attempt++) {
    const out = await ingestReconstructionResult(ingestDeps, job, {
      bytes,
      label: `local-${REMOTE_QUALITY}`,
      fileHint: SPLAT_FORMAT_INFO.spz.extension,
      // COLMAP/Brush scale is arbitrary: never inferred as metres; manual calibration stays authoritative
      calibration: { ...UNKNOWN_CALIBRATION },
      providerResult: remoteProvenance(declared, d),
      expectedChecksum: declared.sha256,
    });
    if (out.kind === "succeeded" || out.kind === "lost_race") {
      log(deps, { jobId, agent: d.id, outcome: out.kind });
      if (out.job.status === "succeeded") return outcome(deps, out.job);
      return fail(out.job.status === "cancelled" ? "job_cancelled" : "job_not_available");
    }
    if (out.kind === "invalid") {
      await failHeld(deps, { ...h, job }, out.code, out.message);
      return fail("result_rejected", out.message);
    }
    if (attempt >= 3) {
      await failHeld(deps, { ...h, job }, "ingest_failed", `Storing the result failed: ${out.message}`);
      return fail(
        "result_rejected",
        "Prism could not store the result; the attempt failed. Retry creates a new attempt.",
      );
    }
    log(deps, { jobId, ingest: "retry", attempt });
    await new Promise((r) => setTimeout(r, 500 * attempt));
    const current = await h.scope.repo.getReconstructionJob(jobId);
    if (!current || current.status !== "ingesting" || remoteLeaseOf(current)?.leaseId !== leaseId)
      return fail("job_not_available");
    job = current;
  }
}

// ───────────────────────── owner-side helpers ─────────────────────────

/**
 * A revoked device's active remote jobs fail at once (they never stay "running" until the lease runs out, and they
 * are never reassigned). Runs with the project owner's authority; returns how many jobs were failed.
 */
export async function failJobsOfAgent(
  jobs: RemoteJobStore,
  projectId: string,
  ownerId: string,
  deviceId: string,
  now: () => number = Date.now,
): Promise<number> {
  const scope = await jobs.scope(projectId, ownerId);
  let n = 0;
  for (const ref of await jobs.listInFlight(projectId)) {
    const job = await scope.repo.getReconstructionJob(ref.id);
    const lease = job ? remoteLeaseOf(job) : null;
    if (!job || job.projectId !== projectId || lease?.agentId !== deviceId || isTerminal(job.status))
      continue;
    if (job.status === "ingesting") continue; // the result already arrived; its import decides
    try {
      const next = await scope.repo.updateReconstructionJob(
        job.id,
        job.revision,
        {
          status: "failed",
          errorCode: "provider_failed",
          errorMessage: "The workstation running this job was revoked in Prism. Retry creates a new attempt.",
          providerOperation: { ...(job.providerOperation ?? {}), stage: "agent_revoked" },
        },
        iso(now()),
      );
      await event(scope, now, next, "failed", { code: "provider_failed", reason: "agent_revoked" });
      n++;
    } catch (e) {
      if (!isRace(e)) throw e;
    }
  }
  return n;
}

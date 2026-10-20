import { FREE_COST_ESTIMATE, MAX_JOB_SOURCES, type JobCostEstimate } from "@/domain/reconstruction/job";
import type { ReconstructionJobRecord } from "@/domain/reconstruction/job";
import {
  agentOnline,
  LEASE_ID_RE,
  PROTOCOL_VERSION,
  REMOTE_QUALITY,
  type AgentCapabilities,
} from "@/lib/local-agent/protocol";
import {
  ProviderError,
  type ExtractedResult,
  type InputMode,
  type OperationSnapshot,
  type PreparedInput,
  type ProviderCapabilities,
  type ProviderStatus,
  type ReconstructionProvider,
} from "./provider";

/**
 * `local_agent_capture`: the FREE M2D.3A reconstruction, run on a user's PAIRED WORKSTATION (Phase 2F M2D.3C2).
 *
 *   queued job ──signed lease (one agent of THIS project wins the compare-and-set)──▶ running
 *     ──exact sources over the signed Prism route──▶ M2D.3A engine on the workstation (COLMAP → Brush → SPZ)
 *     ──signed keepalive/progress (renews the lease)──▶ final metadata ──▶ one SPZ upload
 *     ──Prism re-validates──▶ the shared M2D.2 ingestion (private Asset + immutable reconstruction + success)
 *
 * It is deliberately NOT `local_capture`: that id means the TRUSTED same-host worker (M2D.3B), which holds server
 * credentials. This one runs on an external client that holds only its device key, so job provenance always says
 * which trust model executed it, and the two runners can never claim each other's jobs.
 *
 * Availability is PROJECT-SCOPED: an active paired agent of the job's own project must be online and report a ready
 * toolchain. Nothing here is executed by a web request; the provider's execution methods refuse to run. There is no
 * hosted fallback.
 */

export const REMOTE_AGENT_PROVIDER_ID = "local_agent_capture" as const;

/** The operator switch for remote Local Agents (pairing, heartbeat and remote jobs alike). */
export const remoteAgentsEnabled = (env: Record<string, string | undefined>) =>
  env.PRISM_LOCAL_AGENTS_ENABLED === "1";
const OPERATION_PREFIX = "agent:";

/** What the reconstruction panel may know about the project's paired workstations (counts only; no device detail). */
export interface RemoteAgentView {
  /**
   *   not_enabled     PRISM_LOCAL_AGENTS_ENABLED is off (or reconstruction jobs are)
   *   not_configured  the server cannot serve remote jobs (Supabase mode without the agent relay Storage key)
   *   no_agents       no active paired workstation in this project
   *   offline         paired, but none heartbeating
   *   toolchain       online, but no workstation reports a ready toolchain
   *   outdated        online and ready, but no workstation runs an agent version that executes remote jobs
   *   ready           at least one online, ready, compatible workstation
   */
  state: "not_enabled" | "not_configured" | "no_agents" | "offline" | "toolchain" | "outdated" | "ready";
  active: number;
  online: number;
  ready: number;
  /** ready agents currently running a remote job (they still count: new jobs queue behind them) */
  busy: number;
}

/** The minimal device facts availability is computed from (server-side, the owner's own devices). */
export interface AgentDeviceFacts {
  status: "active" | "revoked";
  lastSeenAt: string | null;
  capabilities: AgentCapabilities | null;
}

/** Can this device run a remote job right now? Online, ready, protocol-compatible, images + the standard profile. */
export function agentCanExecute(d: AgentDeviceFacts, nowMs: number): boolean {
  const c = d.capabilities;
  return (
    agentOnline(d.status, d.lastSeenAt, nowMs) &&
    !!c &&
    c.protocolVersion === PROTOCOL_VERSION &&
    c.toolchain.state === "ready" &&
    c.execution?.remoteJobs === true &&
    c.engine.inputKinds.includes("images") &&
    c.engine.qualityProfiles.includes(REMOTE_QUALITY)
  );
}

export function remoteAgentView(
  devices: AgentDeviceFacts[],
  nowMs: number,
  server: { enabled: boolean; configured: boolean },
): RemoteAgentView {
  const active = devices.filter((d) => d.status === "active");
  const online = active.filter((d) => agentOnline(d.status, d.lastSeenAt, nowMs));
  const toolReady = online.filter((d) => d.capabilities?.toolchain.state === "ready");
  const ready = online.filter((d) => agentCanExecute(d, nowMs));
  const counts = {
    active: active.length,
    online: online.length,
    ready: ready.length,
    busy: ready.filter((d) => d.capabilities?.busy).length,
  };
  const state: RemoteAgentView["state"] = !server.enabled
    ? "not_enabled"
    : !server.configured
      ? "not_configured"
      : active.length === 0
        ? "no_agents"
        : online.length === 0
          ? "offline"
          : toolReady.length === 0
            ? "toolchain"
            : ready.length === 0
              ? "outdated"
              : "ready";
  return { state, ...counts };
}

const REASON: Record<Exclude<RemoteAgentView["state"], "ready">, string> = {
  not_enabled: "Remote Local Agents are not enabled on this Prism server.",
  not_configured: "This Prism server is not configured to serve remote reconstruction jobs.",
  no_agents: "Pair a workstation first (Project › Local agents).",
  offline: "Paired workstation offline.",
  toolchain: "Toolchain unavailable on the paired workstation.",
  outdated: "The paired workstation runs a Local Agent that cannot execute jobs; update it.",
};

export function remoteAgentReason(v: RemoteAgentView): string | null {
  return v.state === "ready" ? null : REASON[v.state];
}

/** Synchronous, side-effect-free availability for ONE project (computed per request, never cached globally). */
export interface RemoteAgentAvailability {
  view(): RemoteAgentView;
}

/** No project context (e.g. the shared provider list): never usable, never pre-selected. */
export const NO_REMOTE_AGENTS: RemoteAgentAvailability = {
  view: () => ({ state: "no_agents", active: 0, online: 0, ready: 0, busy: 0 }),
};

const notRunnable = () =>
  new ProviderError(
    "capability_unavailable",
    "Remote Local Agent jobs run on the paired workstation, never in a web request.",
  );

export class RemoteAgentCaptureProvider implements ReconstructionProvider {
  readonly id = REMOTE_AGENT_PROVIDER_ID;

  constructor(private readonly availability: RemoteAgentAvailability = NO_REMOTE_AGENTS) {}

  capabilities(): ProviderCapabilities {
    return {
      capability: "local_capture",
      execution: "local",
      runner: "remote_agent",
      cost: "free",
      inputModes: ["multi_image"],
      resultKinds: ["gaussian_splat"],
      maxInputs: MAX_JOB_SOURCES,
      minInputs: 3,
      inputMimes: ["image/jpeg", "image/png"],
      models: [],
      defaultModel: null,
      options: [],
      // the agent's next keepalive (≤ ~10 s) learns of a cancellation and stops COLMAP/Brush
      supportsCancel: true,
      supportsProgress: true,
      // a validated result retained on the workstation is uploaded after an agent restart (never re-trained)
      supportsResume: true,
      supportsIdempotencyKey: true,
      testOnly: false,
    };
  }

  estimateCost(model: string | null, mode: InputMode): JobCostEstimate {
    return FREE_COST_ESTIMATE(`${model ?? "local"} · ${mode} · runs on a paired workstation`);
  }

  status(): ProviderStatus {
    const v = this.availability.view();
    const ready = v.state === "ready";
    return {
      provider: this.id,
      label: "Remote Local Agent",
      configured: v.state !== "not_enabled" && v.state !== "not_configured",
      enabled: v.state !== "not_enabled",
      capability: ready ? "available" : "unavailable",
      reason: remoteAgentReason(v),
      remote: v,
    };
  }

  /**
   * The web side of a cancel: the job service marks the job cancelled (compare-and-set); the agent's next keepalive is
   * refused with `job_cancelled`, it aborts the engine and uploads nothing. Confirmed because a cancelled job can never
   * be completed: the result upload is a running → ingesting compare-and-set.
   */
  async cancel(): Promise<boolean> {
    return true;
  }

  async prepareInputs(): Promise<PreparedInput[]> {
    throw notRunnable();
  }
  async submit(): Promise<OperationSnapshot> {
    throw notRunnable();
  }
  async getOperation(): Promise<OperationSnapshot> {
    throw notRunnable();
  }
  extractResult(): ExtractedResult {
    throw notRunnable();
  }
  async download(): Promise<Uint8Array> {
    throw notRunnable();
  }
}

// ───────────────────────── the lease, as stored in the job row ─────────────────────────

/** `agent:<lease id>`: one per attempt, assigned once, no path, no device secret. */
export const operationIdForLease = (leaseId: string) => `${OPERATION_PREFIX}${leaseId}`;

export interface RecordedAgentTools {
  colmap: { version: string; sourceCommit: string; binarySha256: string };
  brush: { version: string };
}

/** The remote lease facts a job's provider operation holds (validated; anything else is "no lease"). */
export interface RemoteLease {
  agentId: string;
  leaseId: string;
  leaseExpiresAt: string;
  stage: string | null;
  /** the toolchain the agent reported when it leased (its result must name the same COLMAP build and Brush) */
  tools: RecordedAgentTools | null;
  /** the final result metadata, frozen before the upload (null until then) */
  result: Record<string, unknown> | null;
  /** Unix ms of the last written progress (for the server's write cadence) */
  lastProgressAt: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The lease of a remote job, or null when the job is not a leased remote job. */
export function remoteLeaseOf(
  job: Pick<ReconstructionJobRecord, "provider" | "providerOperationId" | "providerOperation">,
): RemoteLease | null {
  if (job.provider !== REMOTE_AGENT_PROVIDER_ID) return null;
  const opId = job.providerOperationId;
  const op = job.providerOperation;
  if (!opId?.startsWith(OPERATION_PREFIX) || !op || op.runner !== "remote_agent") return null;
  const leaseId = opId.slice(OPERATION_PREFIX.length);
  if (!LEASE_ID_RE.test(leaseId) || op.leaseId !== leaseId) return null;
  if (typeof op.agentId !== "string" || !UUID.test(op.agentId)) return null;
  if (typeof op.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(op.leaseExpiresAt))) return null;
  const tools = op.tools as RecordedAgentTools | undefined;
  return {
    agentId: op.agentId,
    leaseId,
    leaseExpiresAt: op.leaseExpiresAt,
    stage: typeof op.stage === "string" ? op.stage : null,
    tools: tools?.colmap?.binarySha256 && tools.brush?.version ? tools : null,
    result:
      op.result && typeof op.result === "object" && !Array.isArray(op.result)
        ? (op.result as Record<string, unknown>)
        : null,
    lastProgressAt: typeof op.lastProgressAt === "number" ? op.lastProgressAt : null,
  };
}

/** True when the lease has expired at `nowMs` (an unparseable lease is expired: fail safe). */
export function leaseExpired(lease: Pick<RemoteLease, "leaseExpiresAt">, nowMs: number): boolean {
  const t = Date.parse(lease.leaseExpiresAt);
  return !Number.isFinite(t) || t <= nowMs;
}

/**
 * Whether a stale remote job may be failed now: ONLY a `local_agent_capture` job, still submitting or running (or
 * ingesting past the import grace), whose stored lease has truly expired. Never another provider's job.
 */
export function staleRemoteJob(job: ReconstructionJobRecord, nowMs: number): boolean {
  if (job.provider !== REMOTE_AGENT_PROVIDER_ID) return false;
  if (!["submitting", "running", "ingesting"].includes(job.status)) return false;
  const lease = remoteLeaseOf(job);
  // a remote job in flight without a readable lease can never be renewed: it is stale by construction
  return lease ? leaseExpired(lease, nowMs) : true;
}

export const LEASE_EXPIRED_MESSAGE =
  "The paired workstation stopped reporting before its lease expired. The attempt was stopped; Retry creates a new attempt.";

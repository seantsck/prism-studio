import { z } from "zod";
import { MAX_SPLAT_BYTES } from "@/domain/previs/splat";
import { LOCAL_ERROR_CODES, LOCAL_STAGES } from "@/lib/reconstruction/local/types";

/**
 * Prism Local Agent protocol v1 (Phase 2F M2D.3C1): the wire contract between a user's workstation (the remote Local
 * Agent) and the Prism server. Shared by both sides; pure (no filesystem, no database, no environment).
 * The full specification is docs/local-agent-protocol.md; this module is its executable form. M2D.3C2 adds remote
 * reconstruction jobs (lease → exact sources → progress/keepalive → fail or one SPZ result) on new signed routes; the
 * M2D.3C1 pairing, heartbeat and status messages are unchanged, so a C1 agent keeps working (it just never leases).
 *
 * The workstation is an EXTERNAL CLIENT: it holds only its own Ed25519 key pair, its device id and the pinned Prism
 * origin. It never receives a database URL, a Supabase key, a Storage credential, a provider key or a user session.
 */

export const PROTOCOL = "prism.local-agent.v1" as const;
export const PROTOCOL_VERSION = 1 as const;
export const DEVICE_SCHEMA = "prism.local-agent.v1" as const;
export const CAPABILITIES_SCHEMA = "prism.local-agent-capabilities.v1" as const;

/** The agent implementation's version string (reported, never trusted for authority). */
export const AGENT_VERSION = "prism-local-agent-0.2.0" as const;

export const API_PREFIX = "/api/local-agent/v1" as const;
export const PATHS = {
  pair: `${API_PREFIX}/pair`,
  heartbeat: `${API_PREFIX}/heartbeat`,
  status: `${API_PREFIX}/status`,
  /** M2D.3C2: lease the project's oldest queued remote job (or get the agent's own live lease back) */
  lease: `${API_PREFIX}/jobs/lease`,
} as const;

/** An opaque lease id: 128 random bits, lowercase hex. Not a credential (every request is still device-signed). */
export const LEASE_ID_RE = /^[0-9a-f]{32}$/;
/** The ids a job route can carry (job ids are UUIDs; the route grammar refuses anything else before any lookup). */
export const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A source ordinal on the wire: 0-based, no leading zeros, at most 299. */
export const ORDINAL_RE = /^(0|[1-9][0-9]{0,2})$/;

/** The routes of ONE lease. Every one is signed like any other request (the path, with these ids, is signed). */
export const jobPaths = (jobId: string, leaseId: string) => {
  const base = `${API_PREFIX}/jobs/${jobId}/leases/${leaseId}`;
  return {
    source: (ordinal: number) => `${base}/sources/${ordinal}`,
    progress: `${base}/progress`,
    fail: `${base}/fail`,
    result: `${base}/result`,
  };
};

/** Request headers of a signed (authenticated) request. Header names are case-insensitive on the wire. */
export const HEADERS = {
  protocol: "x-prism-agent-protocol",
  agentId: "x-prism-agent-id",
  counter: "x-prism-agent-counter",
  timestamp: "x-prism-agent-timestamp",
  signature: "x-prism-agent-signature",
} as const;

/** A pairing offer lives this long; the agent must redeem it before then. */
export const PAIRING_TTL_MS = 10 * 60_000;
/** Allowed difference between the agent's signed timestamp and the server clock (the counter is the replay control). */
export const CLOCK_SKEW_MS = 5 * 60_000;
/** The agent heartbeats this often; the server shows it online while the last one is younger than ONLINE_MS. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const ONLINE_MS = 30_000;

/**
 * Online = active and a signed heartbeat within ONLINE_MS. A last-seen time that is unparseable, or further in the future
 * than the allowed clock skew, is treated as offline (never "online forever"); no heartbeat is offline, never revoked.
 */
export function agentOnline(status: string, lastSeenAt: string | null, nowMs: number): boolean {
  if (status !== "active" || !lastSeenAt) return false;
  const age = nowMs - Date.parse(lastSeenAt);
  return Number.isFinite(age) && age >= -CLOCK_SKEW_MS && age <= ONLINE_MS;
}

/**
 * Strict request body limits. Every control message is small JSON; the ONLY media a request carries is the one SPZ
 * result of a lease (at most Prism's splat cap). Source photographs travel in RESPONSES (bounded by their frozen size).
 */
export const BODY_LIMITS = {
  pair: 4096,
  heartbeat: 8192,
  status: 0,
  lease: 1024,
  source: 0,
  progress: 16_384,
  fail: 4096,
  result: MAX_SPLAT_BYTES,
} as const;

// ───────────────────────── remote jobs (M2D.3C2) ─────────────────────────

/**
 * A lease is the agent's authority over ONE job attempt. It lives in the job row (provider operation), is renewed by
 * every accepted keepalive, and is never handed to another workstation: an expired lease fails the attempt.
 */
export const LEASE_TTL_MS = 120_000;
/** The agent sends a signed keepalive/progress at least this often while it holds a lease. */
export const KEEPALIVE_INTERVAL_MS = 10_000;
/** The server writes a same-stage progress update at most this often (a stage change is always written). */
export const MIN_PROGRESS_WRITE_MS = 2_000;
/** While the server imports a result, the lease is extended by this much (an import never outlives it unnoticed). */
export const INGEST_GRACE_MS = 10 * 60_000;
/** The one quality profile remote jobs run (the M2D.3A validated profile; nothing the browser sends changes it). */
export const REMOTE_QUALITY = "standard" as const;
/** Largest single source photograph (the M2D.3A engine's per-image limit). */
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/** The stages a remote job reports: download, the M2D.3A engine stages, and the result upload. */
export const REMOTE_STAGES = [
  "downloading",
  ...LOCAL_STAGES.filter((s) => s !== "complete"),
  "uploading",
] as const;
export type RemoteStage = (typeof REMOTE_STAGES)[number];

/**
 * What an agent may report when a job fails: the M2D.3A engine's normalized codes, plus two agent-side facts. The
 * SERVER maps these to a job error code; the workstation never chooses a job status or a database error code.
 *   source_invalid   a downloaded photograph did not match its frozen size/type/checksum (nothing was run)
 *   interrupted      the agent restarted mid-run with no validated result (the run is never silently repeated)
 */
export const AGENT_FAILURE_CODES = [...LOCAL_ERROR_CODES, "source_invalid", "interrupted"] as const;
export type AgentFailureCode = (typeof AGENT_FAILURE_CODES)[number];

export const ERROR_CODES = [
  "invalid_pairing",
  "pairing_expired",
  "pairing_consumed",
  "invalid_signature",
  "counter_replayed",
  "clock_skew",
  "device_revoked",
  "device_unknown",
  "protocol_unsupported",
  "project_forbidden",
  "malformed_request",
  "origin_mismatch",
  "payload_too_large",
  "not_enabled",
  // M2D.3C2 remote jobs
  "lease_expired",
  "lease_mismatch",
  "job_cancelled",
  "job_not_available",
  "source_unavailable",
  "result_rejected",
  "result_pending",
] as const;
export type AgentErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status for each stable error code (the code, not the status, is the contract). */
export const ERROR_STATUS: Record<AgentErrorCode, number> = {
  invalid_pairing: 401,
  pairing_expired: 410,
  pairing_consumed: 410,
  invalid_signature: 401,
  counter_replayed: 409,
  clock_skew: 401,
  device_revoked: 403,
  device_unknown: 401,
  protocol_unsupported: 400,
  project_forbidden: 403,
  malformed_request: 400,
  origin_mismatch: 400,
  payload_too_large: 413,
  not_enabled: 404,
  lease_expired: 410,
  lease_mismatch: 404,
  job_cancelled: 409,
  job_not_available: 409,
  source_unavailable: 409,
  result_rejected: 422,
  result_pending: 409,
};

/** Fixed, safe, user-readable messages: never SQL, stack traces, key material or another project's existence. */
export const ERROR_MESSAGES: Record<AgentErrorCode, string> = {
  invalid_pairing: "This pairing code is not valid. Create a new one in Prism (Local agents).",
  pairing_expired: "This pairing code has expired. Create a new one in Prism (Local agents).",
  pairing_consumed: "This pairing code has already been used. Create a new one in Prism (Local agents).",
  invalid_signature: "The request signature is not valid for this device.",
  counter_replayed:
    "The request counter was already used. This device's local state is behind the server; pair the agent again.",
  clock_skew:
    "This computer's clock differs from Prism's by more than 5 minutes. Correct the clock and retry.",
  device_revoked: "This device was revoked in Prism. Pair again to create a new device.",
  device_unknown: "Prism does not know this device. Pair the agent again.",
  protocol_unsupported: "This agent's protocol version is not supported by this Prism server.",
  project_forbidden: "This device's project is not available to its owner.",
  malformed_request: "The request is malformed.",
  origin_mismatch: "The agent was pointed at a different address than this Prism server's canonical origin.",
  payload_too_large: "The request body is too large.",
  not_enabled: "Local agents are not enabled on this Prism server.",
  lease_expired:
    "This job's lease expired: the workstation stopped reporting in time. The attempt was failed; Retry creates a new one.",
  lease_mismatch: "This device holds no such lease.",
  job_cancelled: "The job was cancelled in Prism. Stop and discard the run.",
  job_not_available: "The job is no longer running.",
  source_unavailable: "That photograph is not available for this lease.",
  result_rejected: "Prism refused this result.",
  result_pending: "Prism is still importing this job's result. Ask again shortly.",
};

// ───────────────────────── identifiers ─────────────────────────

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;
/** Ed25519 SPKI DER, standard base64: fixed 12-byte prefix (MCowBQYDK2VwAyEA) + 32 key bytes. */
export const PUBLIC_KEY_RE = /^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/;
/** Ed25519 signature (64 bytes), base64url without padding. */
export const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;
/** Decimal integer 1..2^53-1 without leading zeros (a counter), or 0.. for a timestamp. */
export const COUNTER_RE = /^[1-9][0-9]{0,15}$/;
export const TIMESTAMP_RE = /^(0|[1-9][0-9]{0,15})$/;

// ───────────────────────── capabilities (agent → server, stored as capabilities_json) ─────────────────────────

const version = z
  .string()
  .regex(/^[0-9A-Za-z.+_-]{1,32}$/)
  .nullable();

/**
 * What a device may report about itself: tool STATES and VERSIONS only. Never an executable path, a home directory,
 * a hostname, a user name, environment variables or anything about files.
 */
export const capabilitiesSchema = z
  .object({
    schema: z.literal(CAPABILITIES_SCHEMA),
    agentVersion: z.string().regex(/^[0-9A-Za-z.+_-]{1,40}$/),
    protocolVersion: z.number().int().min(1).max(1000),
    platform: z.enum(["win32", "linux", "darwin"]),
    arch: z.string().regex(/^[a-z0-9_]{1,16}$/),
    toolchain: z
      .object({
        state: z.enum([
          "ready",
          "colmap_missing",
          "colmap_unverified",
          "colmap_incompatible",
          "brush_missing",
          "brush_incompatible",
          "gpu_unavailable",
        ]),
        colmap: z
          .object({
            provenance: z.enum(["verified", "unverified", "incompatible", "missing"]),
            version,
            /** the verified build's identity (its provenance manifest), only when verified */
            fingerprint: z
              .object({
                sourceCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
                binarySha256: z.string().regex(HEX64_RE),
              })
              .strict()
              .nullable(),
          })
          .strict(),
        brush: z.object({ version, compatible: z.boolean() }).strict(),
        gpu: z.object({ vulkanLoader: z.boolean().nullable() }).strict(),
        checkedAt: z.string().max(40),
      })
      .strict(),
    engine: z
      .object({
        inputKinds: z.array(z.enum(["images"])).max(4),
        inputMimes: z.array(z.enum(["image/jpeg", "image/png"])).max(4),
        qualityProfiles: z.array(z.enum(["draft", "standard", "high"])).max(4),
      })
      .strict(),
    /** true while the agent holds a remote job (M2D.3C1 agents always report false) */
    busy: z.boolean(),
    /** M2D.3C2: present when this agent leases and runs remote jobs (absent on M2D.3C1 agents) */
    execution: z
      .object({ remoteJobs: z.literal(true) })
      .strict()
      .optional(),
  })
  .strict();
export type AgentCapabilities = z.infer<typeof capabilitiesSchema>;

// ───────────────────────── request bodies ─────────────────────────

export const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((s) => !/\p{Cc}/u.test(s), "label must not contain control characters");

export const pairRequestSchema = z
  .object({
    protocol: z.literal(PROTOCOL),
    pairingCode: z.string().min(1).max(64),
    publicKey: z.string().regex(PUBLIC_KEY_RE),
    /** the origin the agent is talking to; must equal the server's canonical origin (it is pinned afterwards) */
    serverOrigin: z.string().min(1).max(200),
    timestamp: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    /** proof of possession: Ed25519 signature over the pairing message (see pairProofMessage) */
    proof: z.string().regex(SIGNATURE_RE),
    device: z
      .object({
        label: labelSchema,
        platform: z.enum(["win32", "linux", "darwin"]),
        arch: z.string().regex(/^[a-z0-9_]{1,16}$/),
        agentVersion: z.string().regex(/^[0-9A-Za-z.+_-]{1,40}$/),
      })
      .strict(),
  })
  .strict();
export type PairRequest = z.infer<typeof pairRequestSchema>;

export const heartbeatRequestSchema = z
  .object({ protocol: z.literal(PROTOCOL), capabilities: capabilitiesSchema })
  .strict();
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

// ───────────────────────── responses ─────────────────────────

const envelope = { protocol: z.literal(PROTOCOL), serverTime: z.string() };

export const errorResponseSchema = z.object({
  ...envelope,
  ok: z.literal(false),
  error: z.object({ code: z.enum(ERROR_CODES), message: z.string().max(300) }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const pairResponseSchema = z.object({
  ...envelope,
  ok: z.literal(true),
  device: z.object({
    id: z.string().regex(UUID_RE),
    projectId: z.string().regex(UUID_RE),
    label: z.string(),
  }),
  serverOrigin: z.string(),
  heartbeatIntervalMs: z.number().int().positive(),
});
export type PairResponse = z.infer<typeof pairResponseSchema>;

export const heartbeatResponseSchema = z.object({
  ...envelope,
  ok: z.literal(true),
  device: z.object({ id: z.string().regex(UUID_RE), status: z.literal("active") }),
  acceptedCounter: z.number().int().positive(),
  heartbeatIntervalMs: z.number().int().positive(),
  /** M2D.3C1: always empty; remote job leasing arrives in M2D.3C2 */
  jobs: z.array(z.never()).max(0),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

export const statusResponseSchema = z.object({
  ...envelope,
  ok: z.literal(true),
  device: z.object({
    id: z.string().regex(UUID_RE),
    projectId: z.string().regex(UUID_RE),
    label: z.string(),
    status: z.literal("active"),
    pairedAt: z.string(),
    lastSeenAt: z.string().nullable(),
  }),
  project: z.object({ id: z.string().regex(UUID_RE), title: z.string() }),
  acceptedCounter: z.number().int().positive(),
  /**
   * "available" only when this device reported it runs remote jobs AND this server can serve them. An M2D.3C1 agent
   * never reports that, so it keeps receiving the value it was built to understand.
   */
  remoteExecution: z.enum(["available", "not_available"]),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

// ───────────────────────── remote job messages (M2D.3C2) ─────────────────────────

const assetIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const leaseRequestSchema = z.object({ protocol: z.literal(PROTOCOL) }).strict();

export const leaseSourceSchema = z
  .object({
    ordinal: z.number().int().min(0).max(299),
    assetId: assetIdSchema,
    mime: z.enum(["image/jpeg", "image/png"]),
    byteSize: z.number().int().min(1).max(MAX_SOURCE_BYTES),
    sha256: z.string().regex(HEX64_RE),
    /** the signed Prism route that serves exactly this photograph to exactly this lease */
    path: z.string().max(200),
  })
  .strict();
export type LeaseSource = z.infer<typeof leaseSourceSchema>;

export const leaseSchema = z
  .object({
    jobId: z.string().regex(JOB_ID_RE),
    attempt: z.number().int().min(1),
    leaseId: z.string().regex(LEASE_ID_RE),
    leaseExpiresAt: z.string().max(40),
    leaseTtlMs: z.number().int().positive(),
    /** true when this is the agent's own live lease returned again (e.g. after a lost response) */
    resumed: z.boolean(),
    quality: z.literal(REMOTE_QUALITY),
    sources: z.array(leaseSourceSchema).min(3).max(300),
  })
  .strict();
export type Lease = z.infer<typeof leaseSchema>;

export const leaseResponseSchema = z.object({
  ...envelope,
  ok: z.literal(true),
  lease: leaseSchema.nullable(),
  /** why no lease was given (null when one was) */
  idle: z.enum(["no_job", "toolchain_not_ready", "remote_jobs_unavailable"]).nullable(),
});
export type LeaseResponse = z.infer<typeof leaseResponseSchema>;

/** Safe, path-free facts about a VALIDATED SPZ result, frozen by the server before the bytes are uploaded. */
export const finalResultSchema = z
  .object({
    format: z.literal("spz"),
    sha256: z.string().regex(HEX64_RE),
    byteSize: z.number().int().min(1).max(MAX_SPLAT_BYTES),
    gaussianCount: z.number().int().min(1),
    shDegree: z.number().int().min(0).max(3),
    inputImages: z.number().int().min(1).max(300),
    registeredImages: z.number().int().min(0).max(300),
    registrationRatio: z.number().min(0).max(1),
    sparsePoints: z.number().int().min(0),
    quality: z.literal(REMOTE_QUALITY),
    colmap: z
      .object({
        version: z.string().regex(/^[0-9A-Za-z.+_-]{1,32}$/),
        sourceCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
        binarySha256: z.string().regex(HEX64_RE),
      })
      .strict(),
    brush: z.object({ version: z.string().regex(/^[0-9A-Za-z.+_-]{1,32}$/) }).strict(),
    spzEncoder: z.string().regex(/^[0-9A-Za-z.+_ /:@-]{1,80}$/),
    spzVersion: z.number().int().min(1).max(100),
    lossless: z.literal(false),
    clamped: z
      .object({
        positions: z.number().int().min(0),
        colors: z.number().int().min(0),
        scales: z.number().int().min(0),
        sh: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();
export type FinalResult = z.infer<typeof finalResultSchema>;

/** A short, single-line, user-language message (bounded; control characters refused). */
const safeMessage = z
  .string()
  .max(300)
  .refine((s) => !/\p{Cc}/u.test(s), "message must not contain control characters");

export const progressRequestSchema = z
  .object({
    protocol: z.literal(PROTOCOL),
    stage: z.enum(REMOTE_STAGES),
    progress: z.number().min(0).max(1),
    message: safeMessage,
    /** sent once, with stage "uploading", before the SPZ bytes: the server freezes it */
    result: finalResultSchema.optional(),
  })
  .strict();
export type ProgressRequest = z.infer<typeof progressRequestSchema>;

export const progressResponseSchema = z.object({
  ...envelope,
  ok: z.literal(true),
  leaseExpiresAt: z.string().max(40),
  leaseTtlMs: z.number().int().positive(),
});
export type ProgressResponse = z.infer<typeof progressResponseSchema>;

export const failRequestSchema = z
  .object({
    protocol: z.literal(PROTOCOL),
    code: z.enum(AGENT_FAILURE_CODES),
    stage: z.enum(REMOTE_STAGES).nullable(),
    message: safeMessage,
  })
  .strict();
export type FailRequest = z.infer<typeof failRequestSchema>;

export const jobOutcomeResponseSchema = z.object({
  ...envelope,
  ok: z.literal(true),
  job: z.object({
    id: z.string().regex(JOB_ID_RE),
    status: z.enum(["succeeded", "failed", "cancelled"]),
    reconstructionId: z.string().nullable(),
  }),
});
export type JobOutcomeResponse = z.infer<typeof jobOutcomeResponseSchema>;

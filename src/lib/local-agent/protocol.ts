import { z } from "zod";

/**
 * Prism Local Agent protocol v1 (Phase 2F M2D.3C1): the wire contract between a user's workstation (the remote Local
 * Agent) and the Prism server. Shared by both sides; pure (no filesystem, no database, no environment).
 * The full specification is docs/local-agent-protocol.md; this module is its executable form.
 *
 * The workstation is an EXTERNAL CLIENT: it holds only its own Ed25519 key pair, its device id and the pinned Prism
 * origin. It never receives a database URL, a Supabase key, a Storage credential, a provider key or a user session.
 */

export const PROTOCOL = "prism.local-agent.v1" as const;
export const PROTOCOL_VERSION = 1 as const;
export const DEVICE_SCHEMA = "prism.local-agent.v1" as const;
export const CAPABILITIES_SCHEMA = "prism.local-agent-capabilities.v1" as const;

/** The agent implementation's version string (reported, never trusted for authority). */
export const AGENT_VERSION = "prism-local-agent-0.1.0" as const;

export const API_PREFIX = "/api/local-agent/v1" as const;
export const PATHS = {
  pair: `${API_PREFIX}/pair`,
  heartbeat: `${API_PREFIX}/heartbeat`,
  status: `${API_PREFIX}/status`,
} as const;

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

/** Strict body limits: every v1 message is tiny (no media ever travels on this protocol in M2D.3C1). */
export const BODY_LIMITS = { pair: 4096, heartbeat: 8192, status: 0 } as const;

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
    /** M2D.3C1 executes nothing: always false */
    busy: z.literal(false),
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
  remoteExecution: z.literal("not_available"),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

import {
  canonicalPairingSecret,
  canonicalRequestMessage,
  canonicalTarget,
  bodySha256,
  generatePairingSecret,
  pairingSecretHash,
  pairProofMessage,
  parsePublicKey,
  ProtocolFormatError,
  verifyMessage,
} from "@/lib/local-agent/crypto";
import {
  CLOCK_SKEW_MS,
  COUNTER_RE,
  ERROR_MESSAGES,
  HEADERS,
  HEARTBEAT_INTERVAL_MS,
  heartbeatRequestSchema,
  labelSchema,
  pairRequestSchema,
  PROTOCOL,
  PROTOCOL_VERSION,
  SIGNATURE_RE,
  TIMESTAMP_RE,
  UUID_RE,
  type AgentCapabilities,
  type AgentErrorCode,
  type HeartbeatResponse,
  type PairResponse,
  type StatusResponse,
} from "@/lib/local-agent/protocol";
import type { AgentAuthStore, DeviceRecord, DeviceUpdate, LockedDevice, OwnerAgentStore } from "./store";

/**
 * The Prism server side of the Local Agent protocol (Phase 2F M2D.3C1): pairing redemption, signed-request
 * authentication with atomic anti-replay, heartbeat and status, plus the project owner's management operations.
 * Framework-free (the route handlers and server actions are thin wrappers) so every rule is unit-tested.
 *
 * Nothing here hands the workstation any credential: a successful pairing returns only the new device id, its
 * project id, its label and the canonical origin it must keep talking to.
 */

export class AgentProtocolError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string = ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = "AgentProtocolError";
  }
}

const fail = (code: AgentErrorCode): never => {
  throw new AgentProtocolError(code);
};

export interface AgentServiceDeps {
  store: AgentAuthStore;
  /** this Prism server's canonical origin (agents are pinned to it) */
  canonicalOrigin: string;
  /** server clock (Unix ms) for the timestamp window */
  now: () => number;
  /** M2D.3C2: this server can serve remote jobs (reconstruction jobs on, Storage authority present) */
  remoteJobs?: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

// ───────────────────────── pairing redemption (unauthenticated: the secret IS the credential) ─────────────────────────

export async function redeemPairing(deps: AgentServiceDeps, body: unknown): Promise<PairResponse> {
  if (body && typeof body === "object" && "protocol" in body && body.protocol !== PROTOCOL)
    fail("protocol_unsupported");
  const parsed = pairRequestSchema.safeParse(body);
  if (!parsed.success) return fail("malformed_request");
  const req = parsed.data;

  const secret = canonicalPairingSecret(req.pairingCode);
  if (!secret) return fail("invalid_pairing");
  let key;
  try {
    key = parsePublicKey(req.publicKey);
  } catch {
    return fail("malformed_request");
  }
  if (req.serverOrigin !== deps.canonicalOrigin) fail("origin_mismatch");
  const now = deps.now();
  if (Math.abs(req.timestamp - now) > CLOCK_SKEW_MS) fail("clock_skew");

  const secretHash = pairingSecretHash(secret);
  let message: Buffer;
  try {
    message = pairProofMessage({
      serverOrigin: req.serverOrigin,
      secretHash,
      fingerprint: key.fingerprint,
      timestamp: req.timestamp,
    });
  } catch {
    return fail("malformed_request");
  }
  // proof of possession: the agent holds the private key of the key it registers (verified before any DB work)
  if (!verifyMessage(key.key, message, req.proof)) fail("invalid_signature");

  const r = await deps.store.redeemPairing<AgentErrorCode>(
    secretHash,
    (p, dbNow) => {
      if (p.consumedAt) return { ok: false, error: "pairing_consumed" };
      if (p.cancelledAt) return { ok: false, error: "invalid_pairing" };
      if (Date.parse(p.expiresAt) <= dbNow) return { ok: false, error: "pairing_expired" };
      if (!p.ownerOk) return { ok: false, error: "project_forbidden" };
      return { ok: true };
    },
    {
      label: req.device.label,
      platform: req.device.platform,
      arch: req.device.arch,
      agentVersion: req.device.agentVersion,
      protocolVersion: PROTOCOL_VERSION,
      publicKey: req.publicKey,
      fingerprint: key.fingerprint,
    },
  );
  if (r.kind === "none") return fail("invalid_pairing");
  if (r.kind === "refused") return fail(r.error);
  if (r.kind === "key_in_use")
    throw new AgentProtocolError(
      "malformed_request",
      "This device key is already registered. The agent generates a new key for every pairing.",
    );
  return {
    protocol: PROTOCOL,
    ok: true,
    serverTime: iso(deps.now()),
    device: { id: r.device.id, projectId: r.device.projectId, label: r.device.label },
    serverOrigin: deps.canonicalOrigin,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  };
}

// ───────────────────────── signed requests ─────────────────────────

export interface IncomingRequest {
  method: string;
  url: URL;
  /** lower-case header lookup */
  header: (name: string) => string | null;
  /** the exact body bytes received */
  body: Uint8Array;
}

export interface Authenticated {
  device: DeviceRecord;
  projectTitle: string | null;
  counter: number;
  /** the request's SIGNED timestamp (Unix ms; within the clock-skew window) */
  timestamp: number;
}

/**
 * Verifies a signed request and atomically accepts its counter. Checks, in order, inside the device-row lock:
 * known device → signature → not revoked → project still its owner's → timestamp window → counter strictly
 * greater than the last accepted one. Only an accepted request changes anything (the counter, last seen and the
 * caller's `update`); a refused one changes nothing.
 */
export async function authenticateRequest(
  deps: AgentServiceDeps,
  req: IncomingRequest,
  update: (d: LockedDevice) => Omit<DeviceUpdate, "lastCounter"> = () => ({}),
): Promise<Authenticated> {
  const protocol = req.header(HEADERS.protocol);
  if (protocol !== String(PROTOCOL_VERSION))
    fail(protocol === null ? "malformed_request" : "protocol_unsupported");
  const agentId = req.header(HEADERS.agentId) ?? "";
  const counterText = req.header(HEADERS.counter) ?? "";
  const tsText = req.header(HEADERS.timestamp) ?? "";
  const signature = req.header(HEADERS.signature) ?? "";
  if (!UUID_RE.test(agentId) || !COUNTER_RE.test(counterText) || !TIMESTAMP_RE.test(tsText))
    fail("malformed_request");
  if (!SIGNATURE_RE.test(signature)) fail("malformed_request");
  const counter = Number(counterText);
  const timestamp = Number(tsText);
  if (!Number.isSafeInteger(counter) || !Number.isSafeInteger(timestamp)) fail("malformed_request");

  let message: Buffer;
  try {
    message = canonicalRequestMessage({
      agentId,
      counter,
      timestamp,
      method: req.method.toUpperCase(),
      target: canonicalTarget(req.url),
      bodySha256: bodySha256(req.body),
    });
  } catch (e) {
    if (e instanceof ProtocolFormatError) return fail("malformed_request");
    throw e;
  }

  const now = deps.now();
  const r = await deps.store.authenticate<AgentErrorCode>(agentId, (d) => {
    let key;
    try {
      key = parsePublicKey(d.publicKey).key;
    } catch {
      return { ok: false, error: "invalid_signature" };
    }
    if (!verifyMessage(key, message, signature)) return { ok: false, error: "invalid_signature" };
    if (d.status === "revoked") return { ok: false, error: "device_revoked" };
    if (!d.ownerOk) return { ok: false, error: "project_forbidden" };
    if (Math.abs(timestamp - now) > CLOCK_SKEW_MS) return { ok: false, error: "clock_skew" };
    if (counter <= d.lastCounter) return { ok: false, error: "counter_replayed" };
    return { ok: true, update: { ...update(d), lastCounter: counter } };
  });
  if (r.kind === "none") return fail("device_unknown");
  if (r.kind === "refused") return fail(r.error);
  return { device: r.device, projectTitle: r.projectTitle, counter, timestamp };
}

/** Parses a heartbeat body BEFORE authentication (a malformed body never reaches the device lock). */
export function parseHeartbeatBody(body: Uint8Array): AgentCapabilities {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return fail("malformed_request");
  }
  if (json && typeof json === "object" && "protocol" in json && json.protocol !== PROTOCOL)
    fail("protocol_unsupported");
  const parsed = heartbeatRequestSchema.safeParse(json);
  if (!parsed.success) return fail("malformed_request");
  return parsed.data.capabilities;
}

export async function heartbeat(deps: AgentServiceDeps, req: IncomingRequest): Promise<HeartbeatResponse> {
  const capabilities = parseHeartbeatBody(req.body);
  const a = await authenticateRequest(deps, req, () => ({
    capabilities,
    agentVersion: capabilities.agentVersion,
    protocolVersion: capabilities.protocolVersion,
  }));
  return {
    protocol: PROTOCOL,
    ok: true,
    serverTime: iso(deps.now()),
    device: { id: a.device.id, status: "active" },
    acceptedCounter: a.counter,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    jobs: [],
  };
}

export async function status(deps: AgentServiceDeps, req: IncomingRequest): Promise<StatusResponse> {
  if (req.body.length > 0) fail("malformed_request");
  const a = await authenticateRequest(deps, req);
  return {
    protocol: PROTOCOL,
    ok: true,
    serverTime: iso(deps.now()),
    device: {
      id: a.device.id,
      projectId: a.device.projectId,
      label: a.device.label,
      status: "active",
      pairedAt: a.device.createdAt,
      lastSeenAt: a.device.lastSeenAt,
    },
    project: { id: a.device.projectId, title: a.projectTitle ?? "" },
    acceptedCounter: a.counter,
    // only an agent that said it runs remote jobs is told they are available (an M2D.3C1 agent never says so)
    remoteExecution:
      deps.remoteJobs && a.device.capabilities?.execution?.remoteJobs ? "available" : "not_available",
  };
}

// ───────────────────────── the project owner's operations ─────────────────────────

export class OwnerAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerAgentError";
  }
}

/**
 * A new one-time pairing offer. The plaintext secret is returned ONCE (to be shown to the owner) and never stored;
 * the store keeps only its digest. Earlier unused offers of the project are cancelled.
 */
export async function createPairingOffer(
  store: OwnerAgentStore,
  projectId: string,
  random?: (n: number) => Uint8Array,
): Promise<{ pairingId: string; code: string; expiresAt: string; createdAt: string }> {
  const code = generatePairingSecret(random);
  const p = await store.createPairing(projectId, pairingSecretHash(canonicalPairingSecret(code)!));
  return { pairingId: p.id, code, expiresAt: p.expiresAt, createdAt: p.createdAt };
}

export type PairingState = "pending" | "paired" | "expired" | "cancelled";

export async function pairingOfferState(
  store: OwnerAgentStore,
  projectId: string,
  pairingId: string,
  nowMs: number,
): Promise<{ state: PairingState; expiresAt: string; device: { id: string; label: string } | null } | null> {
  const p = await store.getPairing(projectId, pairingId);
  if (!p) return null;
  const state: PairingState = p.consumedAt
    ? "paired"
    : p.cancelledAt
      ? "cancelled"
      : Date.parse(p.expiresAt) <= nowMs
        ? "expired"
        : "pending";
  return { state, expiresAt: p.expiresAt, device: p.device };
}

export async function renameAgent(
  store: OwnerAgentStore,
  projectId: string,
  deviceId: string,
  label: string,
) {
  const parsed = labelSchema.safeParse(label);
  if (!parsed.success)
    throw new OwnerAgentError("A device name is 1-64 characters with no control characters.");
  const d = await store.renameDevice(projectId, deviceId, parsed.data);
  if (!d) throw new OwnerAgentError("That device is not an active device of this project.");
  return d;
}

export async function revokeAgent(store: OwnerAgentStore, projectId: string, deviceId: string) {
  const d = await store.revokeDevice(projectId, deviceId);
  if (!d) throw new OwnerAgentError("That device is not a device of this project.");
  return d;
}

import type { KeyObject } from "node:crypto";
import { platform as osPlatform, arch as osArch } from "node:os";
import {
  bodySha256,
  canonicalPairingSecret,
  canonicalRequestMessage,
  canonicalTarget,
  normalizeServerOrigin,
  pairingSecretHash,
  pairProofMessage,
  signMessage,
} from "../crypto";
import {
  AGENT_VERSION,
  errorResponseSchema,
  HEADERS,
  heartbeatResponseSchema,
  pairResponseSchema,
  PATHS,
  PROTOCOL,
  PROTOCOL_VERSION,
  statusResponseSchema,
  type AgentCapabilities,
  type AgentErrorCode,
  type HeartbeatResponse,
  type StatusResponse,
} from "../protocol";
import { acquireProfileLock } from "./lock";
import {
  AgentStateError,
  CONFIG_SCHEMA,
  FileKeyStore,
  KEY_FILE,
  readConfig,
  reserveCounter,
  writeConfig,
  type AgentConfig,
} from "./store";

/**
 * The workstation side of the Local Agent protocol v1: OUTBOUND HTTPS requests to the ONE pinned Prism origin.
 * Redirects are never followed (an authenticated request is never re-sent anywhere else), responses are size-capped
 * and schema-checked, and every signed request uses a freshly reserved counter: a request whose response was lost is
 * never retried with the same signature; the next request simply carries the next counter.
 */

export type ClientErrorCode = AgentErrorCode | "network" | "redirect" | "bad_response" | "state";

export class AgentRequestError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "AgentRequestError";
  }
}

export interface ClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const MAX_RESPONSE = 64 * 1024;

async function send(
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array },
  o: ClientOptions,
): Promise<{ status: number; json: unknown }> {
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, {
      method: init.method,
      headers: init.headers,
      body: init.body ? Buffer.from(init.body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new AgentRequestError(
      "network",
      `Could not reach Prism (${e instanceof Error ? e.name : "error"}).`,
    );
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400))
    throw new AgentRequestError(
      "redirect",
      "Prism answered with a redirect. The agent never follows redirects; check the server address.",
      res.status,
    );
  const text = await res.text().catch(() => "");
  if (text.length > MAX_RESPONSE)
    throw new AgentRequestError("bad_response", "Response too large.", res.status);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AgentRequestError("bad_response", `Unexpected response (HTTP ${res.status}).`, res.status);
  }
  const err = errorResponseSchema.safeParse(json);
  if (err.success) throw new AgentRequestError(err.data.error.code, err.data.error.message, res.status);
  if (!res.ok)
    throw new AgentRequestError("bad_response", `Unexpected response (HTTP ${res.status}).`, res.status);
  return { status: res.status, json };
}

export function devicePlatform(p: NodeJS.Platform = osPlatform()): "win32" | "linux" | "darwin" {
  if (p === "win32" || p === "linux" || p === "darwin") return p;
  throw new AgentStateError(`The Local Agent does not support the ${p} platform.`);
}

export function deviceArch(a: string = osArch()): string {
  return /^[a-z0-9_]{1,16}$/.test(a) ? a : "unknown";
}

// ───────────────────────── pairing ─────────────────────────

export interface PairOptions extends ClientOptions {
  profileDir: string;
  server: string;
  code: string;
  label: string;
}

/**
 * Pairs this workstation: generates an Ed25519 key pair LOCALLY, proves possession of it, and registers only the
 * public key. The private key never leaves the profile directory and the pairing code is never written anywhere.
 */
export async function pairAgent(o: PairOptions): Promise<AgentConfig> {
  const origin = normalizeServerOrigin(o.server);
  const secret = canonicalPairingSecret(o.code);
  if (!secret) throw new AgentRequestError("invalid_pairing", "That is not a Prism pairing code.");
  const release = await acquireProfileLock(o.profileDir);
  const keys = new FileKeyStore(o.profileDir);
  try {
    if (await readConfig(o.profileDir))
      throw new AgentStateError(
        "This profile is already paired. Use another --profile, or `forget` this one first (then revoke it in Prism).",
      );
    await keys.discardPending(); // a key from an interrupted attempt is never reused
    const key = await keys.createPending();
    const timestamp = (o.now ?? Date.now)();
    const proof = signMessage(
      key.privateKey,
      pairProofMessage({
        serverOrigin: origin,
        secretHash: pairingSecretHash(secret),
        fingerprint: key.fingerprint,
        timestamp,
      }),
    );
    const body = Buffer.from(
      JSON.stringify({
        protocol: PROTOCOL,
        pairingCode: secret,
        publicKey: key.publicKey,
        serverOrigin: origin,
        timestamp,
        proof,
        device: {
          label: o.label,
          platform: devicePlatform(),
          arch: deviceArch(),
          agentVersion: AGENT_VERSION,
        },
      }),
    );
    let res;
    try {
      res = await send(
        new URL(PATHS.pair, origin),
        { method: "POST", headers: { "content-type": "application/json" }, body },
        o,
      );
    } catch (e) {
      await keys.discardPending();
      throw e;
    }
    const parsed = pairResponseSchema.safeParse(res.json);
    if (!parsed.success || parsed.data.serverOrigin !== origin) {
      await keys.discardPending();
      throw new AgentRequestError(
        "bad_response",
        "Prism's pairing answer was not valid for this address; nothing was saved. Revoke the new device in Prism if one appeared.",
      );
    }
    await keys.commitPending();
    const config: AgentConfig = {
      schema: CONFIG_SCHEMA,
      protocolVersion: PROTOCOL_VERSION,
      deviceId: parsed.data.device.id,
      projectId: parsed.data.device.projectId,
      serverOrigin: origin,
      label: parsed.data.device.label,
      publicKeyFingerprint: key.fingerprint,
      privateKeyFile: KEY_FILE,
      lastCounter: 0,
      pairedAt: parsed.data.serverTime,
      revokedAt: null,
    };
    await writeConfig(o.profileDir, config);
    return config;
  } finally {
    await release();
  }
}

// ───────────────────────── signed requests ─────────────────────────

export class AgentClient {
  private constructor(
    private readonly dir: string,
    private readonly key: KeyObject,
    private config: AgentConfig,
    private readonly o: ClientOptions,
  ) {}

  /** Loads a paired profile. The caller holds the profile lock for as long as it signs requests. */
  static async open(profileDir: string, o: ClientOptions = {}): Promise<AgentClient> {
    const config = await readConfig(profileDir);
    if (!config) throw new AgentStateError("This profile is not paired. Run `pair` first.");
    if (config.revokedAt)
      throw new AgentStateError("This device was revoked in Prism. Forget this profile and pair again.");
    const key = await new FileKeyStore(profileDir).load();
    return new AgentClient(profileDir, key, config, o);
  }

  get device() {
    return this.config;
  }

  private async signed(method: "GET" | "POST", path: string, body: unknown | null) {
    const url = new URL(path, this.config.serverOrigin);
    // origin pinning: a signed request only ever goes to the origin recorded at pairing
    if (url.origin !== this.config.serverOrigin)
      throw new AgentStateError("Refusing a request to another origin.");
    const bytes = body === null ? new Uint8Array(0) : Buffer.from(JSON.stringify(body));
    const { counter, config } = await reserveCounter(this.dir);
    this.config = config;
    const timestamp = (this.o.now ?? Date.now)();
    const signature = signMessage(
      this.key,
      canonicalRequestMessage({
        agentId: config.deviceId,
        counter,
        timestamp,
        method,
        target: canonicalTarget(url),
        bodySha256: bodySha256(bytes),
      }),
    );
    const headers: Record<string, string> = {
      [HEADERS.protocol]: String(PROTOCOL_VERSION),
      [HEADERS.agentId]: config.deviceId,
      [HEADERS.counter]: String(counter),
      [HEADERS.timestamp]: String(timestamp),
      [HEADERS.signature]: signature,
    };
    if (body !== null) headers["content-type"] = "application/json";
    try {
      return await send(url, { method, headers, body: body === null ? undefined : bytes }, this.o);
    } catch (e) {
      if (e instanceof AgentRequestError && e.code === "device_revoked") {
        this.config = { ...this.config, revokedAt: new Date().toISOString() };
        await writeConfig(this.dir, { ...(await readConfig(this.dir))!, revokedAt: this.config.revokedAt });
      }
      throw e;
    }
  }

  async heartbeat(capabilities: AgentCapabilities): Promise<HeartbeatResponse> {
    const r = await this.signed("POST", PATHS.heartbeat, { protocol: PROTOCOL, capabilities });
    const p = heartbeatResponseSchema.safeParse(r.json);
    if (!p.success) throw new AgentRequestError("bad_response", "Unexpected heartbeat answer.", r.status);
    return p.data;
  }

  async status(): Promise<StatusResponse> {
    const r = await this.signed("GET", PATHS.status, null);
    const p = statusResponseSchema.safeParse(r.json);
    if (!p.success) throw new AgentRequestError("bad_response", "Unexpected status answer.", r.status);
    return p.data;
  }
}

/** Errors after which the agent must stop (retrying cannot help; a person has to act). */
export const FATAL_CODES: ReadonlySet<ClientErrorCode> = new Set([
  "device_revoked",
  "device_unknown",
  "invalid_signature",
  "counter_replayed",
  "project_forbidden",
  "protocol_unsupported",
  "malformed_request",
  "redirect",
  "state",
]);

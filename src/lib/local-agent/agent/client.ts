import { createHash, type KeyObject } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { platform as osPlatform, arch as osArch } from "node:os";
import { SPLAT_FORMAT_INFO } from "@/domain/previs/splat";
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
  jobOutcomeResponseSchema,
  jobPaths,
  leaseResponseSchema,
  pairResponseSchema,
  PATHS,
  progressResponseSchema,
  PROTOCOL,
  PROTOCOL_VERSION,
  statusResponseSchema,
  type AgentCapabilities,
  type AgentErrorCode,
  type FailRequest,
  type HeartbeatResponse,
  type JobOutcomeResponse,
  type LeaseResponse,
  type LeaseSource,
  type ProgressRequest,
  type ProgressResponse,
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
 *
 * Signed requests of one device are SERIALISED (one in flight): the server accepts only strictly increasing counters,
 * so two concurrent requests could arrive out of order and the later-numbered one would win. Heartbeats, keepalives,
 * source downloads and the result upload therefore queue behind each other.
 */

export type ClientErrorCode =
  | AgentErrorCode
  | "network"
  | "redirect"
  | "bad_response"
  | "state"
  /** a downloaded photograph did not match its frozen facts */
  | "source_mismatch"
  /** the caller stopped the request */
  | "aborted";

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

async function exchange(
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array },
  o: ClientOptions,
  timeoutMs = o.timeoutMs ?? 15_000,
): Promise<Response> {
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, {
      method: init.method,
      headers: init.headers,
      body: init.body ? Buffer.from(init.body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AgentRequestError(
      "network",
      `Could not reach Prism (${e instanceof Error ? e.name : "error"}).`,
    );
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => undefined);
    throw new AgentRequestError(
      "redirect",
      "Prism answered with a redirect. The agent never follows redirects; check the server address.",
      res.status,
    );
  }
  return res;
}

/** Reads at most `max` bytes of a response body; a longer body is refused (and the stream cancelled). */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let r: ReadableStreamReadResult<Uint8Array>;
    try {
      r = await reader.read();
    } catch {
      throw new AgentRequestError("network", "The connection to Prism was interrupted.", res.status);
    }
    if (r.done) break;
    total += r.value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new AgentRequestError("bad_response", "Response too large.", res.status);
    }
    chunks.push(r.value);
  }
  return Buffer.concat(chunks);
}

async function send(
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array },
  o: ClientOptions,
): Promise<{ status: number; json: unknown }> {
  return jsonOf(await exchange(url, init, o));
}

async function jsonOf(res: Response): Promise<{ status: number; json: unknown }> {
  const text = Buffer.from(await readCapped(res, MAX_RESPONSE)).toString("utf8");
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

/** Expected facts of one source photograph (from the lease); the download must match all of them. */
export interface SourceExpectation {
  path: string;
  mime: LeaseSource["mime"];
  byteSize: number;
  sha256: string;
}

/** A JPEG starts FF D8 FF; a PNG with its 8-byte signature. Anything else is not the photograph Prism froze. */
export function imageSignatureMatches(head: Uint8Array, mime: string): boolean {
  if (mime === "image/jpeg")
    return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (mime === "image/png")
    return (
      head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b)
    );
  return false;
}

export class AgentClient {
  /** one signed request at a time (see the module note) */
  private queue: Promise<unknown> = Promise.resolve();

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

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private signed(method: "GET" | "POST", path: string, body: unknown | null) {
    return this.exclusive(async () => {
      const bytes = body === null ? null : Buffer.from(JSON.stringify(body));
      const res = await this.signedExchange(method, path, bytes, body === null ? null : "application/json");
      return this.revokedAware(() => jsonOf(res));
    });
  }

  /** A failure answer saying the device was revoked marks this profile revoked (it never signs again). */
  private async revokedAware<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AgentRequestError && e.code === "device_revoked") {
        this.config = { ...this.config, revokedAt: new Date().toISOString() };
        await writeConfig(this.dir, { ...(await readConfig(this.dir))!, revokedAt: this.config.revokedAt });
      }
      throw e;
    }
  }

  /** Signs and sends one request (the caller holds the request queue). */
  private async signedExchange(
    method: "GET" | "POST" | "PUT",
    path: string,
    payload: Uint8Array | null,
    contentType: string | null,
    timeoutMs?: number,
  ): Promise<Response> {
    const url = new URL(path, this.config.serverOrigin);
    // origin pinning: a signed request only ever goes to the origin recorded at pairing
    if (url.origin !== this.config.serverOrigin)
      throw new AgentStateError("Refusing a request to another origin.");
    const bytes = payload ?? new Uint8Array(0);
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
    if (contentType !== null) headers["content-type"] = contentType;
    return exchange(url, { method, headers, body: payload === null ? undefined : bytes }, this.o, timeoutMs);
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

  // ───────────────────────── remote jobs (M2D.3C2) ─────────────────────────

  /** The device's own live lease, or the oldest queued job of its project, or none. */
  async lease(): Promise<LeaseResponse> {
    const r = await this.signed("POST", PATHS.lease, { protocol: PROTOCOL });
    const p = leaseResponseSchema.safeParse(r.json);
    if (!p.success) throw new AgentRequestError("bad_response", "Unexpected lease answer.", r.status);
    const lease = p.data.lease;
    // the agent fetches only the routes it can construct itself for this lease (never a server-chosen location)
    if (lease) {
      const paths = jobPaths(lease.jobId, lease.leaseId);
      if (lease.sources.some((s, i) => s.ordinal !== i || s.path !== paths.source(i)))
        throw new AgentRequestError("bad_response", "The lease names unexpected source routes.", r.status);
    }
    return p.data;
  }

  async progress(
    jobId: string,
    leaseId: string,
    body: Omit<ProgressRequest, "protocol">,
  ): Promise<ProgressResponse> {
    const r = await this.signed("POST", jobPaths(jobId, leaseId).progress, { protocol: PROTOCOL, ...body });
    const p = progressResponseSchema.safeParse(r.json);
    if (!p.success) throw new AgentRequestError("bad_response", "Unexpected progress answer.", r.status);
    return p.data;
  }

  async fail(
    jobId: string,
    leaseId: string,
    body: Omit<FailRequest, "protocol">,
  ): Promise<JobOutcomeResponse> {
    const r = await this.signed("POST", jobPaths(jobId, leaseId).fail, { protocol: PROTOCOL, ...body });
    const p = jobOutcomeResponseSchema.safeParse(r.json);
    if (!p.success) throw new AgentRequestError("bad_response", "Unexpected failure answer.", r.status);
    return p.data;
  }

  /**
   * Downloads ONE source photograph to `dest` (created exclusively), verifying as it streams: never more bytes than
   * frozen, the declared type and checksum, the image signature, and the exact length. On any mismatch the partial
   * file is removed and a `source_mismatch` error is raised (the caller fails the job; nothing is run).
   */
  async downloadSource(expect: SourceExpectation, dest: string, signal?: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      const res = await this.signedExchange("GET", expect.path, null, null, 120_000);
      if (!res.ok || (res.headers.get("content-type") ?? "").startsWith("application/json"))
        return void (await this.revokedAware(() => jsonOf(res)));
      const mismatch = (why: string) =>
        new AgentRequestError("source_mismatch", `A photograph ${why}.`, res.status);
      if ((res.headers.get("content-type") ?? "").split(";")[0].trim() !== expect.mime) {
        await res.body?.cancel().catch(() => undefined);
        throw mismatch("has an unexpected type");
      }
      const declared = res.headers.get("content-length");
      if (
        (declared !== null && Number(declared) !== expect.byteSize) ||
        res.headers.get("x-prism-source-sha256") !== expect.sha256
      ) {
        await res.body?.cancel().catch(() => undefined);
        throw mismatch("does not match its frozen size or checksum");
      }
      const fh = await open(dest, "wx", 0o600);
      const hash = createHash("sha256");
      let total = 0;
      let head = new Uint8Array(0);
      let ok = false;
      try {
        const reader = res.body!.getReader();
        for (;;) {
          if (signal?.aborted) {
            await reader.cancel().catch(() => undefined);
            throw new AgentRequestError("aborted", "Stopped.");
          }
          let r: ReadableStreamReadResult<Uint8Array>;
          try {
            r = await reader.read();
          } catch {
            throw new AgentRequestError("network", "The download from Prism was interrupted.", res.status);
          }
          if (r.done) break;
          total += r.value.byteLength;
          if (total > expect.byteSize) {
            await reader.cancel().catch(() => undefined);
            throw mismatch("is larger than its frozen size");
          }
          if (head.length < 8) head = Buffer.concat([head, r.value.subarray(0, 8 - head.length)]);
          hash.update(r.value);
          await fh.write(r.value);
        }
        if (total !== expect.byteSize) throw mismatch("is shorter than its frozen size");
        if (hash.digest("hex") !== expect.sha256) throw mismatch("does not match its frozen checksum");
        if (!imageSignatureMatches(head, expect.mime)) throw mismatch("is not the image type Prism recorded");
        await fh.sync();
        ok = true;
      } finally {
        await fh.close();
        if (!ok) await rm(dest, { force: true }).catch(() => undefined);
      }
    });
  }

  /** Uploads the ONE validated SPZ result (the signature covers these exact bytes). */
  async uploadResult(jobId: string, leaseId: string, bytes: Uint8Array): Promise<JobOutcomeResponse> {
    return this.exclusive(async () => {
      const res = await this.signedExchange(
        "PUT",
        jobPaths(jobId, leaseId).result,
        bytes,
        SPLAT_FORMAT_INFO.spz.mime,
        // a 50 MB upload on a slow uplink takes time; the server judges it by when it was signed
        10 * 60_000,
      );
      const r = await this.revokedAware(() => jsonOf(res));
      const p = jobOutcomeResponseSchema.safeParse(r.json);
      if (!p.success) throw new AgentRequestError("bad_response", "Unexpected result answer.", r.status);
      return p.data;
    });
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

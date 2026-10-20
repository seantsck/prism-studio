import { randomUUID } from "node:crypto";
import { SPLAT_FORMAT_INFO } from "@/domain/previs/splat";
import {
  BODY_LIMITS,
  ERROR_MESSAGES,
  ERROR_STATUS,
  HEADERS as AGENT_HEADERS,
  JOB_ID_RE,
  LEASE_ID_RE,
  ORDINAL_RE,
  PROTOCOL,
  UUID_RE,
  type AgentErrorCode,
} from "@/lib/local-agent/protocol";
import {
  failJob,
  leaseJob,
  progress,
  resultUploadGate,
  serveSource,
  uploadResult,
  type RemoteJobDeps,
} from "./jobs/service";
import { AgentProtocolError, heartbeat, redeemPairing, status, type AgentServiceDeps } from "./service";

/**
 * HTTP framing of the Local Agent protocol for the Next.js route handlers (Web Request/Response only). Strict body
 * limits are enforced while reading (a declared or streamed body over the limit is refused before parsing), every
 * response is JSON in the protocol envelope with a stable error code, and nothing is cached.
 */

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;

export function agentJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

export function agentError(code: AgentErrorCode, message: string = ERROR_MESSAGES[code]): Response {
  return agentJson(
    { protocol: PROTOCOL, ok: false, serverTime: new Date().toISOString(), error: { code, message } },
    ERROR_STATUS[code],
  );
}

/** Reads at most `limit` bytes; anything longer (declared or actual) is payload_too_large. */
export async function readLimitedBody(req: Request, limit: number): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new AgentProtocolError("payload_too_large");
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new AgentProtocolError("payload_too_large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function requireJson(req: Request) {
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new AgentProtocolError("malformed_request");
}

/** Converts any failure into a protocol error response; unexpected errors are logged with a reference only. */
async function respond(body: () => Promise<unknown>): Promise<Response> {
  return respondRaw(async () => agentJson(await body()));
}

async function respondRaw(body: () => Promise<Response>): Promise<Response> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof AgentProtocolError) return agentError(e.code, e.message);
    const ref = randomUUID().slice(0, 8);
    console.error(`[local-agent ${ref}]`, e instanceof Error ? e.name : "unknown error");
    return agentJson(
      {
        protocol: PROTOCOL,
        ok: false,
        serverTime: new Date().toISOString(),
        error: {
          code: "malformed_request",
          message: `The server could not process the request (ref ${ref}).`,
        },
      },
      500,
    );
  }
}

const incoming = (req: Request, body: Uint8Array) => ({
  method: req.method,
  url: new URL(req.url),
  header: (n: string) => req.headers.get(n),
  body,
});

export function handlePair(req: Request, deps: AgentServiceDeps): Promise<Response> {
  return respond(async () => {
    requireJson(req);
    const body = await readLimitedBody(req, BODY_LIMITS.pair);
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(body).toString("utf8"));
    } catch {
      throw new AgentProtocolError("malformed_request");
    }
    return redeemPairing(deps, json);
  });
}

export function handleHeartbeat(req: Request, deps: AgentServiceDeps): Promise<Response> {
  return respond(async () => {
    requireJson(req);
    const body = await readLimitedBody(req, BODY_LIMITS.heartbeat);
    return heartbeat(deps, incoming(req, body));
  });
}

export function handleStatus(req: Request, deps: AgentServiceDeps): Promise<Response> {
  return respond(async () => {
    const body = await readLimitedBody(req, BODY_LIMITS.status);
    return status(deps, incoming(req, body));
  });
}

// ───────────────────────── remote jobs (M2D.3C2) ─────────────────────────

export interface LeaseRouteParams {
  jobId: string;
  leaseId: string;
}

/** Route ids are checked against their grammar before anything else (no lookup for a malformed id). */
function leaseParams(p: LeaseRouteParams) {
  if (!JOB_ID_RE.test(p.jobId) || !LEASE_ID_RE.test(p.leaseId))
    throw new AgentProtocolError("malformed_request");
  return p;
}

export function handleLease(req: Request, deps: RemoteJobDeps): Promise<Response> {
  return respond(async () => {
    requireJson(req);
    const body = await readLimitedBody(req, BODY_LIMITS.lease);
    return leaseJob(deps, incoming(req, body));
  });
}

/**
 * One source photograph, as raw bytes: its own safe image type, its length and its frozen sha256, never cached and
 * never with a file name. Read server-side from private storage; no Storage URL ever reaches the workstation.
 */
export function handleSource(
  req: Request,
  deps: RemoteJobDeps,
  params: LeaseRouteParams & { ordinal: string },
): Promise<Response> {
  return respondRaw(async () => {
    const { jobId, leaseId } = leaseParams(params);
    if (!ORDINAL_RE.test(params.ordinal)) throw new AgentProtocolError("malformed_request");
    const body = await readLimitedBody(req, BODY_LIMITS.source);
    const src = await serveSource(deps, incoming(req, body), jobId, leaseId, Number(params.ordinal));
    return new Response(Buffer.from(src.bytes), {
      status: 200,
      headers: {
        "content-type": src.mime,
        "content-length": String(src.bytes.length),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-prism-source-sha256": src.sha256,
      },
    });
  });
}

export function handleProgress(
  req: Request,
  deps: RemoteJobDeps,
  params: LeaseRouteParams,
): Promise<Response> {
  return respond(async () => {
    const { jobId, leaseId } = leaseParams(params);
    requireJson(req);
    const body = await readLimitedBody(req, BODY_LIMITS.progress);
    return progress(deps, incoming(req, body), jobId, leaseId);
  });
}

export function handleFail(req: Request, deps: RemoteJobDeps, params: LeaseRouteParams): Promise<Response> {
  return respond(async () => {
    const { jobId, leaseId } = leaseParams(params);
    requireJson(req);
    const body = await readLimitedBody(req, BODY_LIMITS.fail);
    return failJob(deps, incoming(req, body), jobId, leaseId);
  });
}

/**
 * The one SPZ result of a lease. Before anything is buffered, the upload must name a leased job of the claimed device
 * with a declared result of exactly the declared length (so an unrelated caller can never make the server hold 50 MB);
 * the body is then read up to that length only, and the signed request is verified over those exact bytes.
 */
export function handleResult(req: Request, deps: RemoteJobDeps, params: LeaseRouteParams): Promise<Response> {
  return respond(async () => {
    const { jobId, leaseId } = leaseParams(params);
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== SPLAT_FORMAT_INFO.spz.mime) throw new AgentProtocolError("malformed_request");
    const declared = req.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMITS.result))
      throw new AgentProtocolError("payload_too_large");
    const agentId = req.headers.get(AGENT_HEADERS.agentId);
    const limit = await resultUploadGate(
      deps,
      agentId && UUID_RE.test(agentId) ? agentId : null,
      jobId,
      leaseId,
      declared === null ? null : Number(declared),
    );
    const body = await readLimitedBody(req, Math.min(limit, BODY_LIMITS.result));
    return uploadResult(deps, incoming(req, body), jobId, leaseId);
  });
}

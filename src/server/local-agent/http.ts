import { randomUUID } from "node:crypto";
import {
  BODY_LIMITS,
  ERROR_MESSAGES,
  ERROR_STATUS,
  PROTOCOL,
  type AgentErrorCode,
} from "@/lib/local-agent/protocol";
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
  try {
    return agentJson(await body());
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

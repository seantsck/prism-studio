import { createServer, type Server } from "node:http";
import {
  handleFail,
  handleHeartbeat,
  handleLease,
  handlePair,
  handleProgress,
  handleResult,
  handleSource,
  handleStatus,
} from "../../http";
import type { RemoteJobDeps } from "../service";

/**
 * TEST-ONLY: a real HTTP server that routes every Local Agent path to the PRODUCTION handlers (the same ones the Next
 * route files call), over a test world's memory stores. No Next.js and no database: the agent under test is the real
 * client, signing real requests. `down = true` simulates Prism being unreachable (connections are dropped).
 */
export async function prismServer(deps: RemoteJobDeps) {
  const log: string[] = [];
  const state = { down: false };
  const JOB =
    /^\/api\/local-agent\/v1\/jobs\/([^/]+)\/leases\/([^/]+)\/(sources\/([^/]+)|progress|fail|result)$/;
  const server: Server = createServer(async (req, res) => {
    if (state.down) return void req.socket.destroy();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, "http://x");
    log.push(`${req.method} ${url.pathname}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`${origin}${req.url}`, { method: req.method, headers, body });
    const p = url.pathname;
    const m = JOB.exec(p);
    let r: Response;
    if (p === "/api/local-agent/v1/pair") r = await handlePair(request, deps.agent);
    else if (p === "/api/local-agent/v1/heartbeat") r = await handleHeartbeat(request, deps.agent);
    else if (p === "/api/local-agent/v1/status") r = await handleStatus(request, deps.agent);
    else if (p === "/api/local-agent/v1/jobs/lease") r = await handleLease(request, deps);
    else if (m && m[4] !== undefined)
      r = await handleSource(request, deps, { jobId: m[1]!, leaseId: m[2]!, ordinal: m[4]! });
    else if (m?.[3] === "progress") r = await handleProgress(request, deps, { jobId: m[1]!, leaseId: m[2]! });
    else if (m?.[3] === "fail") r = await handleFail(request, deps, { jobId: m[1]!, leaseId: m[2]! });
    else if (m?.[3] === "result") r = await handleResult(request, deps, { jobId: m[1]!, leaseId: m[2]! });
    else r = new Response("not found", { status: 404 });
    if (state.down) return void req.socket.destroy();
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  deps.agent.canonicalOrigin = origin;
  return {
    origin,
    log,
    state,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

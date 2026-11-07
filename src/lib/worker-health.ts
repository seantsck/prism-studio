import { createServer, type Server } from "node:http";

/**
 * Liveness for long-running workers (Phase 5A.1, Vercel Daemons). A daemon's `livenessProbe` can only be an HTTP GET
 * on a port inside the instance, and a failed probe restarts the instance with SIGKILL (no grace period). So the
 * signal must mean "this process's loop is stuck", never "a dependency is down": a database or provider outage
 * is visible in logs and the queue, and restarting would not fix it.
 *
 * Live = the worker loop completed an iteration within `staleAfterMs`. Consecutive tick failures are REPORTED (for
 * logs and the admin health page) but do not fail liveness. The body holds counts and ages only: never an id, a URL,
 * an error message, a credential or a provider payload.
 */
export interface LivenessOptions {
  /** how long without a completed loop iteration before the process is considered stuck */
  staleAfterMs: number;
  now?: () => number;
}

export interface LivenessReport {
  live: boolean;
  startedAgoMs: number;
  lastLoopAgoMs: number | null;
  loops: number;
  processed: number;
  consecutiveFailures: number;
}

export class WorkerLiveness {
  private readonly staleAfterMs: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private lastLoopAt: number | null = null;
  private loops = 0;
  private processed = 0;
  private consecutiveFailures = 0;

  constructor(opts: LivenessOptions) {
    if (!Number.isFinite(opts.staleAfterMs) || opts.staleAfterMs <= 0)
      throw new Error("staleAfterMs must be a positive number");
    this.staleAfterMs = opts.staleAfterMs;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** Record one completed loop iteration. */
  beat(e: { ok: boolean; processed: number }): void {
    this.lastLoopAt = this.now();
    this.loops += 1;
    this.processed += Math.max(0, Math.trunc(e.processed));
    this.consecutiveFailures = e.ok ? 0 : this.consecutiveFailures + 1;
  }

  report(): LivenessReport {
    const now = this.now();
    // before the first iteration completes, the start time is the reference (startup gets the same window)
    const reference = this.lastLoopAt ?? this.startedAt;
    return {
      live: now - reference <= this.staleAfterMs,
      startedAgoMs: now - this.startedAt,
      lastLoopAgoMs: this.lastLoopAt === null ? null : now - this.lastLoopAt,
      loops: this.loops,
      processed: this.processed,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

/** Parse the optional health port; null when unset. Invalid values fail loudly at startup, not silently later. */
export function healthPortFrom(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error("PRISM_STUDIO_WORKER_HEALTH_PORT must be 1-65535");
  return n;
}

/** Serves GET /healthz → 200 (live) or 503 (stuck) with the report as JSON. Everything else is 404. */
export function startLivenessServer(
  liveness: WorkerLiveness,
  port: number,
  host = "0.0.0.0",
): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    const r = liveness.report();
    res.writeHead(r.live ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(r));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

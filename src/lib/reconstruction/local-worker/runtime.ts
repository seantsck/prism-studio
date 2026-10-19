import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { LocalToolchainState } from "../local-capture";
import type { LocalToolchainProbe } from "../local/toolchain";

/**
 * The same-host local reconstruction worker's PROCESS runtime (Phase 2F M2D.3B): identity, the single-worker lock and
 * the heartbeat. Everything lives in the work root (PRISM_LOCAL_RECONSTRUCTION_ROOT or the per-user default), never in
 * the database: the worker and the Prism server run on the same machine, so a file is enough and needs no migration.
 *
 *   <work root>/.worker.lock             exclusive: ONE worker per work root (one GPU, one queue at a time)
 *   <work root>/.worker-heartbeat.json   rewritten atomically every few seconds; the server reads it to decide
 *                                        whether Local Capture is available (fresh heartbeat AND toolchain ready)
 *
 * Neither file holds a database URL, a credential, an API key, a source-image path or the raw hostname.
 */

export const HEARTBEAT_SCHEMA = "prism.local-reconstruction-worker.v1" as const;
export const LOCK_SCHEMA = "prism.local-reconstruction-worker-lock.v1" as const;
export const WORKER_VERSION = "prism-local-worker/1" as const;
export const HEARTBEAT_FILE = ".worker-heartbeat.json";
export const LOCK_FILE = ".worker.lock";

/** Heartbeat cadence and the age after which a worker is considered offline (3 missed beats). */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_MAX_AGE_MS = 15_000;

/**
 * An opaque identity for the work root, so a heartbeat from a worker serving ANOTHER root is never accepted (two
 * checkouts on one machine, or a copied file). A hash, never the path itself.
 */
export function workRootId(workRoot: string, platform: NodeJS.Platform = process.platform): string {
  const p = path.resolve(workRoot);
  return createHash("sha256")
    .update(platform === "win32" ? p.toLowerCase() : p)
    .digest("hex")
    .slice(0, 16);
}

/** `local-<hash of the hostname>-<random>`: identifies one worker process without revealing the machine name. */
export function newWorkerId(hostname: string = os.hostname()): string {
  const host = createHash("sha256").update(hostname).digest("hex").slice(0, 8);
  return `local-${host}-${randomBytes(4).toString("hex")}`;
}

// ───────────────────────── toolchain readiness (what the heartbeat carries) ─────────────────────────

export const readinessSchema = z.object({
  state: z.enum([
    "ready",
    "colmap_missing",
    "colmap_unverified",
    "colmap_incompatible",
    "brush_missing",
    "brush_incompatible",
    "gpu_unavailable",
  ]),
  colmap: z.object({
    provenance: z.enum(["verified", "unverified", "incompatible", "missing"]),
    version: z.string().max(32).nullable(),
  }),
  brush: z.object({ version: z.string().max(32).nullable(), compatible: z.boolean() }),
  gpu: z.object({ loaderPresent: z.boolean().nullable() }),
  checkedAt: z.string().max(40),
});
export type ToolchainReadiness = z.infer<typeof readinessSchema>;

/**
 * Summarises an M2D.3A toolchain probe. The M2D.3A rules are not weakened: COLMAP must be the VERIFIED Prism external
 * build (official/unverified → not ready), Brush must be a supported version, and a missing Vulkan loader is not
 * ready. `gpuFailed` records that Brush itself found no usable GPU adapter during a run (a fact the probe cannot see).
 */
export function summarizeToolchain(
  probe: LocalToolchainProbe,
  checkedAt: string,
  gpuFailed = false,
): ToolchainReadiness {
  const { colmap, brush, gpu } = probe;
  const state: LocalToolchainState =
    colmap.provenance === "missing"
      ? "colmap_missing"
      : colmap.provenance === "unverified"
        ? "colmap_unverified"
        : colmap.provenance === "incompatible" || !colmap.compatible
          ? "colmap_incompatible"
          : !brush.installed
            ? "brush_missing"
            : !brush.compatible
              ? "brush_incompatible"
              : gpu.loaderPresent === false || gpuFailed
                ? "gpu_unavailable"
                : probe.overall === "ready"
                  ? "ready"
                  : "colmap_incompatible";
  return {
    state,
    colmap: { provenance: colmap.provenance, version: colmap.version },
    brush: { version: brush.version, compatible: brush.compatible },
    gpu: { loaderPresent: gpu.loaderPresent },
    checkedAt,
  };
}

// ───────────────────────── heartbeat ─────────────────────────

export const heartbeatSchema = z
  .object({
    schema: z.literal(HEARTBEAT_SCHEMA),
    workerId: z.string().regex(/^local-[0-9a-f]{8}-[0-9a-f]{8}$/),
    pid: z.number().int().positive(),
    startedAt: z.string().max(40),
    lastHeartbeatAt: z.string().max(40),
    workerVersion: z.string().max(40),
    /** opaque work-root identity (workRootId), never the path */
    workRoot: z.string().regex(/^[0-9a-f]{16}$/),
    toolchain: readinessSchema,
    /** a reconstruction is running now (queued jobs wait) */
    busy: z.boolean(),
  })
  .strict();
export type WorkerHeartbeat = z.infer<typeof heartbeatSchema>;

/** Atomic replace: write a temporary file next to it, then rename over it (readers never see half a file). */
export async function writeHeartbeat(workRoot: string, hb: WorkerHeartbeat): Promise<void> {
  const body = `${JSON.stringify(heartbeatSchema.parse(hb), null, 2)}\n`;
  const target = path.join(workRoot, HEARTBEAT_FILE);
  const tmp = path.join(workRoot, `${HEARTBEAT_FILE}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`);
  await writeFile(tmp, body, { mode: 0o600 });
  try {
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export async function removeHeartbeat(workRoot: string, workerId: string): Promise<void> {
  const target = path.join(workRoot, HEARTBEAT_FILE);
  const current = await readFile(target, "utf8").catch(() => null);
  // never delete a heartbeat another worker wrote
  if (current && parseHeartbeat(current)?.workerId === workerId) await rm(target, { force: true });
}

export function parseHeartbeat(text: string): WorkerHeartbeat | null {
  try {
    const parsed = heartbeatSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type HeartbeatReading =
  | { state: "online"; heartbeat: WorkerHeartbeat }
  /** `last`: a well-formed heartbeat from this root that is too old (its toolchain facts are the last known) */
  | {
      state: "offline";
      reason: "missing" | "malformed" | "other_root" | "stale";
      last: WorkerHeartbeat | null;
    };

/**
 * The server's view of the worker (synchronous: one small file read). Online ONLY when the heartbeat is well-formed,
 * from a worker on THIS work root, and fresh. A clock far in the future counts as stale too.
 */
export function readHeartbeat(
  workRoot: string,
  nowMs: number,
  maxAgeMs: number = HEARTBEAT_MAX_AGE_MS,
): HeartbeatReading {
  let text: string;
  try {
    text = readFileSync(path.join(workRoot, HEARTBEAT_FILE), "utf8");
  } catch {
    return { state: "offline", reason: "missing", last: null };
  }
  if (text.length > 16 * 1024) return { state: "offline", reason: "malformed", last: null };
  const hb = parseHeartbeat(text);
  if (!hb) return { state: "offline", reason: "malformed", last: null };
  if (hb.workRoot !== workRootId(workRoot)) return { state: "offline", reason: "other_root", last: null };
  const age = nowMs - Date.parse(hb.lastHeartbeatAt);
  if (!Number.isFinite(age) || age > maxAgeMs || age < -maxAgeMs)
    return { state: "offline", reason: "stale", last: hb };
  return { state: "online", heartbeat: hb };
}

// ───────────────────────── single-worker lock ─────────────────────────

const lockSchema = z.object({
  schema: z.literal(LOCK_SCHEMA),
  workerId: z.string().max(64),
  pid: z.number().int().positive(),
  startedAt: z.string().max(40),
});
export type WorkerLock = z.infer<typeof lockSchema>;

export class WorkerLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerLockError";
  }
}

/** Whether a process with this pid exists (signal 0 checks without affecting it; EPERM means it exists). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes the work root's exclusive worker lock (created with O_EXCL, so two starting workers cannot both win).
 *   - held by a LIVE process → refused with a clear message; the other worker is never killed
 *   - left by a process that is gone (crash, power loss) → stale: recovered (moved aside, then taken atomically)
 *   - unreadable / malformed → refused (an operator decides; nothing is deleted blindly)
 */
export async function acquireWorkerLock(
  workRoot: string,
  me: { workerId: string; pid: number; startedAt: string },
  alive: (pid: number) => boolean = processAlive,
): Promise<{ release: () => Promise<void>; recoveredStale: WorkerLock | null }> {
  await mkdir(workRoot, { recursive: true });
  const file = path.join(workRoot, LOCK_FILE);
  const body = `${JSON.stringify({ schema: LOCK_SCHEMA, ...me })}\n`;
  let recoveredStale: WorkerLock | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, body, { flag: "wx", mode: 0o600 });
      // the stale lock(s) we moved aside are no longer needed
      for (const n of await readdir(workRoot).catch(() => []))
        if (n.startsWith(`${LOCK_FILE}.stale-`))
          await rm(path.join(workRoot, n), { force: true }).catch(() => undefined);
      return {
        recoveredStale,
        release: async () => {
          const current = await readFile(file, "utf8").catch(() => null);
          // only OUR lock is removed
          if (current && current.includes(`"workerId":"${me.workerId}"`)) await rm(file, { force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const raw = await readFile(file, "utf8").catch(() => null);
    let holder: WorkerLock | null = null;
    try {
      holder = raw ? lockSchema.parse(JSON.parse(raw)) : null;
    } catch {
      holder = null;
    }
    if (!holder)
      throw new WorkerLockError(
        `The worker lock (${LOCK_FILE} in the work root) is unreadable. If no worker is running, delete it and start again.`,
      );
    if (holder.pid !== me.pid && alive(holder.pid))
      throw new WorkerLockError(
        `Another local reconstruction worker (${holder.workerId}, pid ${holder.pid}) is already running on this work root. Only one worker may run per work root.`,
      );
    // stale: move it aside (rename is atomic; a concurrent starter that already did this makes ours fail harmlessly)
    recoveredStale = holder;
    await rename(file, `${file}.stale-${randomBytes(3).toString("hex")}`).catch(() => undefined);
  }
  throw new WorkerLockError("Another local reconstruction worker took the lock at the same time.");
}

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/**
 * The ONE way the local engine starts an external program.
 *
 *   - `shell: false` always, and arguments as an argv ARRAY: no command string is ever built, so no input (file
 *     names, settings) can be interpreted by a shell.
 *   - The executable must be an ABSOLUTE path (resolved by the toolchain probe), never a bare name looked up from
 *     the current directory.
 *   - stdout / stderr are captured up to a byte bound (the tail is kept, plus a line callback for logs).
 *   - Runtime is bounded; an AbortSignal stops it. Termination is graceful first (POSIX: SIGTERM), then forced after a
 *     bounded grace period. On Windows the whole process TREE is killed (`taskkill /T /F`), because a launcher may
 *     have spawned the real worker process.
 */

/**
 * A resolved external tool. In production `prefixArgs` is always empty (the executable IS the tool, resolved to an
 * absolute path by the toolchain probe). Tests point `executable` at the Node binary and put a fake tool script in
 * `prefixArgs`, so fakes still run as real child processes through this same runner.
 */
export interface ToolCommand {
  executable: string;
  prefixArgs: readonly string[];
  /** extra environment for this tool (e.g. its own bin directory on PATH for its DLLs) */
  env?: Record<string, string>;
}

export interface RunProcessOptions {
  /** absolute path of the executable */
  executable: string;
  args: readonly string[];
  /** absolute working directory */
  cwd: string;
  /** extra environment entries (merged over a minimal inherited environment) */
  env?: Record<string, string>;
  /** hard runtime limit */
  timeoutMs: number;
  signal?: AbortSignal;
  /** most bytes kept from each of stdout / stderr (the TAIL is kept) */
  maxOutputBytes?: number;
  /** grace period between a polite stop and a forced kill */
  killGraceMs?: number;
  /** called for each complete output line (bounded length) */
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
}

export interface ProcessResult {
  pid: number | null;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** how the run ended */
  outcome: "exited" | "timeout" | "aborted" | "spawn_failed";
  spawnError: string | null;
  stdout: string;
  stderr: string;
  /** true when output beyond maxOutputBytes was dropped (only the tail was kept) */
  truncated: boolean;
}

const DEFAULT_MAX_OUTPUT = 256 * 1024;
const DEFAULT_GRACE_MS = 5000;
const MAX_LINE = 2000;

/** Bounded tail buffer for one stream. */
class Tail {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  private partial = "";
  constructor(
    private readonly max: number,
    private readonly onLine?: (line: string) => void,
  ) {}
  push(b: Buffer) {
    this.chunks.push(b);
    this.size += b.length;
    while (this.size > this.max && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
      this.truncated = true;
    }
    if (this.size > this.max) {
      const only = this.chunks[0]!;
      this.chunks[0] = only.subarray(only.length - this.max);
      this.size = this.max;
      this.truncated = true;
    }
    if (this.onLine) {
      const text = this.partial + b.toString("utf8");
      const lines = text.split(/\r?\n|\r/);
      this.partial = (lines.pop() ?? "").slice(-MAX_LINE);
      for (const l of lines) if (l.trim()) this.onLine(l.slice(0, MAX_LINE));
    }
  }
  end() {
    if (this.onLine && this.partial.trim()) this.onLine(this.partial);
    this.partial = "";
  }
  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** Kill a child (and on Windows its whole tree). Never throws. */
export function killProcessTree(child: ChildProcess, force: boolean, platform = process.platform) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (platform === "win32") {
      // taskkill from the system directory (absolute path, no shell); /T = the whole tree, /F = forced
      const root = process.env.SystemRoot ?? "C:\\Windows";
      const taskkill = path.join(root, "System32", "taskkill.exe");
      const k = spawn(taskkill, ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      k.on("error", () => child.kill());
    } else {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    }
  } catch {
    // already gone
  }
}

/** Only these environment variables are passed on (plus `env`): no secrets reach an external tool. */
const INHERITED_ENV = [
  "PATH",
  "Path",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "LANG",
  "LC_ALL",
  "XDG_RUNTIME_DIR",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "VK_ICD_FILENAMES",
  "CUDA_VISIBLE_DEVICES",
];

export function minimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of INHERITED_ENV) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

export function runProcess(opts: RunProcessOptions): Promise<ProcessResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const grace = opts.killGraceMs ?? DEFAULT_GRACE_MS;
  const out = new Tail(max, opts.onLine ? (l) => opts.onLine!("stdout", l) : undefined);
  const err = new Tail(max, opts.onLine ? (l) => opts.onLine!("stderr", l) : undefined);

  const base = (over: Partial<ProcessResult>): ProcessResult => ({
    pid: null,
    startedAt,
    durationMs: Date.now() - t0,
    exitCode: null,
    signal: null,
    outcome: "exited",
    spawnError: null,
    stdout: out.text(),
    stderr: err.text(),
    truncated: out.truncated || err.truncated,
    ...over,
  });

  if (!path.isAbsolute(opts.executable) || !path.isAbsolute(opts.cwd))
    return Promise.resolve(
      base({
        outcome: "spawn_failed",
        spawnError: "executable and working directory must be absolute paths",
      }),
    );
  if (opts.signal?.aborted) return Promise.resolve(base({ outcome: "aborted" }));

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(opts.executable, [...opts.args], {
        cwd: opts.cwd,
        env: minimalEnv(opts.env) as NodeJS.ProcessEnv,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve(base({ outcome: "spawn_failed", spawnError: e instanceof Error ? e.message : String(e) }));
      return;
    }
    let ending: "timeout" | "aborted" | null = null;
    let forceTimer: NodeJS.Timeout | null = null;
    let settled = false;
    const stop = (why: "timeout" | "aborted") => {
      if (ending) return;
      ending = why;
      killProcessTree(child, false);
      forceTimer = setTimeout(() => killProcessTree(child, true), grace);
    };
    const timer = setTimeout(() => stop("timeout"), opts.timeoutMs);
    const onAbort = () => stop("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (r: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    child.stdout?.on("data", (b: Buffer) => out.push(b));
    child.stderr?.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) =>
      finish(base({ pid: child.pid ?? null, outcome: "spawn_failed", spawnError: e.message })),
    );
    child.on("close", (code, sig) => {
      out.end();
      err.end();
      finish(
        base({
          pid: child.pid ?? null,
          exitCode: code,
          signal: sig,
          // a stop we requested wins over whatever exit code the killed process reports
          outcome: ending ?? "exited",
        }),
      );
    });
  });
}

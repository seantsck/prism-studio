import { AVAILABLE_QUALITY_PROFILES } from "../../reconstruction/local/engine";
import type { LocalToolchainProbe } from "../../reconstruction/local/toolchain";
import { SUPPORTED_INPUT_MIMES } from "../../reconstruction/local/types";
import { summarizeToolchain } from "../../reconstruction/local-worker/runtime";
import {
  AGENT_VERSION,
  capabilitiesSchema,
  CAPABILITIES_SCHEMA,
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
} from "../protocol";
import type { AgentCapabilities } from "../protocol";
import { AgentRequestError, FATAL_CODES, deviceArch, devicePlatform, type AgentClient } from "./client";
import {
  executeLease,
  resumeJob,
  sweepRuns,
  type ExecutorOptions,
  type JobOutcome,
  type JobToolchain,
} from "./executor";
import { readJobState } from "./job-state";

/**
 * The agent loop: heartbeat (capability report, busy while a job runs), then, when idle with a ready toolchain, ask
 * Prism for a lease and run that ONE job (M2D.3C2) while the heartbeat continues. A job left by a previous run is
 * resolved first (resume a validated upload, or report the interruption); nothing new is leased until it is.
 */

const VERSION_RE = /^[0-9A-Za-z.+_-]{1,32}$/;
const safeVersion = (v: string | null) => (v && VERSION_RE.test(v) ? v : null);

/**
 * The capability report from the M2D.3A toolchain probe: STATES and VERSIONS only. The probe's absolute executable
 * paths, its reasons (which can quote paths) and its commands are never included.
 */
export function capabilitiesFromProbe(
  probe: LocalToolchainProbe,
  checkedAt: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  runtime: { busy?: boolean; remoteJobs?: boolean; gpuFailed?: boolean } = {},
): AgentCapabilities {
  const s = summarizeToolchain(probe, checkedAt, runtime.gpuFailed ?? false);
  const fp = probe.colmap.fingerprint;
  return capabilitiesSchema.parse({
    schema: CAPABILITIES_SCHEMA,
    agentVersion: AGENT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    platform: devicePlatform(platform),
    arch: deviceArch(arch),
    toolchain: {
      state: s.state,
      colmap: {
        provenance: s.colmap.provenance,
        version: safeVersion(s.colmap.version),
        fingerprint:
          s.colmap.provenance === "verified" &&
          fp &&
          /^[0-9a-f]{7,40}$/.test(fp.sourceCommit) &&
          /^[0-9a-f]{64}$/.test(fp.binarySha256)
            ? { sourceCommit: fp.sourceCommit, binarySha256: fp.binarySha256 }
            : null,
      },
      brush: { version: safeVersion(s.brush.version), compatible: s.brush.compatible },
      gpu: { vulkanLoader: s.gpu.loaderPresent },
      checkedAt,
    },
    engine: {
      inputKinds: ["images"],
      inputMimes: Object.keys(SUPPORTED_INPUT_MIMES),
      qualityProfiles: AVAILABLE_QUALITY_PROFILES,
    },
    busy: runtime.busy ?? false,
    ...(runtime.remoteJobs ? { execution: { remoteJobs: true } } : {}),
  });
}

/** The ready toolchain as a job needs it (commands + verified identity), or null when not ready. */
export function jobToolchainFromProbe(probe: LocalToolchainProbe): JobToolchain | null {
  const fp = probe.colmap.fingerprint;
  const c = probe.commands;
  if (
    probe.overall !== "ready" ||
    !c.colmap ||
    !c.brush ||
    !fp ||
    !probe.colmap.version ||
    !probe.brush.version
  )
    return null;
  return {
    run: {
      colmap: c.colmap,
      brush: c.brush,
      versions: { colmap: probe.colmap.version, brush: probe.brush.version },
    },
    tools: {
      colmap: { version: probe.colmap.version, sourceCommit: fp.sourceCommit, binarySha256: fp.binarySha256 },
      brush: { version: probe.brush.version },
    },
  };
}

/** Remote job execution for the run loop (absent: heartbeat only, as in M2D.3C1). */
export interface JobsOption extends Omit<ExecutorOptions, "client" | "toolchain" | "signal" | "log"> {
  /** the current ready toolchain, or null */
  toolchain: () => Promise<JobToolchain | null>;
  /** stop after this many jobs reached an outcome (tests, one-shot runs) */
  maxJobs?: number;
  /** while idle, ask for a lease at most this often */
  leasePollMs?: number;
  /** told when a run found no usable GPU (the next capability report says so until restart) */
  onGpuFailure?: () => void;
}

export interface RunOptions {
  client: AgentClient;
  /** produces the current capability report (the caller decides how often to re-probe); `busy` while a job runs */
  capabilities: (state?: { busy: boolean }) => Promise<AgentCapabilities>;
  /** M2D.3C2: lease and run remote jobs */
  jobs?: JobsOption;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
  log?: (line: string) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type RunOutcome =
  | { kind: "stopped" }
  | { kind: "once"; ok: boolean; code?: string }
  | { kind: "fatal"; code: string; message: string }
  /** --max-jobs reached */
  | { kind: "jobs_done"; outcomes: JobOutcome[] };

const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

export async function runAgent(o: RunOptions): Promise<RunOutcome> {
  const log = o.log ?? (() => undefined);
  const sleep = o.sleep ?? abortableSleep;
  let interval = o.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  let failures = 0;
  // the job runs beside the heartbeat; its own controller lets a shutdown or a fatal answer stop it
  const jobStop = new AbortController();
  const stopJob = () => jobStop.abort();
  o.signal?.addEventListener("abort", stopJob, { once: true });
  let active: Promise<JobOutcome> | null = null;
  const outcomes: JobOutcome[] = [];
  let fatal: { code: string; message: string } | null = null;
  let lastLeaseAt = 0;
  let wake: (() => void) | null = null;
  const jobs = o.jobs;
  if (jobs && !o.once) await sweepRuns(jobs.workRoot).catch(() => 0);

  const exec = (): ExecutorOptions => ({
    ...jobs!,
    client: o.client,
    toolchain: null,
    signal: jobStop.signal,
    log,
  });
  const track = (p: Promise<JobOutcome>) => {
    active = p
      .catch((e: unknown): JobOutcome => {
        log(`job error: ${e instanceof Error ? e.name : "unknown"}`);
        return { kind: "deferred", jobId: "unknown" };
      })
      .then((out) => {
        outcomes.push(out);
        if (out.kind === "fatal") fatal = { code: out.code, message: out.message };
        if (out.kind === "failed" && out.code === "gpu_unavailable") jobs?.onGpuFailure?.();
        active = null;
        wake?.();
        return out;
      });
  };
  const done = () =>
    jobs?.maxJobs !== undefined && outcomes.filter((x) => x.kind !== "deferred").length >= jobs.maxJobs;

  try {
    while (!o.signal?.aborted) {
      let caps: AgentCapabilities | null = null;
      try {
        caps = await o.capabilities({ busy: active !== null });
        const ack = await o.client.heartbeat(caps);
        failures = 0;
        interval = o.intervalMs ?? ack.heartbeatIntervalMs;
        log(
          `heartbeat accepted (counter ${ack.acceptedCounter}, toolchain ${caps.toolchain.state}${active ? ", busy" : ""})`,
        );
        if (o.once) return { kind: "once", ok: true };
      } catch (e) {
        if (!(e instanceof AgentRequestError)) throw e;
        if (FATAL_CODES.has(e.code)) {
          log(`stopping: ${e.code}: ${e.message}`);
          return { kind: "fatal", code: e.code, message: e.message };
        }
        failures++;
        log(`heartbeat failed (${e.code}): ${e.message}`);
        if (o.once) return { kind: "once", ok: false, code: e.code };
      }
      if (fatal) return { kind: "fatal", ...(fatal as { code: string; message: string }) };
      if (done() && !active) return { kind: "jobs_done", outcomes };

      // ── remote jobs: one at a time; a job left over from before is resolved first ──
      if (jobs && !active && !done() && failures === 0) {
        const left = await readJobState(jobs.profileDir).catch((e: unknown) => {
          log(e instanceof Error ? e.message : "unreadable job state");
          return null;
        });
        if (left) track(resumeJob({ ...exec(), toolchain: await jobs.toolchain() }, left));
        else if (
          caps?.toolchain.state === "ready" &&
          Date.now() - lastLeaseAt >= (jobs.leasePollMs ?? interval)
        ) {
          lastLeaseAt = Date.now();
          try {
            const r = await o.client.lease();
            if (r.lease) {
              log(`leased job …${r.lease.jobId.slice(-8)}${r.lease.resumed ? " (resumed)" : ""}`);
              track(executeLease({ ...exec(), toolchain: await jobs.toolchain() }, r.lease, r.serverTime));
            } else if (r.idle !== "no_job") log(`no lease: ${r.idle}`);
          } catch (e) {
            if (!(e instanceof AgentRequestError)) throw e;
            if (FATAL_CODES.has(e.code)) {
              log(`stopping: ${e.code}: ${e.message}`);
              return { kind: "fatal", code: e.code, message: e.message };
            }
            log(`lease request failed (${e.code})`);
          }
        }
      }

      // transient failure (network, clock skew, server error): back off, never re-send a signed request
      const wait = failures === 0 ? interval : Math.min(interval * 2 ** Math.min(failures, 5), 5 * 60_000);
      // a finished job wakes the loop early (so the next lease is not a whole interval away)
      const nap = new AbortController();
      wake = () => nap.abort();
      await sleep(wait, o.signal ? AbortSignal.any([o.signal, nap.signal]) : nap.signal);
      wake = null;
    }
    return { kind: "stopped" };
  } finally {
    o.signal?.removeEventListener("abort", stopJob);
    if (active) {
      // shutdown or a fatal answer: the job stops its tools, reports what it can and cleans up (bounded wait)
      jobStop.abort();
      await Promise.race([active, new Promise((r) => setTimeout(r, 30_000))]);
    }
  }
}

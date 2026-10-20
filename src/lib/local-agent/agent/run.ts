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

/**
 * The M2D.3C1 agent loop: authenticate, heartbeat with a capability report, read the acknowledgement, sleep, repeat.
 * It runs NO jobs, downloads NO Asset and uploads nothing (remote execution is M2D.3C2).
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
): AgentCapabilities {
  const s = summarizeToolchain(probe, checkedAt);
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
    busy: false,
  });
}

export interface RunOptions {
  client: AgentClient;
  /** produces the current capability report (the caller decides how often to re-probe) */
  capabilities: () => Promise<AgentCapabilities>;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
  log?: (line: string) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type RunOutcome =
  | { kind: "stopped" }
  | { kind: "once"; ok: boolean; code?: string }
  | { kind: "fatal"; code: string; message: string };

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
  while (!o.signal?.aborted) {
    try {
      const caps = await o.capabilities();
      const ack = await o.client.heartbeat(caps);
      failures = 0;
      interval = o.intervalMs ?? ack.heartbeatIntervalMs;
      log(`heartbeat accepted (counter ${ack.acceptedCounter}, toolchain ${caps.toolchain.state})`);
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
    // transient failure (network, clock skew, server error): back off, never re-send a signed request
    const wait = failures === 0 ? interval : Math.min(interval * 2 ** Math.min(failures, 5), 5 * 60_000);
    await sleep(wait, o.signal);
  }
  return { kind: "stopped" };
}

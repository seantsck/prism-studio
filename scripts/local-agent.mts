// Prism Studio REMOTE LOCAL AGENT (Phase 2F M2D.3C): runs on a user's own workstation and talks to a hosted (or
// local) Prism server over OUTBOUND HTTPS only. No inbound port, no tunnel, no firewall rule.
//
//   npm run local:agent -- pair --server <origin> --code <pairing code> [--label <name>] [--profile <name>]
//   npm run local:agent -- run [--once] [--max-jobs <n>] [--profile <name>]
//   npm run local:agent -- status [--profile <name>]
//   npm run local:agent -- forget --yes [--profile <name>]
//
// TRUST MODEL: the workstation is an external client. It holds ONLY its own Ed25519 key pair (generated here, never
// sent), its device id and the pinned Prism origin. It needs and reads NO database URL, NO Supabase key, NO Storage
// or worker credential, NO provider key and NO user session; it does not load .env.local (see package.json).
// This is NOT the same-host reconstruction worker (`npm run local:reconstruction-worker`, a trusted server process).
//
// M2D.3C2: `run` also leases this project's Remote Local Agent jobs (one at a time), downloads exactly that job's
// photographs over the signed Prism route, runs the M2D.3A engine (COLMAP → Brush → SPZ) here, and uploads the one
// validated SPZ to Prism, which imports it. The agent never creates Prism Assets and never touches Storage.
// `run --once` is still a single heartbeat (no job).
import path from "node:path";
import { normalizeServerOrigin } from "../src/lib/local-agent/crypto";
import { profileDir, resolveAgentHome } from "../src/lib/local-agent/agent/home";
import { acquireProfileLock, AgentLockError } from "../src/lib/local-agent/agent/lock";
import { AgentClient, AgentRequestError, pairAgent } from "../src/lib/local-agent/agent/client";
import { capabilitiesFromProbe, jobToolchainFromProbe, runAgent } from "../src/lib/local-agent/agent/run";
import { clearJobState, readJobState } from "../src/lib/local-agent/agent/job-state";
import { AgentStateError, FileKeyStore, readConfig, CONFIG_FILE } from "../src/lib/local-agent/agent/store";
import { AgentHomeError } from "../src/lib/local-agent/agent/home";
import { labelSchema, PROTOCOL } from "../src/lib/local-agent/protocol";
import type { ToolCommand } from "../src/lib/reconstruction/local/process";
import { probeLocalToolchain } from "../src/lib/reconstruction/local/toolchain";
import { rm } from "node:fs/promises";

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function usage(code = 2): never {
  console.log(
    [
      "Prism Local Agent (protocol " + PROTOCOL + ")",
      "  pair   --server <origin> --code <code> [--label <name>] [--profile <name>]",
      "  run    [--once] [--max-jobs <n>] [--profile <name>]",
      "  status [--profile <name>]",
      "  forget --yes [--profile <name>]",
    ].join("\n"),
  );
  process.exit(code);
}

const fail = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

if (!command || command === "--help" || command === "help") usage(command ? 0 : 2);

const env = process.env;
let dir: string;
let workRoot: string;
try {
  const home = resolveAgentHome(env);
  const profile = option("profile") ?? "default";
  dir = profileDir(home, profile);
  // run workspaces: per profile, beside (never inside) the profile's key material, outside the repository
  workRoot = path.join(home, "work", profile);
} catch (e) {
  if (e instanceof AgentHomeError) fail(e.message);
  throw e;
}

// TEST-ONLY: report the M2D.3A FAKE tools (Node scripts) instead of colmap.exe/brush_app.exe. Refused unless
// NODE_ENV=test; a real agent never uses it. Nothing is executed beyond each tool's version probe.
const fakeTools = flag("fake-tools");
if (fakeTools && env.NODE_ENV !== "test") fail("--fake-tools is a test seam and requires NODE_ENV=test.", 2);
const FAKES = path.resolve("src/lib/reconstruction/local/__tests__/fakes");
const commandFor = fakeTools
  ? (tool: "colmap" | "brush"): ToolCommand => ({
      executable: process.execPath,
      prefixArgs: [path.join(FAKES, tool === "colmap" ? "fake-colmap.mjs" : "fake-brush.mjs")],
      // the fakes' behaviour (e.g. a Brush run that never ends, for cancellation tests)
      env:
        tool === "colmap"
          ? {
              FAKE_COLMAP_MODE: env.FAKE_COLMAP_MODE ?? "success",
              // lets a test count COLMAP runs (proving a restart never re-runs the engine)
              ...(env.FAKE_COLMAP_RECORD ? { FAKE_COLMAP_RECORD: env.FAKE_COLMAP_RECORD } : {}),
            }
          : { FAKE_BRUSH_MODE: env.FAKE_BRUSH_MODE ?? "success" },
    })
  : undefined;
// TEST-ONLY: simulate a crash at the moment a validated result is about to be uploaded (NODE_ENV=test with
// --fake-tools only): the process exits, leaving the persisted job and the retained SPZ for the next start.
const crashBeforeUpload = env.PRISM_AGENT_TEST_CRASH_BEFORE_UPLOAD === "1";
if (crashBeforeUpload && (env.NODE_ENV !== "test" || !fakeTools))
  fail("PRISM_AGENT_TEST_CRASH_BEFORE_UPLOAD is a test seam (NODE_ENV=test with --fake-tools).", 2);
// TEST-ONLY: a faster idle lease poll (NODE_ENV=test), so end-to-end tests do not wait a full heartbeat interval
const pollMs = option("poll-ms");
if (pollMs !== undefined && env.NODE_ENV !== "test")
  fail("--poll-ms is a test seam and requires NODE_ENV=test.", 2);
const probeEnv =
  fakeTools && env.PRISM_LOCAL_TEST_SYSTEM_ROOT
    ? { ...env, SystemRoot: env.PRISM_LOCAL_TEST_SYSTEM_ROOT }
    : env;

async function main() {
  if (command === "pair") {
    const server = option("server");
    const code = option("code");
    if (!server || !code) usage();
    const label = labelSchema.safeParse(option("label") ?? `Workstation (${process.platform})`);
    if (!label.success) fail("--label must be 1-64 characters with no control characters.");
    const origin = normalizeServerOrigin(server!);
    const config = await pairAgent({ profileDir: dir, server: origin, code: code!, label: label.data! });
    console.log(`Paired.`);
    console.log(`  Device:   ${config.deviceId} (${config.label})`);
    console.log(`  Project:  ${config.projectId}`);
    console.log(`  Server:   ${config.serverOrigin} (pinned; the agent talks to no other origin)`);
    console.log(
      `  Key:      Ed25519, sha256 ${config.publicKeyFingerprint.slice(0, 16)}… (private key kept on this computer)`,
    );
    console.log(`  Profile:  ${dir}`);
    console.log("Start it with: npm run local:agent -- run");
    return;
  }

  if (command === "forget") {
    if (!flag("yes")) fail("forget deletes this profile's device key. Re-run with --yes to confirm.", 2);
    const release = await acquireProfileLock(dir);
    try {
      const config = await readConfig(dir).catch(() => null);
      if (await readJobState(dir).catch(() => null))
        console.log("An unfinished remote job is discarded; Prism fails its attempt when its lease expires.");
      await clearJobState(dir);
      await new FileKeyStore(dir).remove();
      await rm(path.join(dir, CONFIG_FILE), { force: true });
      console.log("Local device key and settings deleted.");
      if (config)
        console.log(`Revoke device ${config.deviceId} in Prism (Local agents) if it is still listed.`);
    } finally {
      await release();
    }
    return;
  }

  if (command === "status") {
    const release = await acquireProfileLock(dir);
    try {
      const config = await readConfig(dir);
      if (!config) fail("This profile is not paired.");
      console.log(`Device:   ${config!.deviceId} (${config!.label})`);
      console.log(`Server:   ${config!.serverOrigin}`);
      console.log(`Key:      sha256 ${config!.publicKeyFingerprint.slice(0, 16)}…`);
      console.log(`Counter:  ${config!.lastCounter}`);
      if (config!.revokedAt) fail(`Revoked:  ${config!.revokedAt} (pair again to create a new device)`);
      const client = await AgentClient.open(dir);
      const s = await client.status();
      console.log(
        `Prism:    paired to project "${s.project.title}" (${s.project.id}); device ${s.device.status}`,
      );
      console.log(`Remote jobs: ${s.remoteExecution.replace("_", " ")} on this Prism server`);
      const job = await readJobState(dir).catch(() => null);
      console.log(
        job
          ? `Active job: …${job.jobId.slice(-8)} (attempt ${job.attempt}, ${job.stage})`
          : "Active job: none",
      );
    } finally {
      await release();
    }
    return;
  }

  if (command === "run") {
    const release = await acquireProfileLock(dir);
    const controller = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const)
      process.on(signal, () => {
        if (controller.signal.aborted) process.exit(130);
        console.log(`${signal}: stopping`);
        controller.abort();
      });
    try {
      const opened = await AgentClient.open(dir);
      const client = crashBeforeUpload
        ? new Proxy(opened, {
            get: (t, k) =>
              k === "uploadResult"
                ? () => {
                    console.log("TEST: simulated crash before upload");
                    process.exit(137);
                  }
                : Reflect.get(t, k, t),
          })
        : opened;
      console.log(`Local agent ${client.device.deviceId} → ${client.device.serverOrigin}`);
      // the toolchain is re-probed at most every 5 minutes; the heartbeat reports the latest facts
      let cached: { at: number; probe: Awaited<ReturnType<typeof probeLocalToolchain>> } | null = null;
      let gpuFailed = false;
      const probe = async () => {
        if (!cached || Date.now() - cached.at > 5 * 60_000)
          cached = { at: Date.now(), probe: await probeLocalToolchain({ env: probeEnv, commandFor }) };
        return cached.probe;
      };
      const maxJobs = option("max-jobs");
      if (maxJobs !== undefined && !/^[1-9][0-9]{0,3}$/.test(maxJobs))
        fail("--max-jobs must be a positive integer.", 2);
      const outcome = await runAgent({
        client,
        capabilities: async (state) =>
          capabilitiesFromProbe(await probe(), new Date().toISOString(), process.platform, process.arch, {
            busy: state?.busy ?? false,
            remoteJobs: true,
            gpuFailed,
          }),
        once: flag("once"),
        jobs: {
          profileDir: dir,
          workRoot,
          toolchain: async () => (gpuFailed ? null : jobToolchainFromProbe(await probe())),
          ...(maxJobs ? { maxJobs: Number(maxJobs) } : {}),
          ...(pollMs ? { leasePollMs: Math.max(200, Number(pollMs)) } : {}),
          onGpuFailure: () => {
            gpuFailed = true;
          },
        },
        ...(pollMs ? { intervalMs: Math.max(200, Number(pollMs)) } : {}),
        signal: controller.signal,
        log: (line) => console.log(`${new Date().toISOString()} ${line}`),
      });
      if (outcome.kind === "fatal") fail(`Agent stopped: ${outcome.message}`, 3);
      if (outcome.kind === "once" && !outcome.ok) fail(`Heartbeat failed (${outcome.code}).`, 1);
      if (outcome.kind === "jobs_done")
        console.log(`Jobs: ${outcome.outcomes.map((x) => x.kind).join(", ")}`);
    } finally {
      await release();
    }
    return;
  }
  usage();
}

try {
  await main();
} catch (e) {
  if (e instanceof AgentRequestError) fail(`${e.code}: ${e.message}`, e.code === "network" ? 1 : 3);
  if (e instanceof AgentStateError || e instanceof AgentLockError || e instanceof AgentHomeError)
    fail(e.message, 2);
  if (e instanceof Error && e.name === "ProtocolFormatError") fail(e.message, 2);
  // never print a stack with local paths or key material: the name only
  fail(`Unexpected error (${e instanceof Error ? e.name : "unknown"}).`, 1);
}

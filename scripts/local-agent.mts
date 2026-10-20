// Prism Studio REMOTE LOCAL AGENT (Phase 2F M2D.3C1): runs on a user's own workstation and talks to a hosted (or
// local) Prism server over OUTBOUND HTTPS only. No inbound port, no tunnel, no firewall rule.
//
//   npm run local:agent -- pair --server <origin> --code <pairing code> [--label <name>] [--profile <name>]
//   npm run local:agent -- run [--once] [--profile <name>]
//   npm run local:agent -- status [--profile <name>]
//   npm run local:agent -- forget --yes [--profile <name>]
//
// TRUST MODEL: the workstation is an external client. It holds ONLY its own Ed25519 key pair (generated here, never
// sent), its device id and the pinned Prism origin. It needs and reads NO database URL, NO Supabase key, NO Storage
// or worker credential, NO provider key and NO user session; it does not load .env.local (see package.json).
// This is NOT the same-host reconstruction worker (`npm run local:reconstruction-worker`, a trusted server process).
//
// M2D.3C1 pairs and heartbeats only: no job, no Asset download, no reconstruction, no upload.
import path from "node:path";
import { normalizeServerOrigin } from "../src/lib/local-agent/crypto";
import { profileDir, resolveAgentHome } from "../src/lib/local-agent/agent/home";
import { acquireProfileLock, AgentLockError } from "../src/lib/local-agent/agent/lock";
import { AgentClient, AgentRequestError, pairAgent } from "../src/lib/local-agent/agent/client";
import { capabilitiesFromProbe, runAgent } from "../src/lib/local-agent/agent/run";
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
      "  run    [--once] [--profile <name>]",
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
try {
  dir = profileDir(resolveAgentHome(env), option("profile") ?? "default");
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
    })
  : undefined;
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
      console.log(`Remote execution: ${s.remoteExecution.replace("_", " ")} (arrives in M2D.3C2)`);
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
      const client = await AgentClient.open(dir);
      console.log(
        `Local agent ${client.device.deviceId} → ${client.device.serverOrigin} (heartbeat only; no jobs in M2D.3C1)`,
      );
      // the toolchain is re-probed at most every 5 minutes; the heartbeat reports the latest facts
      let cached: { at: number; caps: Awaited<ReturnType<typeof capabilitiesFromProbe>> } | null = null;
      const capabilities = async () => {
        if (!cached || Date.now() - cached.at > 5 * 60_000) {
          const probe = await probeLocalToolchain({ env: probeEnv, commandFor });
          cached = { at: Date.now(), caps: capabilitiesFromProbe(probe, new Date().toISOString()) };
        }
        return cached.caps;
      };
      const outcome = await runAgent({
        client,
        capabilities,
        once: flag("once"),
        signal: controller.signal,
        log: (line) => console.log(`${new Date().toISOString()} ${line}`),
      });
      if (outcome.kind === "fatal") fail(`Agent stopped: ${outcome.message}`, 3);
      if (outcome.kind === "once" && !outcome.ok) fail(`Heartbeat failed (${outcome.code}).`, 1);
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

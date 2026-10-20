import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleHeartbeat, handlePair, handleStatus } from "@/server/local-agent/http";
import { createPairingOffer, revokeAgent, type AgentServiceDeps } from "@/server/local-agent/service";
import { MemoryAgentStore } from "@/server/local-agent/store";
import type { LocalToolchainProbe } from "../../../reconstruction/local/toolchain";
import { AgentClient, AgentRequestError, pairAgent } from "../client";
import { defaultAgentHome, profileDir, resolveAgentHome } from "../home";
import { acquireProfileLock, AgentLockError, LOCK_FILE } from "../lock";
import { capabilitiesFromProbe, runAgent } from "../run";
import { CONFIG_FILE, FileKeyStore, KEY_FILE, readConfig, reserveCounter, writeConfig } from "../store";

const OWNER = randomUUID();
const PROJECT = randomUUID();

let tmp: string;
let server: Server;
let origin: string;
let store: MemoryAgentStore;
let deps: AgentServiceDeps;
let requests: string[];
let redirectTo: string | null;

/** A real HTTP server running the production handlers on a memory store (no Next.js, no database). */
async function startServer() {
  store = new MemoryAgentStore({
    ownerOf: () => OWNER,
    projectTitle: () => "Fictional project",
    userId: () => OWNER,
  });
  requests = [];
  redirectTo = null;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    requests.push(`${req.method} ${req.url}`);
    if (redirectTo) {
      res.writeHead(307, { location: redirectTo });
      return res.end();
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`${origin}${req.url}`, { method: req.method, headers, body });
    const handler = req.url!.startsWith("/api/local-agent/v1/pair")
      ? handlePair
      : req.url!.startsWith("/api/local-agent/v1/heartbeat")
        ? handleHeartbeat
        : handleStatus;
    const r = await handler(request, deps);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  origin = `http://127.0.0.1:${addr.port}`;
  deps = { store, canonicalOrigin: origin, now: Date.now };
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "prism-agent-test-"));
  await startServer();
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  await rm(tmp, { recursive: true, force: true });
});

const dirOf = (name = "default") => profileDir(path.join(tmp, "home"), name);

async function pairNew(name = "default") {
  const offer = await createPairingOffer(store, PROJECT);
  const config = await pairAgent({
    profileDir: dirOf(name),
    server: origin,
    code: offer.code,
    label: "Test rig",
  });
  return { offer, config };
}

describe("agent home", () => {
  it("uses a per-user application-data directory, never the repository", () => {
    expect(defaultAgentHome({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32")).toBe(
      path.join("C:\\Users\\u\\AppData\\Local", "PrismStudio", "agent"),
    );
    expect(defaultAgentHome({ HOME: "/home/u" }, "linux")).toBe(
      path.join("/home/u", ".config", "prism-studio", "agent"),
    );
    expect(() => defaultAgentHome({}, "linux")).toThrow();
    expect(() => resolveAgentHome({ PRISM_LOCAL_AGENT_HOME: "relative/dir" })).toThrow();
    expect(() => resolveAgentHome({ PRISM_LOCAL_AGENT_HOME: path.join(process.cwd(), "agent") })).toThrow(
      /outside the Prism repository/,
    );
    expect(() => profileDir(tmp, "../escape")).toThrow();
  });
});

describe("pairing from the workstation", () => {
  it("keeps the private key local, stores no pairing code and no credential, pins the origin", async () => {
    const { offer, config } = await pairNew();
    expect(config).toMatchObject({
      projectId: PROJECT,
      serverOrigin: origin,
      lastCounter: 0,
      revokedAt: null,
    });
    const dir = dirOf();
    expect((await readdir(dir)).sort()).toEqual([CONFIG_FILE, KEY_FILE].sort());
    const configText = await readFile(path.join(dir, CONFIG_FILE), "utf8");
    const keyText = await readFile(path.join(dir, KEY_FILE), "utf8");
    for (const t of [configText, keyText]) {
      expect(t).not.toContain(offer.code);
      expect(t).not.toContain(offer.code.replace(/-/g, ""));
    }
    expect(configText).not.toMatch(/PRIVATE KEY|supabase|postgres|secret|service_role|DB_URL/i);
    expect(keyText).toContain("BEGIN PRIVATE KEY");
    // the server holds only the PUBLIC key
    const [device] = await store.listDevices(PROJECT);
    expect(device.publicKey).not.toContain("PRIVATE");
    expect(keyText).not.toContain(device.publicKey);
    if (process.platform !== "win32") expect((await stat(path.join(dir, KEY_FILE))).mode & 0o077).toBe(0);
  });

  it("refuses a second pairing into a paired profile, and a remote http origin", async () => {
    await pairNew();
    const offer = await createPairingOffer(store, PROJECT);
    await expect(
      pairAgent({ profileDir: dirOf(), server: origin, code: offer.code, label: "x" }),
    ).rejects.toThrow(/already paired/);
    await expect(
      pairAgent({
        profileDir: dirOf("other"),
        server: "http://studio.example.test",
        code: offer.code,
        label: "x",
      }),
    ).rejects.toThrow(/https/);
  });

  it("a failed pairing leaves no key behind", async () => {
    await expect(
      pairAgent({
        profileDir: dirOf(),
        server: origin,
        code: "0000-0000-0000-0000-0000-0000-0000",
        label: "x",
      }),
    ).rejects.toMatchObject({ code: "invalid_pairing" });
    expect(await readdir(dirOf())).toEqual([]);
  });

  it("never follows a redirect (nothing is re-sent to another origin)", async () => {
    const offer = await createPairingOffer(store, PROJECT);
    redirectTo = "https://evil.example.test/api/local-agent/v1/pair";
    await expect(
      pairAgent({ profileDir: dirOf(), server: origin, code: offer.code, label: "x" }),
    ).rejects.toMatchObject({ code: "redirect" });
    expect(requests).toHaveLength(1);
    expect(await store.listDevices(PROJECT)).toEqual([]);
  });
});

describe("signed requests from the workstation", () => {
  it("heartbeats with a durably reserved counter and survives restarts", async () => {
    await pairNew();
    const client = await AgentClient.open(dirOf());
    const caps = capabilitiesFromProbe(missingProbe(), new Date().toISOString());
    expect((await client.heartbeat(caps)).acceptedCounter).toBe(1);
    expect((await client.heartbeat(caps)).acceptedCounter).toBe(2);
    expect((await readConfig(dirOf()))!.lastCounter).toBe(2);
    const restarted = await AgentClient.open(dirOf());
    expect((await restarted.status()).acceptedCounter).toBe(3);
    const [d] = await store.listDevices(PROJECT);
    expect(d.lastCounter).toBe(3);
    expect(d.capabilities?.toolchain.state).toBe("colmap_missing");
  });

  it("a lost response never causes a re-send of the same counter", async () => {
    await pairNew();
    let drop = true;
    const lossy: typeof fetch = async (input, init) => {
      const r = await fetch(input, init);
      if (drop) {
        drop = false;
        throw new TypeError("connection reset");
      }
      return r;
    };
    const client = await AgentClient.open(dirOf(), { fetch: lossy });
    const caps = capabilitiesFromProbe(missingProbe(), new Date().toISOString());
    await expect(client.heartbeat(caps)).rejects.toMatchObject({ code: "network" });
    // the server DID accept counter 1; the agent moves on to 2
    expect((await client.heartbeat(caps)).acceptedCounter).toBe(2);
  });

  it("local counter state rolled back (e.g. a restored backup) stops the agent: re-pair, never trust the server's counter", async () => {
    await pairNew();
    const client = await AgentClient.open(dirOf());
    const caps = capabilitiesFromProbe(missingProbe(), new Date().toISOString());
    await client.heartbeat(caps);
    await client.heartbeat(caps);
    const cfg = (await readConfig(dirOf()))!;
    await writeConfig(dirOf(), { ...cfg, lastCounter: 0 });
    const outcome = await runAgent({
      client: await AgentClient.open(dirOf()),
      capabilities: async () => caps,
      once: true,
    });
    expect(outcome).toMatchObject({ kind: "fatal", code: "counter_replayed" });
  });

  it("stops for good when the device is revoked", async () => {
    await pairNew();
    const client = await AgentClient.open(dirOf());
    const caps = capabilitiesFromProbe(missingProbe(), new Date().toISOString());
    await client.heartbeat(caps);
    const [d] = await store.listDevices(PROJECT);
    await revokeAgent(store, PROJECT, d.id);
    const outcome = await runAgent({ client, capabilities: async () => caps, intervalMs: 1 });
    expect(outcome).toMatchObject({ kind: "fatal", code: "device_revoked" });
    expect((await readConfig(dirOf()))!.revokedAt).not.toBeNull();
    await expect(AgentClient.open(dirOf())).rejects.toThrow(/revoked/);
  });

  it("keeps running through transient failures and stops on abort", async () => {
    await pairNew();
    const client = await AgentClient.open(dirOf());
    const caps = capabilitiesFromProbe(missingProbe(), new Date().toISOString());
    const controller = new AbortController();
    const lines: string[] = [];
    let beats = 0;
    const outcome = await runAgent({
      client,
      capabilities: async () => caps,
      signal: controller.signal,
      log: (l) => lines.push(l),
      sleep: async () => {
        if (++beats === 3) controller.abort();
      },
    });
    expect(outcome).toEqual({ kind: "stopped" });
    expect(lines.filter((l) => l.startsWith("heartbeat accepted"))).toHaveLength(3);
  });

  it("a request error from another origin's answer is surfaced as a stable code", async () => {
    await pairNew();
    const client = await AgentClient.open(dirOf());
    redirectTo = "https://evil.example.test/";
    await expect(client.status()).rejects.toBeInstanceOf(AgentRequestError);
    await expect(client.status()).rejects.toMatchObject({ code: "redirect" });
  });
});

describe("local state files", () => {
  it("the config schema admits no extra field (no credential can be smuggled in)", async () => {
    await pairNew();
    const file = path.join(dirOf(), CONFIG_FILE);
    const cfg = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...cfg, supabaseDbUrl: "postgres://x" }));
    await expect(readConfig(dirOf())).rejects.toThrow(/unreadable/);
    await expect(writeConfig(dirOf(), { ...cfg, extra: 1 })).rejects.toThrow();
  });

  it("reserveCounter is monotonic and durable", async () => {
    await pairNew();
    const a = await reserveCounter(dirOf());
    const b = await reserveCounter(dirOf());
    expect([a.counter, b.counter]).toEqual([1, 2]);
    expect((await readConfig(dirOf()))!.lastCounter).toBe(2);
  });

  it("the key store never overwrites a key", async () => {
    const ks = new FileKeyStore(dirOf("ks"));
    await ks.createPending();
    await expect(ks.createPending()).rejects.toThrow();
    await ks.commitPending();
    await ks.createPending();
    await expect(ks.commitPending()).rejects.toThrow(/already exists/);
    expect((await ks.load()).asymmetricKeyType).toBe("ed25519");
  });

  it("one process per profile: a live holder is never displaced, a dead one is recovered", async () => {
    const dir = dirOf("lock");
    const release = await acquireProfileLock(dir);
    await writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 999999, token: "t" }));
    await expect(acquireProfileLock(dir, () => true)).rejects.toBeInstanceOf(AgentLockError);
    const again = await acquireProfileLock(dir, () => false);
    await again();
    await release();
    await writeFile(path.join(dir, LOCK_FILE), "garbage");
    await expect(acquireProfileLock(dir)).rejects.toThrow(/unreadable/);
  });
});

describe("capability report", () => {
  it("carries states and versions only: no executable path, reason text, hostname or user name", () => {
    const probe = readyProbe();
    const caps = capabilitiesFromProbe(probe, "2026-10-20T00:00:00.000Z", "win32", "x64");
    expect(caps.toolchain).toMatchObject({
      state: "ready",
      colmap: { provenance: "verified", version: "4.2.1", fingerprint: { sourceCommit: "abc1234" } },
      brush: { version: "0.3.0", compatible: true },
      gpu: { vulkanLoader: true },
    });
    const text = JSON.stringify(caps);
    expect(text).not.toContain("C:\\");
    expect(text).not.toContain("Users");
    expect(text).not.toContain(os.hostname());
    expect(text).not.toContain(os.userInfo().username);
    expect(caps.busy).toBe(false);
  });
});

function missingProbe(): LocalToolchainProbe {
  return {
    colmap: {
      installed: false,
      absolutePath: null,
      source: null,
      version: null,
      provenance: "missing",
      compatible: false,
      reason: "COLMAP was not found on PATH (C:\\Users\\someone\\bin).",
      fingerprint: null,
    },
    brush: { installed: false, absolutePath: null, version: null, compatible: false, reason: "not found" },
    gpu: { backend: "vulkan", loaderPresent: true, reason: "x" },
    overall: "incomplete",
    commands: { colmap: null, brush: null },
  };
}

function readyProbe(): LocalToolchainProbe {
  return {
    colmap: {
      installed: true,
      absolutePath: "C:\\Users\\someone\\tools\\colmap\\bin\\colmap.exe",
      source: "configured",
      version: "4.2.1",
      provenance: "verified",
      compatible: true,
      reason: "verified at C:\\Users\\someone\\tools",
      fingerprint: { sourceCommit: "abc1234", binarySha256: "b".repeat(64) },
    },
    brush: {
      installed: true,
      absolutePath: "C:\\Users\\someone\\tools\\brush_app.exe",
      version: "0.3.0",
      compatible: true,
      reason: null,
    },
    gpu: { backend: "vulkan", loaderPresent: true, reason: "C:\\Windows\\System32\\vulkan-1.dll" },
    overall: "ready",
    commands: {
      colmap: { executable: "C:\\Users\\someone\\tools\\colmap\\bin\\colmap.exe", prefixArgs: [] },
      brush: { executable: "C:\\Users\\someone\\tools\\brush_app.exe", prefixArgs: [] },
    },
  };
}

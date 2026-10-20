import { describe, expect, it } from "vitest";
import type { ReconstructionJobRecord } from "@/domain/reconstruction/job";
import { LEASE_TTL_MS, PROTOCOL_VERSION, type AgentCapabilities } from "@/lib/local-agent/protocol";
import { LocalCaptureProvider } from "../local-capture";
import { buildProviders, defaultProviderId, providerSummaries, withRemoteAgents } from "../registry";
import {
  agentCanExecute,
  leaseExpired,
  operationIdForLease,
  RemoteAgentCaptureProvider,
  remoteAgentView,
  remoteLeaseOf,
  staleRemoteJob,
  type AgentDeviceFacts,
  type RemoteAgentView,
} from "../remote-agent-capture";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function caps(
  over: Partial<AgentCapabilities> = {},
  state: AgentCapabilities["toolchain"]["state"] = "ready",
): AgentCapabilities {
  return {
    schema: "prism.local-agent-capabilities.v1",
    agentVersion: "prism-local-agent-0.2.0",
    protocolVersion: PROTOCOL_VERSION,
    platform: "win32",
    arch: "x64",
    toolchain: {
      state,
      colmap: {
        provenance: "verified",
        version: "4.2.1",
        fingerprint: { sourceCommit: "abcdef1", binarySha256: "a".repeat(64) },
      },
      brush: { version: "0.3.0", compatible: true },
      gpu: { vulkanLoader: true },
      checkedAt: ago(0),
    },
    engine: {
      inputKinds: ["images"],
      inputMimes: ["image/jpeg", "image/png"],
      qualityProfiles: ["standard"],
    },
    busy: false,
    execution: { remoteJobs: true },
    ...over,
  };
}
const dev = (o: Partial<AgentDeviceFacts> = {}): AgentDeviceFacts => ({
  status: "active",
  lastSeenAt: ago(5_000),
  capabilities: caps(),
  ...o,
});
const ON = { enabled: true, configured: true };

describe("project-scoped availability", () => {
  it("counts only this project's ACTIVE devices; ready = online + ready toolchain + compatible + runs remote jobs", () => {
    expect(agentCanExecute(dev(), NOW)).toBe(true);
    expect(agentCanExecute(dev({ lastSeenAt: ago(31_000) }), NOW)).toBe(false);
    expect(agentCanExecute(dev({ capabilities: caps({}, "colmap_unverified") }), NOW)).toBe(false);
    expect(agentCanExecute(dev({ capabilities: caps({ protocolVersion: 2 }) }), NOW)).toBe(false);
    expect(agentCanExecute(dev({ capabilities: caps({ execution: undefined }) }), NOW)).toBe(false);
    expect(
      agentCanExecute(
        dev({
          capabilities: caps({
            engine: { inputKinds: ["images"], inputMimes: ["image/jpeg"], qualityProfiles: ["draft"] },
          }),
        }),
        NOW,
      ),
    ).toBe(false);
    expect(agentCanExecute(dev({ status: "revoked" }), NOW)).toBe(false);
    expect(agentCanExecute(dev({ capabilities: null }), NOW)).toBe(false);
  });

  it.each<[string, AgentDeviceFacts[], { enabled: boolean; configured: boolean }, RemoteAgentView["state"]]>([
    ["switched off", [dev()], { enabled: false, configured: false }, "not_enabled"],
    ["no relay storage", [dev()], { enabled: true, configured: false }, "not_configured"],
    ["nothing paired", [], ON, "no_agents"],
    ["only revoked", [dev({ status: "revoked" })], ON, "no_agents"],
    ["paired, offline", [dev({ lastSeenAt: ago(60_000) })], ON, "offline"],
    ["online, toolchain not ready", [dev({ capabilities: caps({}, "gpu_unavailable") })], ON, "toolchain"],
    [
      "online, ready, an M2D.3C1 agent",
      [dev({ capabilities: caps({ execution: undefined }) })],
      ON,
      "outdated",
    ],
    ["one ready", [dev(), dev({ lastSeenAt: ago(60_000) })], ON, "ready"],
  ])("%s → %s", (_name, devices, server, state) => {
    expect(remoteAgentView(devices, NOW, server).state).toBe(state);
  });

  it("busy agents still count as available (new jobs queue behind them)", () => {
    const v = remoteAgentView([dev({ capabilities: caps({ busy: true }) }), dev()], NOW, ON);
    expect(v).toEqual({ state: "ready", active: 2, online: 2, ready: 2, busy: 1 });
    expect(
      new RemoteAgentCaptureProvider({
        view: () => remoteAgentView([dev({ capabilities: caps({ busy: true }) })], NOW, ON),
      }).status().capability,
    ).toBe("available");
  });
});

describe("the local_agent_capture provider", () => {
  it("declares the remote runner, free, photographs only, standard quality; never runs in a web request", async () => {
    const p = new RemoteAgentCaptureProvider();
    expect(p.capabilities()).toMatchObject({
      capability: "local_capture",
      execution: "local",
      runner: "remote_agent",
      cost: "free",
      inputModes: ["multi_image"],
      resultKinds: ["gaussian_splat"],
      minInputs: 3,
      maxInputs: 300,
      inputMimes: ["image/jpeg", "image/png"],
      models: [],
      supportsCancel: true,
      supportsProgress: true,
      supportsResume: true,
      supportsIdempotencyKey: true,
      testOnly: false,
    });
    await expect(p.submit()).rejects.toThrow(/never in a web request/);
    await expect(p.prepareInputs()).rejects.toThrow();
    await expect(p.getOperation()).rejects.toThrow();
    expect(p.estimateCost(null, "multi_image")).toMatchObject({ costClass: "free", usd: { min: 0, max: 0 } });
  });

  it("status says why it cannot be used, in user language; ready → available", () => {
    const s = (v: RemoteAgentView) => new RemoteAgentCaptureProvider({ view: () => v }).status();
    expect(s({ state: "no_agents", active: 0, online: 0, ready: 0, busy: 0 })).toMatchObject({
      label: "Remote Local Agent",
      capability: "unavailable",
      reason: "Pair a workstation first (Project › Local agents).",
    });
    expect(s({ state: "offline", active: 1, online: 0, ready: 0, busy: 0 }).reason).toBe(
      "Paired workstation offline.",
    );
    expect(s({ state: "toolchain", active: 1, online: 1, ready: 0, busy: 0 }).reason).toBe(
      "Toolchain unavailable on the paired workstation.",
    );
    expect(s({ state: "not_enabled", active: 0, online: 0, ready: 0, busy: 0 })).toMatchObject({
      enabled: false,
      configured: false,
    });
    expect(s({ state: "ready", active: 1, online: 1, ready: 1, busy: 0 })).toMatchObject({
      capability: "available",
      reason: null,
      configured: true,
      enabled: true,
      remote: { ready: 1 },
    });
  });
});

describe("registry: free first, project-scoped, no paid default", () => {
  const ready: RemoteAgentView = { state: "ready", active: 1, online: 1, ready: 1, busy: 0 };
  const localReady = { probe: () => ({ installed: true, reason: null }) };
  const paidWorldLabs = {
    PRISM_LOCAL_AGENTS_ENABLED: "1",
    WLT_API_KEY: "fictional-test-key",
    WORLDLABS_RECONSTRUCTION_ENABLED: "1",
    PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
    PRISM_STUDIO_MAX_GENERATION_USD: "100",
  };

  it("lists Remote Local Agent only where remote agents are on, right after Local Capture", () => {
    expect([...buildProviders({}).keys()]).not.toContain("local_agent_capture");
    expect([...buildProviders({ PRISM_LOCAL_AGENTS_ENABLED: "1" }).keys()].slice(0, 3)).toEqual([
      "local_capture",
      "local_agent_capture",
      "worldlabs_marble",
    ]);
  });

  it("default: same-host Local Capture if ready, else a ready paired workstation, else nothing; never World Labs", () => {
    const base = buildProviders(paidWorldLabs, { localToolchain: localReady });
    expect(defaultProviderId(providerSummaries(withRemoteAgents(base, { view: () => ready })))).toBe(
      "local_capture",
    );
    const noLocal = buildProviders(paidWorldLabs);
    expect(defaultProviderId(providerSummaries(withRemoteAgents(noLocal, { view: () => ready })))).toBe(
      "local_agent_capture",
    );
    const none = withRemoteAgents(noLocal, {
      view: () => ({ ...ready, state: "offline", online: 0, ready: 0 }),
    });
    const summaries = providerSummaries(none);
    expect(summaries.find((s) => s.provider === "worldlabs_marble")?.capability).toBe("available");
    expect(defaultProviderId(summaries)).toBeNull();
  });

  it("availability is bound per project request; the shared registry never carries one project's agents", () => {
    const base = buildProviders({ PRISM_LOCAL_AGENTS_ENABLED: "1" });
    const projectA = withRemoteAgents(base, { view: () => ready });
    expect(projectA.get("local_agent_capture")!.status().capability).toBe("available");
    expect(base.get("local_agent_capture")!.status().capability).toBe("unavailable");
    expect(projectA.get("local_capture")).toBe(base.get("local_capture"));
    expect(new LocalCaptureProvider().capabilities().runner).toBe("local_worker");
  });
});

describe("the lease in the job row", () => {
  const leaseId = "0123456789abcdef0123456789abcdef";
  const job = (o: Partial<ReconstructionJobRecord> = {}): ReconstructionJobRecord =>
    ({
      provider: "local_agent_capture",
      status: "running",
      providerOperationId: operationIdForLease(leaseId),
      providerOperation: {
        runner: "remote_agent",
        agentId: "0b5c2f1e-8d3a-4c6b-9e7f-1a2b3c4d5e6f",
        leaseId,
        leaseExpiresAt: new Date(NOW + LEASE_TTL_MS).toISOString(),
        stage: "splat_training",
      },
      ...o,
    }) as ReconstructionJobRecord;

  it("parses only a consistent remote lease", () => {
    expect(remoteLeaseOf(job())).toMatchObject({ leaseId, stage: "splat_training" });
    expect(remoteLeaseOf(job({ provider: "local_capture" }))).toBeNull();
    expect(remoteLeaseOf(job({ providerOperationId: "local:lr-x" }))).toBeNull();
    expect(remoteLeaseOf(job({ providerOperationId: operationIdForLease("f".repeat(32)) }))).toBeNull();
    expect(
      remoteLeaseOf(job({ providerOperation: { ...job().providerOperation!, runner: "local_worker" } })),
    ).toBeNull();
    expect(
      remoteLeaseOf(job({ providerOperation: { ...job().providerOperation!, agentId: "nope" } })),
    ).toBeNull();
  });

  it("is stale only for a local_agent_capture job in flight whose stored lease truly expired", () => {
    expect(staleRemoteJob(job(), NOW)).toBe(false);
    expect(staleRemoteJob(job(), NOW + LEASE_TTL_MS)).toBe(true);
    expect(leaseExpired({ leaseExpiresAt: "garbage" }, NOW)).toBe(true);
    for (const provider of ["local_capture", "worldlabs_marble", "mock", "some_future_provider"])
      expect(staleRemoteJob(job({ provider }), NOW + 10 * LEASE_TTL_MS)).toBe(false);
    for (const status of ["queued", "succeeded", "failed", "cancelled"] as const)
      expect(staleRemoteJob(job({ status }), NOW + 10 * LEASE_TTL_MS)).toBe(false);
  });
});

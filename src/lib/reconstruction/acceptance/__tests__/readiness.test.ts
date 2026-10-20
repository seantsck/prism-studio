import os from "node:os";
import { describe, expect, it } from "vitest";
import type { LocalToolchainProbe } from "../../local/toolchain";
import { parseVulkanSummary, type HardwareFacts } from "../hardware";
import { buildReadiness, formatReadiness } from "../readiness";

const GiB = 1024 ** 3;

// fictional values only; the point is that none of them is ever printed
const SECRETS = {
  relay: "sb_secret_fictional_relay_value_never_printed",
  worker: "sb_secret_fictional_worker_value_never_printed",
  db: "postgresql://fictional:fictional-password@db.example.invalid:5432/postgres",
};

function hardware(o: { discrete?: boolean } = {}): HardwareFacts {
  return {
    os: { platform: "win32", release: "10.0.22631", arch: "x64", caption: "Windows 11 Pro" },
    cpu: { model: "Fictional CPU", logicalCores: 16, physicalCores: 8 },
    memory: { totalBytes: 32 * GiB, freeBytes: 20 * GiB },
    disk: { freeBytes: 500 * GiB, totalBytes: 1000 * GiB },
    gpus: [{ name: "Fictional GPU", driverVersion: "1.0", reportedMemoryBytes: null }],
    vulkan: {
      loaderPresent: true,
      vulkaninfo: "ok",
      ...parseVulkanSummary(
        `Vulkan Instance Version: 1.3.280\nGPU0:\n\tapiVersion = 1.3.277\n\tdeviceType = PHYSICAL_DEVICE_TYPE_${o.discrete === false ? "INTEGRATED" : "DISCRETE"}_GPU\n\tdeviceName = Fictional GPU\n`,
      ),
    },
    notes: [],
  };
}

type ColmapState = "missing" | "unverified" | "incompatible" | "verified";
function toolchain(
  colmap: ColmapState,
  brush: "missing" | "0.3.0" | "0.3.1" | "0.2.0" = "0.3.0",
): LocalToolchainProbe {
  const brushOk = brush === "0.3.0" || brush === "0.3.1";
  const ready = colmap === "verified" && brushOk;
  return {
    colmap: {
      installed: colmap !== "missing",
      absolutePath: colmap === "missing" ? null : "C:\\Tools\\colmap\\bin\\colmap.exe",
      source: colmap === "missing" ? null : "configured",
      version: colmap === "missing" ? null : colmap === "incompatible" ? "3.11.1" : "4.2.1",
      provenance: colmap,
      compatible: colmap === "verified",
      reason:
        colmap === "unverified"
          ? "COLMAP is installed but this build has not been verified for Prism Local Capture."
          : colmap === "incompatible"
            ? "COLMAP 3.11.1 is not supported; Prism Local Capture supports 4.2.1 only."
            : null,
      fingerprint:
        colmap === "verified"
          ? { sourceCommit: "bd1fcf654d2dd8fefa1466999c190a246f83f4b9", binarySha256: "a".repeat(64) }
          : null,
    },
    brush: {
      installed: brush !== "missing",
      absolutePath: brush === "missing" ? null : "C:\\Tools\\brush\\brush_app.exe",
      version: brush === "missing" ? null : brush,
      compatible: brushOk,
      reason: brush === "0.2.0" ? "Brush 0.2.0 is not supported; Prism supports Brush 0.3.x." : null,
    },
    gpu: { backend: "vulkan", loaderPresent: true, reason: "" },
    overall: ready ? "ready" : colmap === "incompatible" || brush === "0.2.0" ? "incompatible" : "incomplete",
    commands: ready
      ? {
          colmap: { executable: "C:\\Tools\\colmap\\bin\\colmap.exe", prefixArgs: [] },
          brush: { executable: "C:\\Tools\\brush\\brush_app.exe", prefixArgs: [] },
        }
      : { colmap: null, brush: null },
  };
}

const hostedEnv = (extra: Record<string, string | undefined> = {}) => ({
  PRISM_LOCAL_AGENTS_ENABLED: "1",
  PRISM_RECONSTRUCTION_JOBS_ENABLED: "1",
  PRISM_STUDIO_PERSISTENCE: "supabase",
  NEXT_PUBLIC_SITE_URL: "https://studio.example.invalid",
  PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY: SECRETS.worker,
  SUPABASE_DB_URL: SECRETS.db,
  ...extra,
});

const report = (env: Record<string, string | undefined>, tc = toolchain("verified"), hw = hardware()) =>
  buildReadiness({
    env,
    hardware: hw,
    toolchain: tc,
    agent: { profile: "default", config: null, problem: null },
  });

describe("readiness: toolchain states", () => {
  it.each([
    ["missing", "missing", /No COLMAP found/],
    ["unverified", "unverified", /has not been verified for Prism/],
    ["incompatible", "incompatible", /3\.11\.1 is not supported/],
  ] as const)("COLMAP %s → Gate B not passed", (state, shown, reason) => {
    const r = report(hostedEnv(), toolchain(state));
    expect(r.toolchain.colmap).toBe(shown);
    expect(r.gates.B).toBe("NOT_PASSED");
    expect(r.gateReasons.B.join(" ")).toMatch(reason);
    expect(r.readyForRealAcceptance).toBe(false);
  });

  it("verified COLMAP 4.2.1 + Brush 0.3.0 + a Vulkan GPU + probe READY → Gate B PASS; with practical hardware, READY", () => {
    const r = report(hostedEnv());
    expect(r.toolchain).toMatchObject({
      colmap: "verified",
      brush: "ready",
      vulkan: "available",
      overall: "ready",
    });
    expect(r.gates.B).toBe("PASS");
    expect(r.readyForRealAcceptance).toBe(true);
    // Gate C is never passed by a report, and Gate A never from inside the application
    expect(r.gates).toMatchObject({ A: "NOT_PASSED", C: "NOT_RUN" });
  });

  it("Brush missing / wrong version / an accepted 0.3.x that is not the pinned 0.3.0", () => {
    expect(report(hostedEnv(), toolchain("verified", "missing")).gateReasons.B.join(" ")).toMatch(
      /Brush 0\.3\.0 is not installed/,
    );
    const wrong = report(hostedEnv(), toolchain("verified", "0.2.0"));
    expect(wrong.toolchain.brush).toBe("incompatible");
    expect(wrong.gateReasons.B.join(" ")).toMatch(/0\.2\.0 is not supported/);
    const patch = report(hostedEnv(), toolchain("verified", "0.3.1"));
    expect(patch.gates.B).toBe("NOT_PASSED");
    expect(patch.gateReasons.B.join(" ")).toMatch(/pinned to 0\.3\.0/);
  });

  it("hardware that is not practical blocks real acceptance even with a perfect toolchain", () => {
    const r = report(hostedEnv(), toolchain("verified"), hardware({ discrete: false }));
    expect(r.gates.B).toBe("PASS");
    expect(r.assessment.decision).toBe("NOT_READY_FOR_REAL_RUN");
    expect(r.readyForRealAcceptance).toBe(false);
  });
});

describe("readiness: hosted security (no secret value, ever)", () => {
  it("relay key: configured / missing / invalid; no fallback to the worker key", () => {
    expect(
      report(hostedEnv({ PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY: SECRETS.relay })).hosted,
    ).toMatchObject({
      relayKey: "configured",
      remoteExecutionAvailable: true,
    });
    // the worker key is present but is NOT a relay key
    const missing = report(hostedEnv());
    expect(missing.hosted).toMatchObject({ relayKey: "missing", remoteExecutionAvailable: false });
    expect(missing.gateReasons.A.join(" ")).toMatch(/dedicated agent-relay Storage key is not configured/);
    expect(
      report(hostedEnv({ PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY: "sb_publishable_fictional" })).hosted
        .relayKey,
    ).toBe("invalid");
    // remote execution also needs the agents flag
    expect(
      report(
        hostedEnv({
          PRISM_LOCAL_AGENTS_ENABLED: "0",
          PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY: SECRETS.relay,
        }),
      ).hosted.remoteExecutionAvailable,
    ).toBe(false);
  });

  it("neither the text nor the JSON report contains a secret value, a user or host name, or (by default) a path", () => {
    const r = report(hostedEnv({ PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY: SECRETS.relay }));
    for (const text of [formatReadiness(r), JSON.stringify(r)]) {
      for (const s of Object.values(SECRETS)) expect(text).not.toContain(s);
      expect(text).not.toContain("fictional-password");
      expect(text).not.toContain(os.hostname());
      expect(text).not.toContain(os.userInfo().username);
      expect(text).not.toContain("C:\\Tools");
    }
    // tool locations only on request
    const diag = formatReadiness(r, {
      diagnostic: true,
      toolPaths: { colmap: "C:\\Tools\\colmap\\bin\\colmap.exe", brush: null },
    });
    expect(diag).toContain("C:\\Tools\\colmap\\bin\\colmap.exe");
    for (const s of Object.values(SECRETS)) expect(diag).not.toContain(s);
  });

  it("Gate A explains what the application cannot see (edge rate limit, access-log redaction) and never claims a PASS", () => {
    const r = report(hostedEnv({ PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY: SECRETS.relay }));
    expect(r.gates.A).toBe("NOT_PASSED");
    expect(r.hosted.edgeRateLimit).toBe("not_detectable");
    expect(r.gateReasons.A.join(" ")).toMatch(/operator must confirm it/);
    expect(r.gateReasons.A.join(" ")).toMatch(/lease ids/);
    expect(report({ NEXT_PUBLIC_SITE_URL: "http://localhost:3100" }).hosted).toMatchObject({
      httpsOrigin: false,
      persistence: "memory",
    });
    // a site URL with credentials is not echoed
    expect(
      report({ NEXT_PUBLIC_SITE_URL: "https://user:pw@studio.example.invalid" }).hosted.siteOrigin,
    ).toBeNull();
  });

  it("the Local Agent section reports the paired origin and protocol, never the key or the device label", () => {
    const r = buildReadiness({
      env: {},
      hardware: hardware(),
      toolchain: toolchain("verified"),
      agent: {
        profile: "rig",
        problem: null,
        config: {
          schema: "prism.local-agent-config.v1",
          protocolVersion: 1,
          deviceId: "00000000-0000-4000-8000-000000000001",
          projectId: "00000000-0000-4000-8000-000000000002",
          serverOrigin: "https://studio.example.invalid",
          label: "Fictional rig label",
          publicKeyFingerprint: "b".repeat(64),
          privateKeyFile: "device-key.pem",
          lastCounter: 7,
          pairedAt: "2026-10-20T00:00:00.000Z",
          revokedAt: null,
        },
      },
    });
    expect(r.agent).toEqual({
      profile: "rig",
      paired: true,
      revoked: false,
      serverOrigin: "https://studio.example.invalid",
      protocolVersion: 1,
      problem: null,
    });
    expect(formatReadiness(r)).not.toMatch(/device-key|Fictional rig label|b{64}/);
  });
});

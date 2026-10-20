import { relayKeyStatus } from "@/server/local-agent/relay-key";
import type { AgentConfig } from "@/lib/local-agent/agent/store";
import { PROTOCOL_VERSION } from "@/lib/local-agent/protocol";
import { APPROVED_COLMAP } from "../local/colmap-provenance";
import type { LocalToolchainProbe } from "../local/toolchain";
import type { HardwareFacts } from "./hardware";
import { assessHardware, fmtGiB, type HardwareAssessment } from "./policy";

/**
 * The operator's production-readiness report for real reconstruction (Phase 2F M2D.3D1).
 *
 * Three SEPARATE gates; Local Capture is not production-ready until all three pass:
 *   A  HOSTED SECURITY   dedicated relay key, ingress rate limiting, lease ids out of infrastructure logs
 *   B  REAL TOOLCHAIN    a Prism-verified COLMAP 4.2.1 build, Brush 0.3.0, a usable Vulkan GPU, probe READY
 *   C  REAL RECONSTRUCTION  real photographs → real COLMAP/Brush → real SPZ, imported, rendered, judged by a human
 *
 * Privacy: the report carries states, versions, counts and sizes. Never a secret value, a user or host name, a device
 * key or (unless `diagnostic` is asked for) a local path.
 */

export const READINESS_SCHEMA = "prism.reconstruction-readiness.v1" as const;
export const SUPPORTED_BRUSH_VERSION = "0.3.0";

export type GateState = "PASS" | "NOT_PASSED" | "NOT_RUN";

export interface ReadinessInput {
  env: Record<string, string | undefined>;
  hardware: HardwareFacts;
  toolchain: LocalToolchainProbe;
  agent: { profile: string; config: AgentConfig | null; problem: string | null };
}

export interface ReadinessReport {
  schema: typeof READINESS_SCHEMA;
  hosted: {
    localAgentsEnabled: boolean;
    relayKey: "configured" | "missing" | "invalid";
    persistence: "memory" | "supabase";
    siteOrigin: string | null;
    httpsOrigin: boolean | null;
    /** an application cannot observe its own edge; the operator attests it (Gate A) */
    edgeRateLimit: "not_detectable";
    remoteExecutionAvailable: boolean;
  };
  agent: {
    profile: string;
    paired: boolean;
    revoked: boolean;
    serverOrigin: string | null;
    protocolVersion: number | null;
    problem: string | null;
  };
  toolchain: {
    colmap: "missing" | "unverified" | "incompatible" | "verified";
    colmapVersion: string | null;
    brush: "missing" | "incompatible" | "ready";
    brushVersion: string | null;
    vulkan: "available" | "unavailable";
    overall: LocalToolchainProbe["overall"];
  };
  hardware: HardwareFacts;
  assessment: HardwareAssessment;
  gates: { A: GateState; B: GateState; C: GateState };
  gateReasons: { A: string[]; B: string[]; C: string[] };
  readyForRealAcceptance: boolean;
  reasons: string[];
}

function originFacts(env: Record<string, string | undefined>): {
  origin: string | null;
  https: boolean | null;
} {
  const raw = env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return { origin: null, https: null };
  try {
    const u = new URL(raw);
    if (u.username || u.password) return { origin: null, https: null };
    return { origin: u.origin, https: u.protocol === "https:" };
  } catch {
    return { origin: null, https: null };
  }
}

export function buildReadiness(i: ReadinessInput): ReadinessReport {
  const env = i.env;
  const enabled = env.PRISM_LOCAL_AGENTS_ENABLED === "1";
  const relay = relayKeyStatus(env);
  const persistence = env.PRISM_STUDIO_PERSISTENCE === "supabase" ? "supabase" : "memory";
  const { origin, https } = originFacts(env);
  const jobsOn = ["1", "true"].includes((env.PRISM_RECONSTRUCTION_JOBS_ENABLED ?? "").trim().toLowerCase());
  const remoteExecutionAvailable = enabled && jobsOn && (persistence === "memory" || relay === "configured");

  // ── Gate A: hosted security ──
  const a: string[] = [];
  if (!enabled) a.push("PRISM_LOCAL_AGENTS_ENABLED is not 1 on this server.");
  if (persistence !== "supabase") a.push("This is not a hosted (Supabase) configuration.");
  if (relay === "missing") a.push("The dedicated agent-relay Storage key is not configured.");
  if (relay === "invalid") a.push("The agent-relay variable is set but is not a server secret key.");
  if (https !== true) a.push("NEXT_PUBLIC_SITE_URL is not an https origin.");
  a.push(
    "Edge rate limiting on /api/local-agent/v1/* cannot be detected by the application: the operator must confirm it (docs/reconstruction-acceptance.md).",
  );
  a.push(
    "Infrastructure access logs must not keep job route paths with lease ids: the operator must confirm the platform's log redaction.",
  );

  // ── Gate B: real toolchain ──
  const colmap = i.toolchain.colmap.installed ? i.toolchain.colmap.provenance : "missing";
  const colmapState = (colmap === "missing" ? "missing" : colmap) as ReadinessReport["toolchain"]["colmap"];
  const brushState: ReadinessReport["toolchain"]["brush"] = !i.toolchain.brush.installed
    ? "missing"
    : i.toolchain.brush.compatible
      ? "ready"
      : "incompatible";
  const assessment = assessHardware(i.hardware);
  const vulkanAvailable = assessment.usableVulkanDevices.length > 0;
  const b: string[] = [];
  if (colmapState !== "verified")
    b.push(
      colmapState === "missing"
        ? `No COLMAP found; Prism needs an operator-built COLMAP ${APPROVED_COLMAP.version} verified with npm run local:verify-colmap.`
        : `COLMAP is ${colmapState}: ${i.toolchain.colmap.reason ?? "not a Prism-verified build"}`,
    );
  if (brushState === "missing")
    b.push(`Brush ${SUPPORTED_BRUSH_VERSION} is not installed (PRISM_BRUSH_PATH).`);
  else if (brushState === "incompatible")
    b.push(i.toolchain.brush.reason ?? "Brush is not a supported version.");
  else if (i.toolchain.brush.version !== SUPPORTED_BRUSH_VERSION)
    b.push(
      `Brush ${i.toolchain.brush.version} is accepted by the run-time probe, but real acceptance is pinned to ${SUPPORTED_BRUSH_VERSION}.`,
    );
  if (!vulkanAvailable) b.push("No usable Vulkan GPU device was enumerated.");
  if (i.toolchain.overall !== "ready")
    b.push(`The toolchain probe is ${i.toolchain.overall.toUpperCase()}, not READY.`);

  // ── Gate C: never passed by a report (a real reconstruction and a human verdict decide) ──
  const c = ["No real reconstruction has been accepted (REAL_ROOM + human review)."];

  const reasons: string[] = [];
  if (assessment.decision !== "READY_FOR_REAL_RUN")
    reasons.push(
      `Hardware is ${assessment.tier}: ${assessment.reasons.join(" ") || "not practical for a room run."}`,
    );
  reasons.push(...b);

  return {
    schema: READINESS_SCHEMA,
    hosted: {
      localAgentsEnabled: enabled,
      relayKey: relay,
      persistence,
      siteOrigin: origin,
      httpsOrigin: https,
      edgeRateLimit: "not_detectable",
      remoteExecutionAvailable,
    },
    agent: {
      profile: i.agent.profile,
      paired: !!i.agent.config,
      revoked: !!i.agent.config?.revokedAt,
      serverOrigin: i.agent.config?.serverOrigin ?? null,
      protocolVersion: i.agent.config ? PROTOCOL_VERSION : null,
      problem: i.agent.problem,
    },
    toolchain: {
      colmap: colmapState,
      colmapVersion: i.toolchain.colmap.version,
      brush: brushState,
      brushVersion: i.toolchain.brush.version,
      vulkan: vulkanAvailable ? "available" : "unavailable",
      overall: i.toolchain.overall,
    },
    hardware: i.hardware,
    assessment,
    // A cannot be PASSED from inside the application (edge + log redaction are infrastructure facts)
    gates: { A: "NOT_PASSED", B: b.length ? "NOT_PASSED" : "PASS", C: "NOT_RUN" },
    gateReasons: { A: a, B: b, C: c },
    readyForRealAcceptance: reasons.length === 0,
    reasons,
  };
}

/** Human-readable report. Paths appear only with `diagnostic` (tool locations), never secrets or identities. */
export function formatReadiness(
  r: ReadinessReport,
  o: { diagnostic?: boolean; toolPaths?: { colmap: string | null; brush: string | null } } = {},
): string {
  const h = r.hardware;
  const yes = (b: boolean) => (b ? "YES" : "NO");
  const lines = [
    "PRISM RECONSTRUCTION READINESS (local, read-only; no network call, no secret value shown)",
    "",
    "HOSTED (this environment's server configuration)",
    `  PRISM_LOCAL_AGENTS_ENABLED   ${r.hosted.localAgentsEnabled ? "1" : "not set"}`,
    `  relay key                    ${r.hosted.relayKey}`,
    `  persistence                  ${r.hosted.persistence}`,
    `  site origin                  ${r.hosted.siteOrigin ?? "not set"}`,
    `  HTTPS origin                 ${r.hosted.httpsOrigin === null ? "unknown" : yes(r.hosted.httpsOrigin)}`,
    `  edge rate limit              not detectable from the application (operator must confirm)`,
    `  remote execution available   ${yes(r.hosted.remoteExecutionAvailable)}`,
    "",
    `LOCAL AGENT (profile "${r.agent.profile}")`,
    `  paired config                ${r.agent.paired ? (r.agent.revoked ? "present (REVOKED)" : "present") : "none"}`,
    `  server origin                ${r.agent.serverOrigin ?? "-"}`,
    `  protocol version             ${r.agent.protocolVersion ?? "-"}`,
    ...(r.agent.problem ? [`  note                         ${r.agent.problem}`] : []),
    "",
    "TOOLCHAIN",
    `  COLMAP                       ${r.toolchain.colmap}${r.toolchain.colmapVersion ? ` (${r.toolchain.colmapVersion})` : ""}`,
    `  Brush                        ${r.toolchain.brush}${r.toolchain.brushVersion ? ` (${r.toolchain.brushVersion})` : ""}`,
    `  Vulkan                       ${r.toolchain.vulkan}`,
    `  probe                        ${r.toolchain.overall.toUpperCase()}`,
    ...(o.diagnostic && o.toolPaths
      ? [
          `  COLMAP path (diagnostic)     ${o.toolPaths.colmap ?? "-"}`,
          `  Brush path (diagnostic)      ${o.toolPaths.brush ?? "-"}`,
        ]
      : []),
    "",
    "HARDWARE",
    `  OS                           ${h.os.caption ?? h.os.platform} (${h.os.release}, ${h.os.arch})`,
    `  CPU                          ${h.cpu.model ?? "unknown"} · ${h.cpu.physicalCores ?? "?"} cores / ${h.cpu.logicalCores} logical`,
    `  RAM                          ${fmtGiB(h.memory.totalBytes)} total · ${fmtGiB(h.memory.freeBytes)} free`,
    `  free disk (workspace volume) ${h.disk.freeBytes === null ? "unknown" : fmtGiB(h.disk.freeBytes)}`,
    ...h.gpus.map(
      (g) =>
        `  GPU adapter                  ${g.name}${g.driverVersion ? ` (driver ${g.driverVersion})` : ""}`,
    ),
    `  Vulkan                       ${h.vulkan.vulkaninfo === "ok" ? `instance ${h.vulkan.instanceVersion ?? "?"}` : `vulkaninfo ${h.vulkan.vulkaninfo}`}${h.vulkan.loaderPresent ? ", loader present" : ""}`,
    ...h.vulkan.devices.map(
      (d) =>
        `    device                     ${d.name} · ${d.type} · Vulkan ${d.apiVersion ?? "?"}${d.driverInfo ? ` · ${d.driverInfo}` : ""}`,
    ),
    ...h.notes.map((n) => `  note                         ${n}`),
    `  tier                         ${r.assessment.tier}`,
    `  decision                     ${r.assessment.decision}`,
    ...r.assessment.reasons.map((x) => `    - ${x}`),
    "",
    "GATES",
    `  A HOSTED SECURITY            ${r.gates.A}`,
    ...r.gateReasons.A.map((x) => `    - ${x}`),
    `  B REAL TOOLCHAIN             ${r.gates.B}`,
    ...r.gateReasons.B.map((x) => `    - ${x}`),
    `  C REAL RECONSTRUCTION        ${r.gates.C}`,
    ...r.gateReasons.C.map((x) => `    - ${x}`),
    "",
    `READY FOR REAL ACCEPTANCE: ${r.readyForRealAcceptance ? "YES" : "NO"}`,
    ...r.reasons.map((x) => `  - ${x}`),
  ];
  return lines.join("\n");
}

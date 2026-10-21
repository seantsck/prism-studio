import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ACCEPTANCE_SMOKE_BRUSH, BRUSH_PROFILES } from "../local/brush";
import { DEFAULT_ENGINE_LIMITS, runLocalReconstruction, type LocalEngineLimits } from "../local/engine";
import type { LocalToolchainProbe } from "../local/toolchain";
import {
  LOCAL_RUN_SCHEMA,
  LocalReconstructionError,
  type LocalReconstructionInput,
  type LocalReconstructionResult,
} from "../local/types";
import { directoryBytes } from "../local/workspace";
import type { HardwareFacts } from "./hardware";
import { humanReviewTemplate } from "./human";
import { AcceptanceInputError } from "./photos";
import { fmtGiB, HARDWARE_POLICY, roomDiskRequirement, type HardwareAssessment } from "./policy";
import {
  ACCEPTANCE_REPORT_SCHEMA,
  acceptanceReportSchema,
  dimensionSummary,
  machineVerdict,
  type AcceptanceMode,
  type AcceptanceReport,
  type TimedStage,
} from "./report";

/**
 * Runs ONE real acceptance (REAL_SMOKE or REAL_ROOM) through the real M2D.3A engine and leaves behind, in the
 * operator's output directory:
 *
 *   splat.ply, splat.spz        the result (success only)
 *   run-manifest.json, run.log  the engine's own manifest and bounded log (success AND failure)
 *   acceptance-report.json      prism.reconstruction-acceptance.v1
 *   human-review.json           the checklist to fill in (REAL_ROOM)
 *   work/                       only with keepIntermediates after a failure (COLMAP/Brush intermediates for debugging)
 *
 * Nothing is uploaded and no network call is made; the engine copies each photograph into its own workspace, so the
 * originals are never written. Automated tests drive this with the fake tools; the CLI refuses REAL modes without an
 * explicit --real.
 */

export interface AcceptanceInput {
  ordinal: number;
  source: LocalReconstructionInput["source"];
  mime: "image/jpeg" | "image/png";
  sha256: string;
  byteSize: number;
  width: number | null;
  height: number | null;
}

export interface AcceptanceRunOptions {
  /** FAKE: automated tests with fake tools; REAL modes only from the operator CLI */
  mode: AcceptanceMode;
  /** default: acceptance_smoke for REAL_SMOKE, standard otherwise */
  brushProfile?: "standard" | "acceptance_smoke";
  datasetKind: "synthetic" | "photos";
  inputs: AcceptanceInput[];
  outputDir: string;
  toolchain: LocalToolchainProbe;
  hardware: HardwareFacts;
  assessment: HardwareAssessment;
  keepIntermediates?: boolean;
  limits?: LocalEngineLimits;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** test seams */
  engine?: typeof runLocalReconstruction;
  freeDiskBytes?: (dir: string) => Promise<number | null>;
  now?: () => number;
}

export interface AcceptanceRunResult {
  report: AcceptanceReport;
  reportPath: string;
  spzPath: string | null;
}

async function volumeFree(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export function newAcceptanceRunId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `acc-${stamp}-${randomBytes(3).toString("hex")}`;
}

const STAGE_FOR = {
  preparing: "input_preparation",
  splat_training: "brush_training",
  validating_ply: "ply_validation",
  converting_spz: "spz_conversion",
  validating_spz: "spz_validation",
} as const;
const STEP_FOR = {
  feature_extraction: "colmap_feature_extraction",
  matching: "colmap_matching",
  mapping: "colmap_mapping",
  undistortion: "colmap_undistortion",
} as const;

export async function runAcceptance(o: AcceptanceRunOptions): Promise<AcceptanceRunResult> {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => undefined);
  if (o.toolchain.overall !== "ready" || !o.toolchain.commands.colmap || !o.toolchain.commands.brush)
    throw new AcceptanceInputError(
      "The local toolchain is not READY (a verified COLMAP build, a supported Brush and a Vulkan loader are required).",
    );
  if (!path.isAbsolute(o.outputDir)) throw new AcceptanceInputError("The output directory must be absolute.");
  await mkdir(o.outputDir, { recursive: true });

  // ── disk guard BEFORE anything runs (conservative Prism policy; never fill the operator's drive) ──
  const inputBytes = o.inputs.reduce((n, i) => n + i.byteSize, 0);
  const need = o.mode === "REAL_SMOKE" ? HARDWARE_POLICY.smokeDiskBytes : roomDiskRequirement(inputBytes);
  const free = await (o.freeDiskBytes ?? volumeFree)(o.outputDir);
  if (free === null)
    throw new AcceptanceInputError(
      "Free disk space on the output volume could not be read; refusing to start.",
    );
  if (free < need)
    throw new AcceptanceInputError(
      `Not enough free disk on the output volume: ${fmtGiB(free)} free, about ${fmtGiB(need)} needed (a conservative Prism estimate: COLMAP and Brush intermediates are many times the photographs' size). Nothing was started.`,
    );

  const runId = newAcceptanceRunId(new Date(now()));
  const workRoot = path.join(o.outputDir, "work");
  await mkdir(workRoot, { recursive: true });
  const smoke =
    (o.brushProfile ?? (o.mode === "REAL_SMOKE" ? "acceptance_smoke" : "standard")) === "acceptance_smoke";

  // ── timings, from stage/step transitions ──
  const timings: Partial<Record<TimedStage, number>> = {};
  let current: TimedStage | null = null;
  let since = now();
  const enter = (s: TimedStage | null) => {
    const t = now();
    if (current) timings[current] = (timings[current] ?? 0) + (t - since);
    current = s;
    since = t;
  };
  // ── resource sampling: system free memory every second, workspace size at stage boundaries ──
  let minFree: number | null = null;
  let maxWorkspace: number | null = null;
  const sampleMemory = () => {
    const f = os.freemem();
    minFree = minFree === null ? f : Math.min(minFree, f);
  };
  sampleMemory();
  const sampler = setInterval(sampleMemory, 1000);
  sampler.unref?.();
  const runDir = path.join(workRoot, runId);
  const sampleWorkspace = async () => {
    const b = await directoryBytes(runDir).catch(() => null);
    if (b !== null) maxWorkspace = Math.max(maxWorkspace ?? 0, b);
  };

  const started = now();
  let result: LocalReconstructionResult | null = null;
  let error: LocalReconstructionError | null = null;
  const pending: Promise<void>[] = [];
  try {
    result = await (o.engine ?? runLocalReconstruction)(
      {
        runId,
        quality: "standard",
        inputs: o.inputs.map((i) => ({
          ordinal: i.ordinal,
          source: i.source,
          checksum: i.sha256,
          mime: i.mime,
        })),
      },
      {
        toolchain: {
          colmap: o.toolchain.commands.colmap,
          brush: o.toolchain.commands.brush,
          versions: {
            colmap: o.toolchain.colmap.version ?? "unknown",
            brush: o.toolchain.brush.version ?? "unknown",
          },
        },
        workRoot,
        limits: o.limits ?? DEFAULT_ENGINE_LIMITS,
        signal: o.signal,
        smokeTraining: smoke,
        keepIntermediatesOnFailure: !!o.keepIntermediates,
        onProgress: (p) => {
          // COLMAP's own steps time the camera stage (onToolStep); training reports progress often: only a
          // CHANGE of stage closes the previous timing and samples the workspace
          const s = p.stage in STAGE_FOR ? STAGE_FOR[p.stage as keyof typeof STAGE_FOR] : null;
          if (p.stage === "camera_reconstruction" || p.stage === "complete") {
            if (current !== null && !current.startsWith("colmap_")) {
              enter(null);
              pending.push(sampleWorkspace());
            }
          } else if (s && s !== current) {
            enter(s);
            log(`stage ${p.stage}`);
            pending.push(sampleWorkspace());
          }
        },
        onToolStep: (step) => {
          enter(STEP_FOR[step]);
          log(`COLMAP ${step.replace("_", " ")}`);
          pending.push(sampleWorkspace());
        },
      },
    );
  } catch (e) {
    error =
      e instanceof LocalReconstructionError
        ? e
        : new LocalReconstructionError("workspace_failed", "Unexpected acceptance failure.", null);
  } finally {
    enter(null);
    clearInterval(sampler);
    await Promise.all(pending);
  }
  const totalMs = now() - started;

  // ── evidence into the output directory ──
  const engineDir = path.join(workRoot, runId);
  const copyIf = async (from: string, to: string) => {
    try {
      await copyFile(from, path.join(o.outputDir, to));
      return true;
    } catch {
      return false;
    }
  };
  await copyIf(path.join(engineDir, "manifest.json"), "run-manifest.json");
  await copyIf(path.join(engineDir, "logs", "run.log"), "run.log");
  let spzPath: string | null = null;
  if (result) {
    await copyIf(result.plyPath, "splat.ply");
    if (await copyIf(result.spzPath, "splat.spz")) spzPath = path.join(o.outputDir, "splat.spz");
  }
  // the engine's own directory: removed unless the operator asked to keep a FAILED run's intermediates
  if (result || !o.keepIntermediates) await rm(workRoot, { recursive: true, force: true, maxRetries: 3 });

  const m = result?.metadata;
  const brushSettings = smoke ? ACCEPTANCE_SMOKE_BRUSH : BRUSH_PROFILES.standard!;
  const fingerprint = o.toolchain.colmap.fingerprint;
  const warnings: string[] = [];
  if (o.assessment.tier !== "PRACTICAL") warnings.push(`Hardware tier ${o.assessment.tier}.`);
  if (smoke)
    warnings.push(
      "The acceptance_smoke Brush profile is a tiny run: the splat is a toolchain check, not a production result.",
    );
  if (o.mode === "FAKE")
    warnings.push("FAKE mode: fake external tools (automated tests); nothing real was reconstructed.");
  const base: Omit<AcceptanceReport, "verdict"> = {
    schema: ACCEPTANCE_REPORT_SCHEMA,
    runId,
    createdAt: new Date(started).toISOString(),
    mode: o.mode,
    network: { providerCalls: 0, paidCalls: 0, uploads: 0 },
    engine: {
      runSchema: LOCAL_RUN_SCHEMA,
      quality: "standard",
      brushProfile: smoke ? "acceptance_smoke" : "standard",
      brushSettings: { ...brushSettings },
    },
    dataset: {
      kind: o.datasetKind,
      inputCount: o.inputs.length,
      totalBytes: inputBytes,
      inputs: o.inputs.map((i) => ({
        ordinal: i.ordinal,
        sha256: i.sha256,
        byteSize: i.byteSize,
        mime: i.mime,
        width: i.width,
        height: i.height,
      })),
      dimensions: dimensionSummary(o.inputs),
    },
    toolchain: {
      colmap: {
        version: o.toolchain.colmap.version,
        sourceCommit: fingerprint?.sourceCommit ?? null,
        binarySha256: fingerprint?.binarySha256 ?? null,
      },
      brush: { version: o.toolchain.brush.version },
      spzEncoder: m?.tools.spzEncoder ?? null,
    },
    hardware: {
      os: `${o.hardware.os.caption ?? o.hardware.os.platform} ${o.hardware.os.release}`.slice(0, 200),
      cpu: (o.hardware.cpu.model ?? "unknown").slice(0, 200),
      logicalCores: o.hardware.cpu.logicalCores,
      ramBytes: o.hardware.memory.totalBytes,
      tier: o.assessment.tier,
    },
    gpuBackend: {
      api: "vulkan",
      instanceVersion: o.hardware.vulkan.instanceVersion,
      devices: o.assessment.usableVulkanDevices.slice(0, 8),
    },
    camera: m
      ? {
          registeredImages: m.colmap.metrics.registeredImages,
          registrationRatio: m.colmap.metrics.registrationRatio,
          sparsePoints: m.colmap.metrics.sparsePoints,
          cameraCount: m.colmap.metrics.cameraCount,
          modelsDiscovered: m.colmap.metrics.modelsDiscovered.length,
        }
      : null,
    splat: m
      ? {
          gaussianCount: m.ply.gaussianCount,
          shDegree: m.ply.shDegree,
          plyBytes: m.ply.byteSize,
          spzBytes: m.spz.byteSize,
          compressionRatio:
            m.spz.byteSize > 0 ? Math.round((m.ply.byteSize / m.spz.byteSize) * 100) / 100 : 0,
          plySha256: m.ply.checksum,
          spzSha256: m.spz.checksum,
          clamped: { ...m.spz.clamped },
        }
      : null,
    timingsMs: timings,
    totalMs,
    resources: {
      minFreeSystemMemoryBytes: minFree,
      maxWorkspaceBytes: maxWorkspace,
      notMeasured: [
        "Peak memory and GPU memory of COLMAP and Brush themselves (not reliably measurable from Prism).",
        "GPU utilisation.",
      ],
    },
    validation: {
      ply: result ? "pass" : error?.code === "ply_invalid" ? "fail" : "not_run",
      spz: result
        ? "pass"
        : error?.code === "spz_invalid" || error?.code === "spz_conversion_failed"
          ? "fail"
          : "not_run",
      inspectSplat: result ? "pass" : error?.code === "spz_invalid" ? "fail" : "not_run",
      sparkRender: "not_run",
      sparkRenderDetail: null,
    },
    outcome: {
      status: result ? "succeeded" : error?.code === "cancelled" ? "cancelled" : "failed",
      error: error ? { code: error.code, stage: error.stage, message: error.message.slice(0, 300) } : null,
    },
    warnings,
  };
  const mv = machineVerdict(base);
  const report = acceptanceReportSchema.parse({
    ...base,
    verdict: {
      machine: mv.verdict,
      machineReasons: mv.reasons,
      final: o.mode === "REAL_ROOM" && mv.verdict !== "FAIL" ? "PENDING_HUMAN_REVIEW" : mv.verdict,
      finalReasons:
        o.mode === "REAL_ROOM" && mv.verdict !== "FAIL" ? ["Awaiting the human review."] : mv.reasons,
    },
  });
  const reportPath = await writeReport(o.outputDir, report);
  if (o.mode === "REAL_ROOM" && result)
    await writeFile(
      path.join(o.outputDir, "human-review.json"),
      `${JSON.stringify(humanReviewTemplate(runId), null, 2)}\n`,
    );
  return { report, reportPath, spzPath };
}

export async function writeReport(dir: string, report: AcceptanceReport): Promise<string> {
  const p = path.join(dir, "acceptance-report.json");
  await writeFile(p, `${JSON.stringify(acceptanceReportSchema.parse(report), null, 2)}\n`);
  return p;
}

export async function readReport(dir: string): Promise<AcceptanceReport> {
  return acceptanceReportSchema.parse(
    JSON.parse(await readFile(path.join(dir, "acceptance-report.json"), "utf8")),
  );
}

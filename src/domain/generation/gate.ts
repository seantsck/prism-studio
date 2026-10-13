import type { GenerationPackage } from "../generation-package";
import type { PreflightReport } from "../preflight";
import type { CompatibilityReport, IgnoredFeature } from "./compatibility";
import { renderPromptPlan } from "./prompt-plan";
import {
  generationRequestSchema,
  type GenerationModel,
  type GenerationRequest,
  type ModelAvailability,
  type PromptPlan,
} from "./schemas";

/**
 * The single answer to "may this shot be sent to this model right now, and if not, exactly why not?".
 * Pure: the server action evaluates it, the UI renders it, tests pin it.
 */
export interface GateBlocker {
  code: string;
  source: "preflight" | "freshness" | "model" | "compatibility" | "submission";
  message: string;
}

export interface GenerationGate {
  allowed: boolean;
  blockers: GateBlocker[];
  /** Ignored features the user has not acknowledged yet. Submission requires every one. */
  unacknowledged: IgnoredFeature[];
}

export interface GateInput {
  preflight: PreflightReport;
  pkg: GenerationPackage;
  model: GenerationModel | null;
  availability: ModelAvailability | null;
  compatibility: CompatibilityReport | null;
  acknowledged: readonly string[];
}

export function evaluateGate(input: GateInput): GenerationGate {
  const blockers: GateBlocker[] = [];

  for (const b of input.preflight.blockers) {
    blockers.push({
      code: `preflight.${b.ruleId}`,
      source: "preflight",
      message: `${b.label}${b.detail ? ` — ${b.detail}` : ""}`,
    });
  }

  // A stale approved storyboard means the picture Prism would condition on no longer matches the shot.
  if (input.pkg.freshness.storyboard.status === "stale") {
    blockers.push({
      code: "freshness.storyboard_stale",
      source: "freshness",
      message: `Approved storyboard is stale. ${input.pkg.freshness.storyboard.messages.join(" ")}`.trim(),
    });
  }

  if (!input.model || !input.availability) {
    blockers.push({ code: "model.unknown", source: "model", message: "Choose a generation model." });
  } else {
    if (input.availability.lifecycle === "retired") {
      blockers.push({
        code: "model.retired",
        source: "model",
        message: `${input.model.displayName} has been retired.`,
      });
    }
    if (!input.availability.enabled) {
      blockers.push({
        code: "model.disabled",
        source: "model",
        message: `${input.model.displayName} is disabled.`,
      });
    } else if (!input.availability.configured) {
      blockers.push({
        code: "model.not_configured",
        source: "model",
        message: `${input.availability.providerName} is not configured on the server (missing: ${input.availability.missingConfig.join(", ") || "configuration"}).`,
      });
    }
  }

  for (const e of input.compatibility?.errors ?? []) {
    blockers.push({ code: `compatibility.${e.id}`, source: "compatibility", message: e.message });
  }

  const ack = new Set(input.acknowledged);
  const unacknowledged = (input.compatibility?.ignoredFeatures ?? []).filter((f) => !ack.has(f.id));

  return { allowed: blockers.length === 0 && unacknowledged.length === 0, blockers, unacknowledged };
}

/** Normalized request an adapter receives. Built only from the frozen package + the compatibility result. */
export function buildGenerationRequest(args: {
  pkg: GenerationPackage;
  model: GenerationModel;
  compatibility: CompatibilityReport;
  plan: PromptPlan;
  idempotencyKey: string;
  seed?: number | null;
  providerOptions?: Record<string, unknown>;
}): GenerationRequest {
  const { compatibility: c } = args;
  if (!c.modality) throw new Error("Cannot build a request without a compatible modality");
  return generationRequestSchema.parse({
    schemaVersion: 1,
    modality: c.modality,
    provider: args.model.provider,
    modelId: args.model.modelId,
    prompt: {
      positive: renderPromptPlan(args.plan, { includeNegative: false }),
      negative: args.pkg.prompt.negative,
    },
    durationMs: c.used.durationMs,
    resolution: c.used.resolution,
    aspectRatio: c.used.aspectRatio,
    fps: c.used.fps,
    seed: args.seed ?? null,
    references: c.used.references,
    startFrameAssetId: c.used.startFrameAssetId,
    endFrameAssetId: c.used.endFrameAssetId,
    audioAssetIds: c.used.audioAssetIds,
    providerOptions: args.providerOptions ?? {},
    idempotencyKey: args.idempotencyKey,
  });
}

/**
 * Appends provider-compatibility results to a preflight report as `generation.compat.*` items, so the
 * existing preflight UI can show "FAIL: duration incompatible / WARN: audio cannot be supplied" next to
 * the other generation rules. Does not mutate the input report.
 */
export function extendPreflightWithCompatibility(
  report: PreflightReport,
  compatibility: CompatibilityReport | null,
): PreflightReport {
  if (!compatibility) return report;
  const extra: PreflightReport["items"] = [
    ...compatibility.errors.map((e) => ({
      ruleId: `generation.compat.${e.id}`,
      section: "generation" as const,
      severity: "required" as const,
      status: "fail" as const,
      label: "Model compatibility",
      detail: e.message,
    })),
    ...compatibility.ignoredFeatures.map((f) => ({
      ruleId: `generation.compat.ignored.${f.id}`,
      section: "generation" as const,
      severity: "recommended" as const,
      status: "warn" as const,
      label: `Not supported by model: ${f.label}`,
      detail: f.impact,
    })),
  ];
  if (extra.length === 0) return report;
  const items = [...report.items, ...extra];
  const blockers = items.filter((i) => i.status === "fail");
  return {
    ...report,
    items,
    blockers,
    warnings: items.filter((i) => i.status === "warn"),
    ready: blockers.length === 0,
  };
}

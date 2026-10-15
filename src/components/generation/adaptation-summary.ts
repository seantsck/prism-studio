import type { GenerationAdaptationPlan } from "@/domain/framing/adaptation";
import type { Rect } from "@/domain/framing/crop";
import type { Evaluation } from "@/generation/submission";

/**
 * Serializable view of one adaptation evaluation, passed from the server workspace to the client panel.
 * Contains plan geometry and sentences only: no credentials, no provider payloads.
 */
export interface PlanSummary {
  status: GenerationAdaptationPlan["status"];
  framing: {
    strategy: string;
    status: string;
    productionLabel: string | null;
    providerLabel: string | null;
    providerRatio: number | null;
    productionRatio: number | null;
    canvas: { width: number; height: number } | null;
    retained: Rect | null;
    safeArea: { action: Rect; title: Rect } | null;
    pad: { mode: "letterbox" | "pillarbox"; barFraction: number } | null;
    discardedFraction: number;
    axis: "none" | "vertical" | "horizontal";
    protectedNotes: string[];
  };
  duration: {
    strategy: string;
    status: string;
    productionMs: number | null;
    providerMs: number | null;
    trimToMs: number | null;
    reason: string;
  };
  warnings: string[];
  blockedReasons: string[];
  promptProduction: string[];
  promptProvider: string[];
}

export interface VariantEvaluation {
  compatible: boolean;
  errors: string[];
  ignored: Array<{ id: string; label: string; impact: string }>;
  blockers: string[];
  estimate: { amount: number | null; currency: string; basis: string } | null;
  duration: { productionMs: number; supported: string; ok: boolean } | null;
  plan: PlanSummary | null;
}

export interface AdaptationOptions {
  framing: Array<{ strategy: string; label: string; usable: boolean; reason: string; recommended: boolean }>;
  duration: Array<{ strategy: string; label: string; usable: boolean; reason: string; recommended: boolean }>;
  needsFraming: boolean;
  needsDuration: boolean;
  /** key = `${framing}|${durationStrategy}` ("" = no choice) */
  variants: Record<string, VariantEvaluation>;
}

export const variantKey = (framing: string, duration: string) => `${framing}|${duration}`;

export function summarizePlan(p: GenerationAdaptationPlan | null): PlanSummary | null {
  if (!p) return null;
  return {
    status: p.status,
    framing: {
      strategy: p.framing.strategy,
      status: p.framing.status,
      productionLabel: p.framing.productionLabel,
      providerLabel: p.framing.providerLabel,
      providerRatio: p.framing.providerRatio,
      productionRatio: p.framing.productionRatio,
      canvas: p.framing.providerCanvas,
      retained: p.framing.retained,
      safeArea: p.framing.safeArea,
      pad: p.framing.pad ? { mode: p.framing.pad.mode, barFraction: p.framing.pad.barFraction } : null,
      discardedFraction: p.framing.discardedFraction,
      axis: p.framing.axis,
      protectedNotes: p.framing.protectedNotes,
    },
    duration: {
      strategy: p.duration.strategy,
      status: p.duration.status,
      productionMs: p.duration.productionMs,
      providerMs: p.duration.providerMs,
      trimToMs: p.duration.trimToMs,
      reason: p.duration.reason,
    },
    warnings: p.warnings,
    blockedReasons: p.blockedReasons,
    promptProduction: p.promptAdaptation.production,
    promptProvider: p.promptAdaptation.provider,
  };
}

export function summarizeEvaluation(e: Evaluation): VariantEvaluation {
  const c = e.compatibility;
  return {
    compatible: c?.compatible ?? false,
    errors: (c?.errors ?? []).map((x) => x.message),
    ignored: (c?.ignoredFeatures ?? []).map((f) => ({ id: f.id, label: f.label, impact: f.impact })),
    blockers: e.gate.blockers.map((b) => b.message),
    estimate: e.estimate,
    duration: c?.duration ?? null,
    plan: summarizePlan(c?.adaptation ?? null),
  };
}

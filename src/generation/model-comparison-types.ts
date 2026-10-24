import type { InputMode } from "@/domain/generation/compatibility";
import type { FitStatus, PackagingRow } from "@/domain/generation/models/matrix";
import type { ModelPerformance } from "@/domain/generation/performance";
import type { GenerationPurpose } from "@/domain/generation/schemas";

/**
 * Serializable view types of the model comparison. Kept free of server-only imports so client components can
 * import them (and `variantKey`) without pulling providers, the registry or SDKs into the browser bundle.
 */
export interface VariantView {
  status: FitStatus;
  statusLabel: string;
  blockers: string[];
  adaptations: string[];
  limitations: string[];
  unknowns: string[];
  packaging: PackagingRow[];
  referencesUsed: { used: number; total: number };
  duration: string;
  durationUnverified: boolean;
  framing: string;
  audio: string;
  estimateUsd: number | null;
  estimateBasis: string | null;
  fitScore: number;
  /** Still-image quality this variant requests (null = the model has none). */
  quality: string | null;
  /** The provider canvas the request would use, "1920×1088" (still images; null otherwise). */
  canvas: string | null;
  /** Animate Production Frame (Phase 2H) facts, shown before any spend; null for other purposes. */
  animation?: AnimationVariantFacts | null;
}

export interface AnimationVariantFacts {
  /** The request would start from the selected Production Frame as image-to-video (never a fallback). */
  exactFirstFrame: boolean;
  productionMs: number | null;
  /** What the provider is asked for (longer than production only with an explicit generate-longer-then-trim plan). */
  providerMs: number | null;
  /** What the delivery master is conformed back to. */
  deliveryMs: number | null;
  productionFraming: string | null;
  /** The provider canvas ratio the frame enters (the canonical Production Frame Asset is never modified). */
  providerCanvas: string | null;
  audioConditioning: string;
  nativeAudio: boolean;
  /** Reference images not separately supplied because the model's exact first-frame mode excludes them. */
  referencesOmittedKeyframe: number;
}

export interface ModelRow {
  key: string;
  provider: string;
  providerName: string;
  modelId: string;
  label: string;
  description: string;
  kind: "mock" | "real";
  role: string | null;
  available: boolean;
  unavailableReason: string | null;
  /**
   * Why the comparison is made: `production_frame` rows are still-image models; `animate_production_frame` rows are
   * the video models judged as image-to-video from the canonical Production Frame.
   */
  purpose: GenerationPurpose;
  /** Still-image quality options (empty = none). The default is explicit and shown before spend. */
  qualities: Array<{ id: string; label: string; note: string }>;
  defaultQuality: string | null;
  /** Variant knobs the user can choose (empty arrays = nothing to choose). */
  modes: InputMode[];
  tiers: string[];
  nativeAudio: boolean;
  defaultVariant: string;
  variants: Record<string, VariantView>;
  recommendation: {
    label: string;
    rank: number | null;
    score: number | null;
    confidence: string;
    why: string[];
    concerns: string[];
    sample: { similar: number; similarPositive: number; other: number; nEff: number };
    historicalRate: number | null;
  };
  history: Pick<
    ModelPerformance,
    | "reviewed"
    | "approved"
    | "shortlisted"
    | "rejected"
    | "preferredWins"
    | "reliability"
    | "topRejectionReasons"
  > | null;
}

export const variantKey = (
  mode: InputMode | null,
  tier: string | null,
  audio: boolean,
  quality: string | null = null,
) => `${mode ?? "-"}|${tier ?? "-"}|${audio ? "audio" : "silent"}${quality ? `|q:${quality}` : ""}`;

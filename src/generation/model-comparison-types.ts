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
  /** Why the comparison is made: `production_frame` rows are still-image models. */
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

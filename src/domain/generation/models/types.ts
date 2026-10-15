import type { GenerationModality } from "../schemas";

/**
 * Model catalog vocabulary (Phase 2E). Provider-independent: a catalog entry describes what a generation MODEL
 * can do and what it costs, with provenance. It is versioned application configuration, never scraped at
 * runtime and never inferred.
 *
 * Capability honesty: a capability is `supported`, `unsupported` or `unknown`. `unknown` means the official
 * documentation / SDK types do not state it. Prism then shows UNKNOWN instead of guessing either way.
 */
export type Support = "supported" | "unsupported" | "unknown";

export type ModelFamily = "runway_gen4" | "veo" | "seedance" | "hailuo";

/** What the model is for, in the comparison set (descriptive, not a quality ranking). */
export type ModelRole = "flagship" | "fast_low_cost" | "reference_rich" | "premium_audio" | "cinematic";

export interface CatalogVerification {
  /** ISO date the capabilities were last checked against the sources below. */
  verifiedAt: string;
  /** Human-readable sources (doc pages / SDK type files). */
  sources: string[];
  /** SDK package version whose types were read (e.g. "@runwayml/sdk@4.21.0"). */
  sdkVersion: string;
  /** Provider API version header the request shapes were verified against. */
  providerApiVersion: string;
  /** Statements the sources do NOT make, kept visible instead of guessed. */
  unstated: string[];
}

/** Duration capability. `verified:false` ranges are a permissive superset; the provider is the authority. */
export interface CatalogDuration {
  /** Exact allowed whole-second values (Veo: 4/6/8). */
  allowedSeconds: number[] | null;
  minSeconds: number;
  maxSeconds: number;
  stepSeconds: number | null;
  /** true = taken from the official types/docs; false = bounds not documented (range is permissive). */
  verified: boolean;
  note: string;
}

export interface CatalogTier {
  /** "480p" | "720p" | "768p" | "1080p" | "2k" | "default" */
  id: string;
  label: string;
  /** Pixel canvas of the 16:9 (or only) ratio, for display. */
  canvas: { width: number; height: number } | null;
  /** aspect label ("16:9") → provider ratio value ("1280:720"). Absent = not offered at this tier. */
  ratios: Record<string, string>;
}

export type CreditRule = {
  /** Credits per second of OUTPUT video by tier id. */
  perSecond: Record<string, { silent: number; audio: number | null }>;
  /** Credits per reference image / keyframe (Hailuo 3: 2). Reference images are free for Seedance 2.5. */
  perReferenceImage: number;
  /** Credits per second of input/reference video, by tier id; "same_as_output" bills at the output rate. */
  perReferenceVideoSecond: Record<string, number> | "same_as_output" | null;
  /** Cap on billed reference-video seconds. */
  referenceVideoBilledCapSeconds: number | null;
  /** Minimum credits per generation (Seedance 2.5: 80). */
  minimumCredits: number | null;
};

export interface CatalogPricing {
  /** Versioned configuration identifier; recorded with estimates so history is never re-priced. */
  version: string;
  verifiedAt: string;
  source: string;
  usdPerCredit: number;
  currency: "USD";
  rule: CreditRule;
}

export interface CatalogInputs {
  startFrame: Support;
  endFrame: Support;
  referenceImages: Support;
  /** Maximum reference images in reference mode; null = not stated. */
  maxReferenceImages: number | null;
  referenceVideo: Support;
  maxReferenceVideoSeconds: number | null;
  referenceAudio: Support;
  maxReferenceAudioSeconds: number | null;
  /**
   * The provider rejects mixing first/last frames with unpositioned reference images ("the two modes cannot
   * be mixed"). Prism then makes the mode an explicit, visible choice instead of silently dropping one.
   */
  keyframesExcludeReferences: Support;
  negativePrompt: Support;
}

export interface CatalogModel {
  provider: string;
  modelId: string;
  displayName: string;
  family: ModelFamily;
  role: ModelRole;
  summary: string;
  availability: "available" | "unavailable" | "deprecated" | "retired";
  availabilityNote: string;
  verification: CatalogVerification;
  modalities: GenerationModality[];
  inputs: CatalogInputs;
  audio: {
    /** The model can generate its own sound/speech (`audio: true`). Never replaces Prism's performance audio. */
    nativeGeneration: Support;
    /** Performed audio is supplied as a reference ("additional context"); not exact lip sync. */
    referenceConditioning: Support;
  };
  duration: CatalogDuration;
  /** Canvas tiers. The FIRST is the default tier (cost-conscious, comparable across models). */
  tiers: CatalogTier[];
  /** All aspect labels offered by any tier or modality. */
  aspectRatios: string[];
  /** Aspect labels offered by text-to-video when narrower than image-to-video (null = same). */
  textToVideoAspectRatios: string[] | null;
  promptMaxChars: number | null;
  /**
   * Planning canvas ceiling for framing adaptation. Defaults to the largest pixel ratio offered; set only to
   * keep a model's historical planning canvas stable (Gen-4.5: 1584×1104).
   */
  planningCanvas?: { width: number; height: number };
  pricing: CatalogPricing;
  /** Provider concurrency advisory (account-tier dependent; real value comes from configuration). */
  concurrencyNote: string;
}

export interface PricingInputs {
  seconds: number;
  tierId: string;
  nativeAudio: boolean;
  referenceImages: number;
  /** Seconds of reference/input video supplied (0 when none). */
  referenceVideoSeconds: number;
  /** An image-to-video start/first frame is supplied (billed as a reference image by some models). */
  startFrame: boolean;
  endFrame: boolean;
}

export interface PricingResult {
  credits: number | null;
  amountUsd: number | null;
  basis: string;
  /** Components used (for the preview): "12 cr/s × 5 s", "+2 cr × 1 image"... */
  parts: string[];
}

import { z } from "zod";

/**
 * Provider-independent generation vocabulary. No React, no Supabase, no provider request shapes.
 * Provider-specific payloads live ONLY inside adapter modules (src/generation/providers/*).
 *
 *   GenerationPackage   what the filmmaker has decided (domain/generation-package.ts, frozen per attempt)
 *   PromptPlan          provider-independent, sectioned statement of intent (prompt-plan.ts)
 *   GenerationRequest   package + chosen model + normalized settings, what an adapter receives (this file)
 *   provider payload    private to the adapter
 */

const id = z.string().min(1);
const iso = z.string();

// ───────────────────────── Modalities ─────────────────────────

export const GENERATION_MODALITIES = [
  "text_to_image",
  "image_to_image",
  "text_to_video",
  "image_to_video",
  "video_to_video",
  "audio_to_video",
  "lip_sync",
  "voice",
  "upscale",
] as const;
export type GenerationModality = (typeof GENERATION_MODALITIES)[number];

export const IMAGE_MODALITIES: readonly GenerationModality[] = ["text_to_image", "image_to_image", "upscale"];
export const VIDEO_MODALITIES: readonly GenerationModality[] = [
  "text_to_video",
  "image_to_video",
  "video_to_video",
  "audio_to_video",
  "lip_sync",
];

/** What a reference asset is FOR. Adapters receive explicit roles; they never guess from file names. */
export const REFERENCE_ROLES = [
  "identity",
  "character_look",
  "location",
  "style",
  "storyboard",
  "start_frame",
  "end_frame",
  "motion_reference",
  "other",
] as const;
export type ReferenceRole = (typeof REFERENCE_ROLES)[number];

// ───────────────────────── Capabilities ─────────────────────────

const resolutionSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Resolution = z.infer<typeof resolutionSchema>;

export const modelCapabilitiesSchema = z.object({
  modalities: z.array(z.enum(GENERATION_MODALITIES)).min(1),
  references: z.object({
    textPrompt: z.boolean(),
    negativePrompt: z.boolean(),
    referenceImages: z.boolean(),
    maxReferences: z.number().int().min(0),
    orderedReferences: z.boolean(),
    characterReferences: z.boolean(),
    styleReferences: z.boolean(),
    locationReferences: z.boolean(),
    startFrame: z.boolean(),
    endFrame: z.boolean(),
    referenceVideo: z.boolean(),
    referenceAudio: z.boolean(),
  }),
  video: z
    .object({
      minDurationMs: z.number().int().positive(),
      maxDurationMs: z.number().int().positive(),
      /** Granularity inside [min,max]; null = any value. Ignored when allowedDurationsMs is set. */
      durationStepMs: z.number().int().positive().nullable(),
      /** Exact allowed durations (some models only offer e.g. 5s and 10s). */
      allowedDurationsMs: z.array(z.number().int().positive()).nullable(),
      cameraControl: z.boolean(),
      motionPrompting: z.boolean(),
      maxResolution: resolutionSchema.nullable(),
      aspectRatios: z.array(z.string()),
      fps: z.array(z.number().positive()),
    })
    .nullable(),
  image: z
    .object({
      resolutions: z.array(resolutionSchema),
      aspectRatios: z.array(z.string()),
      transparency: z.boolean(),
      editing: z.boolean(),
    })
    .nullable(),
  /**
   * Audio is NOT one capability. These are deliberately separate so the UI can say exactly what will
   * (not) happen to the performed dialogue.
   */
  audio: z.object({
    /** Model composes its own dialogue/sound from text. Does NOT use the performed take. */
    nativeDialogueAudio: z.boolean(),
    /** Model conditions the generated picture/motion on a supplied audio performance. */
    audioConditioning: z.boolean(),
    lipSync: z.boolean(),
    referenceAudio: z.boolean(),
    soundGeneration: z.boolean(),
  }),
  operational: z.object({
    mode: z.enum(["sync", "async"]),
    polling: z.boolean(),
    webhook: z.boolean(),
    cancellation: z.boolean(),
    idempotency: z.boolean(),
    maxConcurrency: z.number().int().positive(),
    recommendedPollIntervalMs: z.number().int().positive(),
    /** Prism gives up on a job after this long without a terminal provider state. */
    jobTimeoutMs: z.number().int().positive(),
    rateLimitNotes: z.string(),
  }),
  commercial: z.object({
    pricing: z.enum(["per_second", "per_output", "per_megapixel", "flat", "unknown"]),
    currency: z.string().length(3),
    costUnit: z.string(),
    /** null = unknown; Prism then shows "Unknown" instead of inventing a number. */
    unitCost: z.number().min(0).nullable(),
  }),
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

export const generationModelSchema = z.object({
  provider: id,
  modelId: id,
  displayName: z.string(),
  description: z.string(),
  /** "mock" models never leave the machine and never cost money. */
  kind: z.enum(["mock", "real"]),
  lifecycle: z.enum(["active", "deprecated", "retired"]),
  capabilities: modelCapabilitiesSchema,
});
export type GenerationModel = z.infer<typeof generationModelSchema>;

export const generationProviderInfoSchema = z.object({
  provider: id,
  displayName: z.string(),
  kind: z.enum(["mock", "real"]),
  description: z.string(),
  /** Environment variable NAMES the adapter needs (never values). */
  requiredConfig: z.array(z.string()),
  webhooks: z.boolean(),
});
export type GenerationProviderInfo = z.infer<typeof generationProviderInfoSchema>;

/** What the UI may know about a model. Never contains credentials. */
export const modelAvailabilitySchema = z.object({
  provider: id,
  providerName: z.string(),
  modelId: id,
  displayName: z.string(),
  description: z.string(),
  kind: z.enum(["mock", "real"]),
  modalities: z.array(z.enum(GENERATION_MODALITIES)),
  enabled: z.boolean(),
  configured: z.boolean(),
  /** Names of missing configuration entries (never their values). */
  missingConfig: z.array(z.string()),
  /** false only for billing models while the live-spend gate (PRISM_STUDIO_ALLOW_PAID_GENERATION) is closed. */
  paidGenerationEnabled: z.boolean(),
  available: z.boolean(),
  lifecycle: z.enum(["active", "deprecated", "retired"]),
});
export type ModelAvailability = z.infer<typeof modelAvailabilitySchema>;

// ───────────────────────── Prompt plan ─────────────────────────

export const PROMPT_SECTIONS = [
  "subject",
  "identity",
  "wardrobe",
  "environment",
  "composition",
  "camera",
  "action",
  "timing",
  "performance",
  "lighting",
  "continuity",
  "hard_constraints",
  "negative_constraints",
  /** Provider-canvas guidance from the adaptation plan; never changes the production camera intent above. */
  "provider_adaptation",
] as const;
export type PromptSectionKey = (typeof PROMPT_SECTIONS)[number];

export const promptPlanSchema = z.object({
  version: z.literal(1),
  sections: z.array(
    z.object({
      key: z.enum(PROMPT_SECTIONS),
      title: z.string(),
      lines: z.array(z.string()),
    }),
  ),
});
export type PromptPlan = z.infer<typeof promptPlanSchema>;

// ───────────────────────── Request ─────────────────────────

export const generationReferenceSchema = z.object({
  assetId: id,
  role: z.enum(REFERENCE_ROLES),
  /** 0-based position among references; only meaningful when the model has orderedReferences. */
  order: z.number().int().min(0),
  label: z.string(),
});
export type GenerationReference = z.infer<typeof generationReferenceSchema>;

export const generationRequestSchema = z.object({
  schemaVersion: z.literal(1),
  modality: z.enum(GENERATION_MODALITIES),
  provider: id,
  modelId: id,
  prompt: z.object({ positive: z.string(), negative: z.string() }),
  durationMs: z.number().int().positive().nullable(),
  resolution: resolutionSchema.nullable(),
  aspectRatio: z.string().nullable(),
  fps: z.number().positive().nullable(),
  seed: z.number().int().nullable(),
  /** References the model WILL receive (after the compatibility engine removed unsupported ones). */
  references: z.array(generationReferenceSchema),
  startFrameAssetId: z.string().nullable(),
  endFrameAssetId: z.string().nullable(),
  /** Performed audio the model WILL be conditioned on, in script order. */
  audioAssetIds: z.array(id),
  /** Adapter-specific knobs chosen in the UI/config. Free-form but never secret. */
  providerOptions: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(8),
});
export type GenerationRequest = z.infer<typeof generationRequestSchema>;

// ───────────────────────── Provider results ─────────────────────────

export const PROVIDER_JOB_STATES = ["queued", "processing", "succeeded", "failed", "cancelled"] as const;

export const generationSubmissionSchema = z.object({
  providerJobId: id,
  providerRequestId: z.string().nullable(),
  /** Provider status right after submission. */
  state: z.enum(["queued", "processing", "succeeded"]),
  providerStatus: z.string(),
  acceptedAt: iso,
});
export type GenerationSubmission = z.infer<typeof generationSubmissionSchema>;

export const OUTPUT_ROLES = ["primary", "variant", "preview", "thumbnail", "audio", "metadata"] as const;
export type OutputRole = (typeof OUTPUT_ROLES)[number];

/**
 * How a provider hands over one output. Either bytes the adapter already holds, or a URL the adapter
 * itself obtained from the provider (never from user input). Prism downloads/validates/ingests it and
 * never keeps depending on the URL.
 */
export const providerOutputSchema = z.object({
  role: z.enum(OUTPUT_ROLES),
  position: z.number().int().min(0),
  kind: z.enum(["image", "video", "audio", "document"]),
  filename: z.string(),
  mime: z.string().nullable(),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("bytes"), base64: z.string() }),
    z.object({ type: z.literal("url"), url: z.string() }),
  ]),
  /** Provider-reported facts, stored as sanitized provenance. */
  reported: z.object({
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    durationMs: z.number().int().positive().nullable(),
    fps: z.number().positive().nullable(),
  }),
});
export type ProviderOutput = z.infer<typeof providerOutputSchema>;

export const generationStatusSchema = z.object({
  state: z.enum(PROVIDER_JOB_STATES),
  providerStatus: z.string(),
  progress: z.number().min(0).max(1).nullable(),
  /** Hint for when to poll next. */
  retryAfterMs: z.number().int().positive().nullable(),
  /** Sanitized provider failure (only when state is "failed"): safe code + user-safe message. */
  failure: z
    .object({
      category: z.enum([
        "transient",
        "rate_limit",
        "provider_unavailable",
        "timeout",
        "invalid_request",
        "content_rejected",
        "auth",
        "quota",
        "permanent",
      ]),
      code: z.string(),
      message: z.string(),
    })
    .nullable()
    .optional(),
});
export type GenerationStatus = z.infer<typeof generationStatusSchema>;

export const generationResultSchema = z.object({
  outputs: z.array(providerOutputSchema).min(1),
  provenance: z.object({
    provider: id,
    model: id,
    providerJobId: id,
    providerRequestId: z.string().nullable(),
    providerModelVersion: z.string().nullable(),
    seed: z.number().int().nullable(),
    startedAt: iso.nullable(),
    completedAt: iso.nullable(),
    actualDurationMs: z.number().int().nullable(),
    actualResolution: resolutionSchema.nullable(),
    actualFps: z.number().positive().nullable(),
    finishReason: z.string(),
    /** Which references / inputs the adapter really used (so ignored inputs are always visible). */
    usedInputs: z.array(z.string()),
    /** Normalized settings as sent. Never contains credentials or signed URLs. */
    settings: z.record(z.string(), z.unknown()),
    metadata: z.record(z.string(), z.unknown()),
  }),
  cost: z.object({
    amount: z.number().min(0).nullable(),
    currency: z.string().length(3),
    basis: z.string(),
    units: z.number().min(0).nullable(),
  }),
});
export type GenerationResult = z.infer<typeof generationResultSchema>;

export const GENERATION_ERROR_CATEGORIES = [
  "transient",
  "rate_limit",
  "provider_unavailable",
  "timeout",
  "invalid_request",
  "content_rejected",
  "auth",
  "quota",
  "permanent",
] as const;
export type GenerationErrorCategory = (typeof GENERATION_ERROR_CATEGORIES)[number];

export interface CostEstimate {
  amount: number | null;
  currency: string;
  basis: string;
  units: number | null;
}

// ───────────────────────── Persistent entities ─────────────────────────

export const JOB_STATUSES = [
  "queued",
  "submitting",
  "submitted",
  "processing",
  "ingesting",
  "succeeded",
  "failed",
  "cancel_requested",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const CANCEL_OUTCOMES = ["local_only", "confirmed", "not_supported", "failed"] as const;
export type CancelOutcome = (typeof CANCEL_OUTCOMES)[number];

/** Operational, mutable execution state. One row per execution of an attempt. */
export const generationJobSchema = z.object({
  id,
  projectId: id,
  attemptId: id,
  provider: id,
  model: id,
  status: z.enum(JOB_STATUSES),
  providerJobId: z.string().nullable(),
  providerStatus: z.string(),
  idempotencyKey: z.string(),
  queuePriority: z.number().int(),
  attemptCount: z.number().int().min(0),
  maxAttempts: z.number().int().positive(),
  pollCount: z.number().int().min(0),
  nextRunAt: iso,
  submittedAt: iso.nullable(),
  startedAt: iso.nullable(),
  completedAt: iso.nullable(),
  failedAt: iso.nullable(),
  cancelledAt: iso.nullable(),
  cancelRequestedAt: iso.nullable(),
  cancelOutcome: z.enum(CANCEL_OUTCOMES).nullable(),
  leaseOwner: z.string().nullable(),
  leaseToken: z.string().nullable(),
  leaseExpiresAt: iso.nullable(),
  heartbeatAt: iso.nullable(),
  lastPolledAt: iso.nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorCategory: z.enum(GENERATION_ERROR_CATEGORIES).nullable(),
  lastErrorMessage: z.string(),
  estimatedCost: z.number().min(0).nullable(),
  actualCost: z.number().min(0).nullable(),
  currency: z.string().length(3),
  createdBy: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export type GenerationJob = z.infer<typeof generationJobSchema>;

/** Ordered output of an attempt. The Asset row holds the bytes' metadata; this holds its role. */
export const generationOutputSchema = z.object({
  id,
  projectId: id,
  attemptId: id,
  assetId: id,
  role: z.enum(OUTPUT_ROLES),
  position: z.number().int().min(0),
  provenance: z.record(z.string(), z.unknown()),
  createdAt: iso,
});
export type GenerationOutput = z.infer<typeof generationOutputSchema>;

export const generationCostSchema = z.object({
  id,
  projectId: id,
  attemptId: id,
  jobId: z.string().nullable(),
  provider: id,
  model: id,
  kind: z.enum(["estimated", "actual", "unknown"]),
  amount: z.number().min(0).nullable(),
  currency: z.string().length(3),
  basis: z.string(),
  units: z.number().min(0).nullable(),
  recordedAt: iso,
});
export type GenerationCost = z.infer<typeof generationCostSchema>;

export const generationEventSchema = z.object({
  id,
  projectId: id,
  jobId: id,
  attemptId: id,
  at: iso,
  fromStatus: z.string().nullable(),
  toStatus: z.string(),
  note: z.string(),
});
export type GenerationEvent = z.infer<typeof generationEventSchema>;

export const REVIEW_STATUSES = ["unreviewed", "approved", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REJECTION_CATEGORIES = [
  "identity_drift",
  "wrong_wardrobe",
  "wrong_set",
  "wrong_camera",
  "bad_motion",
  "extra_person",
  "bad_anatomy",
  "bad_lip_sync",
  "bad_audio",
  "timing",
  "artifact",
  "other",
] as const;
export type RejectionCategory = (typeof REJECTION_CATEGORIES)[number];

export const REJECTION_LABELS: Record<RejectionCategory, string> = {
  identity_drift: "Identity drift",
  wrong_wardrobe: "Wrong wardrobe",
  wrong_set: "Wrong set",
  wrong_camera: "Wrong camera",
  bad_motion: "Bad motion",
  extra_person: "Extra person",
  bad_anatomy: "Bad anatomy",
  bad_lip_sync: "Bad lip sync",
  bad_audio: "Bad audio",
  timing: "Timing",
  artifact: "Artifact",
  other: "Other",
};

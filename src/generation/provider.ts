import type { IgnoredFeature } from "@/domain/generation/compatibility";
import type {
  CostEstimate,
  GenerationModel,
  GenerationProviderInfo,
  GenerationRequest,
  GenerationResult,
  GenerationStatus,
  GenerationSubmission,
  PromptPlan,
} from "@/domain/generation/schemas";

/**
 * The provider adapter contract. Adding a provider means implementing this interface in
 * src/generation/providers/<id>.ts and registering it in registry.ts. Nothing else in Prism changes.
 *
 * Rules for adapters:
 *   - They receive Prism's NORMALIZED request and translate it internally. Provider request types never
 *     leave the adapter module.
 *   - They throw GenerationProviderError (classified category + stable code + sanitized message).
 *   - They never log or return credentials, Authorization headers, signed request URLs or raw payloads.
 *   - Output URLs they return must come from the provider's own response (never from user input).
 */

export interface AssetBytes {
  bytes: Uint8Array;
  mime: string | null;
  filename: string;
}

/** How an adapter may read Prism assets it needs to upload to the provider (frames, references, audio). */
export interface AssetAccess {
  /**
   * Bytes of an input asset of THIS attempt (checksum-verified against the Asset row). null when the asset is
   * not an input of the running attempt or cannot be read.
   */
  read(assetId: string): Promise<AssetBytes | null>;
  /**
   * A short-lived URL a provider can fetch the asset from, when the byte path is unsuitable (large inputs).
   * Execution transport only: never log it, never store it, never put it in a package.
   */
  signedUrl?(assetId: string, ttlSeconds: number): Promise<string | null>;
}

export interface ProviderContext {
  now(): Date;
  assets: AssetAccess;
  signal?: AbortSignal;
}

export interface ProviderJobRef {
  providerJobId: string;
  model: string;
  /** Number of polls already performed (lets adapters/tests script transient behaviour). */
  pollCount: number;
  submittedAt: string | null;
  idempotencyKey: string;
}

/** Sanitized view of what would be sent to the provider, for the Prompt Inspector. No secrets, no URLs. */
export interface CompiledRequestSummary {
  /** Plain-language description of the call, e.g. "POST /v1/video (image_to_video)". */
  endpoint: string;
  fields: Record<string, unknown>;
  /** Attachments by role with sizes/ids only. */
  attachments: Array<{ role: string; assetId: string; note?: string }>;
  notes: string[];
}

export interface WebhookEvent {
  providerJobId: string;
  state: GenerationStatus["state"];
  providerStatus: string;
  /** Provider-assigned unique event id, used for replay protection. */
  eventId: string | null;
}

export interface GenerationProviderAdapter {
  info(): GenerationProviderInfo;
  listModels(): GenerationModel[];

  /** Pure, no network: what Prism would send. Used by the Prompt Inspector and fixture tests. */
  compileRequest(request: GenerationRequest, plan: PromptPlan): CompiledRequestSummary;
  /** Adapter-level validation beyond the generic compatibility engine. */
  validateRequest(request: GenerationRequest, model: GenerationModel): { ok: boolean; errors: string[] };
  estimateCost(request: GenerationRequest, model: GenerationModel): CostEstimate;

  submit(request: GenerationRequest, plan: PromptPlan, ctx: ProviderContext): Promise<GenerationSubmission>;
  poll(ref: ProviderJobRef, ctx: ProviderContext): Promise<GenerationStatus>;
  /** Only when capabilities.operational.cancellation is true. Resolves true when the provider confirmed. */
  cancel?(
    ref: ProviderJobRef,
    ctx: ProviderContext,
  ): Promise<{
    /** The provider confirmed the task is cancelled (or no longer running). */
    confirmed: boolean;
    /** The task had ALREADY completed successfully: its output must be kept, not discarded. */
    completed?: boolean;
  }>;
  /**
   * Production intent this adapter cannot honour even though the generic compatibility engine accepted the
   * request (e.g. a prompt longer than the provider's limit). Returned items are acknowledged like any other
   * ignored feature, so nothing is ever dropped silently.
   */
  additionalIgnoredFeatures?(
    request: GenerationRequest,
    plan: PromptPlan,
    model: GenerationModel,
  ): IgnoredFeature[];
  /** Normalized outputs + provenance + cost of a SUCCEEDED job. Output URLs must come from the provider. */
  fetchResult(
    ref: ProviderJobRef,
    request: GenerationRequest,
    ctx: ProviderContext,
  ): Promise<GenerationResult>;

  /** Hostnames output URLs may point at (exact or "*.suffix"). Empty = adapter only returns inline bytes. */
  allowedOutputHosts?(): string[];

  /** Webhook support is optional. Verification MUST precede any parsing of the body. */
  verifyWebhook?(headers: Record<string, string | undefined>, rawBody: string): boolean;
  handleWebhook?(headers: Record<string, string | undefined>, rawBody: string): WebhookEvent | null;
}

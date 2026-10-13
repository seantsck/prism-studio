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
  read(assetId: string): Promise<AssetBytes | null>;
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
  cancel?(ref: ProviderJobRef, ctx: ProviderContext): Promise<{ confirmed: boolean }>;
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

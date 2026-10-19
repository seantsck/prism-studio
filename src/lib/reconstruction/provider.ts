import type {
  JobOptions,
  ProviderOperationStatus,
  ReconstructionProviderId,
} from "@/domain/reconstruction/job";
import type { SplatFormat } from "@/domain/previs/splat";

/**
 * Provider-neutral reconstruction contract (Phase 2F M2D.2). Every provider (World Labs Marble, a future Meshy
 * adapter, the deterministic mock) implements this; nothing else in Prism infers a capability from a provider name.
 *
 * Provider URLs (upload grants, result downloads) are TRANSPORT: they are used inside one server call and never
 * returned to the browser, persisted or logged. Credentials stay inside the adapter.
 */

export type InputMode = "single_image" | "multi_image" | "panorama" | "video";
export type ProviderResultKind = "gaussian_splat" | "mesh" | "world_bundle";
export type CapabilityState = "available" | "unavailable" | "unknown";

export interface ProviderModel {
  id: string;
  label: string;
  /** documented credit cost, when the provider publishes one (min..max for variable pricing) */
  credits: { min: number; max: number } | null;
  /** documented price in USD, derived from the provider's published credit price */
  usd: { min: number; max: number } | null;
}

export interface ProviderCapabilities {
  /** the provider task Prism uses, e.g. World Labs `worlds:generate` */
  capability: string;
  inputModes: readonly InputMode[];
  resultKinds: readonly ProviderResultKind[];
  /** most source images one request may carry (provider-documented) */
  maxImages: number;
  models: readonly ProviderModel[];
  defaultModel: string | null;
  supportsCancel: boolean;
  supportsProgress: boolean;
  supportsWebhooks: boolean;
  supportsIdempotencyKey: boolean;
  requiresPublicInputUrls: boolean;
  supportsProviderAssetUpload: boolean;
  /** true when using this provider costs money (gated by PRISM_STUDIO_ALLOW_PAID_GENERATION) */
  billable: boolean;
  /** shown in the UI; providers that are not real (mock) say so */
  testOnly: boolean;
}

export interface ProviderStatus {
  provider: ReconstructionProviderId;
  label: string;
  /** a credential is present (never WHICH value) */
  configured: boolean;
  /** the operator switched this provider on */
  enabled: boolean;
  capability: CapabilityState;
  /** why it cannot be used right now, in user language (null when ready) */
  reason: string | null;
}

/** One Prism source image, read server-side from private storage. Never a URL. */
export interface ProviderInputImage {
  ordinal: number;
  assetId: string;
  checksum: string | null;
  mime: string;
  bytes: Uint8Array;
}

/** A source image as the provider knows it (e.g. a World Labs media_asset_id). */
export interface PreparedInput {
  ordinal: number;
  assetId: string;
  checksum: string | null;
  providerAssetId: string;
}

export interface SubmitRequest {
  jobId: string;
  attempt: number;
  /** stable per job attempt; providers without idempotency use it as a findable tag */
  idempotencyKey: string;
  model: string | null;
  inputs: PreparedInput[];
  options: JobOptions;
}

export interface OperationSnapshot {
  operationId: string;
  status: ProviderOperationStatus;
  /** 0..1 when the provider reports a number; null otherwise (never invented) */
  progress: number | null;
  description: string | null;
  /** sanitised, bounded subset for storage (never URLs) */
  summary: Record<string, unknown>;
  error: { code: string | null; message: string } | null;
  /** the provider's result payload, TRANSIENT: only used by extractResult in the same call, never stored */
  rawResult: unknown;
}

/** A downloadable result. `transport` is opaque and transient (may hold a signed URL): never persist it. */
export interface ResultCandidate {
  kind: Exclude<ProviderResultKind, "world_bundle">;
  format: SplatFormat | "glb";
  /** e.g. "full_res", "500k" */
  label: string;
  transport: unknown;
}

export interface ExtractedResult {
  /** in preference order */
  candidates: ResultCandidate[];
  /** documented scale estimate (World Labs `semantics_metadata`), or nulls */
  metricScaleFactor: number | null;
  groundPlaneOffset: number | null;
  /** sanitised, bounded, URL-free provenance (world id, caption, model, cost) */
  metadata: Record<string, unknown>;
}

export type ProviderErrorCode =
  | "not_configured"
  | "capability_unavailable"
  | "invalid_request"
  | "insufficient_credits"
  | "rate_limited"
  | "http"
  /** no answer: the request may or may not have been accepted */
  | "timeout"
  | "network"
  | "too_large"
  | "unsafe_url";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ReconstructionProvider {
  readonly id: ReconstructionProviderId;
  capabilities(): ProviderCapabilities;
  status(): ProviderStatus;
  /** Upload (or reuse) the source images as provider assets. Reuses `reusable` entries whose checksum still matches. */
  prepareInputs(images: ProviderInputImage[], reusable: PreparedInput[]): Promise<PreparedInput[]>;
  /** Starts ONE provider operation. Throws ProviderError("timeout"|"network") when the outcome is unknown. */
  submit(req: SubmitRequest): Promise<OperationSnapshot>;
  getOperation(operationId: string): Promise<OperationSnapshot>;
  /** Only when capabilities().supportsCancel. Returns whether the provider confirmed the cancellation. */
  cancel?(operationId: string): Promise<boolean>;
  extractResult(op: OperationSnapshot): ExtractedResult;
  /** Downloads one candidate server-side with a hard byte cap. Throws ProviderError("too_large") over the cap. */
  download(candidate: ResultCandidate, maxBytes: number): Promise<Uint8Array>;
}

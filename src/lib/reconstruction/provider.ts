import type {
  CostClass,
  IngestibleResultKind,
  InputMode,
  JobActualCost,
  JobCostEstimate,
  JobOptions,
  ProviderOperationStatus,
  ReconstructionProviderId,
  ReconstructionResultKind,
} from "@/domain/reconstruction/job";
import type { SplatFormat } from "@/domain/previs/splat";

export type { InputMode };

/**
 * Provider-neutral reconstruction contract (Phase 2F M2D.2). Every provider (the M2D.3 local capture pipeline, the
 * optional World Labs Marble adapter, the deterministic mock) implements this. Nothing outside an adapter infers
 * behaviour from a provider id: the job service and the UI read CAPABILITIES.
 *
 * Provider URLs (upload grants, result downloads) are TRANSPORT: they are used inside one server call and never
 * returned to the browser, persisted or logged. Credentials stay inside the adapter.
 */

/** Where the reconstruction runs. */
export type ProviderExecution = "local" | "hosted" | "mock";

/**
 * Who advances an operation (the execution boundary):
 *   provider_api   an external service runs it; ANY Prism server request may poll its API (rate-limited per job),
 *                  so the job resumes from its stored operation id after a navigation or a closed tab.
 *   local_worker   a separate Prism worker process runs it on this machine (M2D.3). Web requests never execute or
 *                  poll it: they only read the job row the worker writes. The job keeps running with no browser.
 */
export type ProviderRunner = "provider_api" | "local_worker";

export type CapabilityState = "available" | "unavailable" | "not_installed" | "unknown";

/** Result kinds a provider may ADVERTISE: only kinds Prism can ingest (INGESTIBLE_RESULT_KINDS). */
export type ProviderResultKind = IngestibleResultKind;

export interface ProviderModel {
  id: string;
  label: string;
}

/** A provider-specific option, declared so the UI renders it and the server validates it without knowing the id. */
export type ProviderOptionSpec =
  | { key: string; label: string; kind: "boolean"; default: boolean }
  | {
      key: string;
      label: string;
      kind: "choice";
      choices: ReadonlyArray<{ value: string; label: string }>;
      default: string;
    };

export interface ProviderCapabilities {
  /** the provider task Prism uses (stored with the job as provenance) */
  capability: string;
  execution: ProviderExecution;
  runner: ProviderRunner;
  /** free: never spends money · paid: the provider charges · unknown: treated as paid by the spend gate */
  cost: CostClass;
  inputModes: readonly InputMode[];
  resultKinds: readonly ProviderResultKind[];
  /** most inputs one request may carry (provider-documented) */
  maxInputs: number;
  models: readonly ProviderModel[];
  defaultModel: string | null;
  options: readonly ProviderOptionSpec[];
  supportsCancel: boolean;
  supportsProgress: boolean;
  /** an interrupted job continues from stored state (operation id / worker state) without resubmitting */
  supportsResume: boolean;
  supportsIdempotencyKey: boolean;
  /** dev/test servers only; never a real reconstruction */
  testOnly: boolean;
}

/** True when a provider may spend money: paid AND unknown cost both go through the live-spend gate. */
export const isBillable = (c: Pick<ProviderCapabilities, "cost">) => c.cost !== "free";

export interface ProviderStatus {
  provider: ReconstructionProviderId;
  label: string;
  /** a credential / toolchain is present (never WHICH value) */
  configured: boolean;
  /** the operator switched this provider on */
  enabled: boolean;
  capability: CapabilityState;
  /** why it cannot be used right now, in user language (null when ready) */
  reason: string | null;
}

/** One Prism source input, read server-side from private storage. Never a URL. */
export interface ProviderInputImage {
  ordinal: number;
  assetId: string;
  checksum: string | null;
  mime: string;
  bytes: Uint8Array;
}

/** A source input as the provider knows it (e.g. a World Labs media_asset_id). */
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
  /** what the provider itself REPORTED it charged, when its API documents that; never estimated */
  reportedCost?: JobActualCost | null;
}

/** A downloadable result. `transport` is opaque and transient (may hold a signed URL): never persist it. */
export interface ResultCandidate {
  kind: ReconstructionResultKind;
  format: SplatFormat | "glb";
  /** e.g. "full_res", "500k" */
  label: string;
  transport: unknown;
}

export interface ExtractedResult {
  /** in preference order */
  candidates: ResultCandidate[];
  /** the provider's own scale estimate, when it publishes one (1 unit = this many metres), or null */
  metricScaleFactor: number | null;
  /** the provider's own ground-plane estimate, or null */
  groundPlaneOffset: number | null;
  /** sanitised, bounded, URL-free provenance (provider world id, caption, model, …) */
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
  /**
   * The cost of one request with this model and input mode, from the provider's documented pricing. A provider that
   * cannot tell says `costClass: "unknown"` with null amounts; it never guesses.
   */
  estimateCost(model: string | null, mode: InputMode): JobCostEstimate;
  /** Upload (or reuse) the source inputs as provider assets. Reuses `reusable` entries whose checksum still matches. */
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

/**
 * Keeps only the options a provider DECLARES, of the declared type, with declared defaults filled in. An undeclared
 * key or a wrong value is refused rather than silently forwarded to the provider.
 */
export function normalizeProviderOptions(
  specs: readonly ProviderOptionSpec[],
  raw: Record<string, unknown>,
): { ok: true; options: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw))
    if (!specs.some((s) => s.key === key))
      return { ok: false, error: `This provider has no option "${key.slice(0, 40)}".` };
  for (const spec of specs) {
    const v = raw[spec.key];
    if (v === undefined) {
      out[spec.key] = spec.default;
      continue;
    }
    if (spec.kind === "boolean" ? typeof v !== "boolean" : !spec.choices.some((c) => c.value === v))
      return { ok: false, error: `"${spec.label}" has an invalid value.` };
    out[spec.key] = v;
  }
  return { ok: true, options: out };
}

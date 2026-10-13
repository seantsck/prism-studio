import type { AnalyzerCapability } from "@/domain/continuity/model";
import type { CostEstimateUsd } from "@/domain/continuity/analysis/cost";
import type { PlannerAnalyzer } from "@/domain/continuity/analysis/plan";
import type {
  AnalysisBatch,
  AnalysisMode,
  AnalysisUsage,
  ContinuityAnalysisInput,
  NormalizedFinding,
} from "@/domain/continuity/analysis/types";

/**
 * Provider-independent contract for a REAL continuity analyzer (Phase 2D): capabilities / estimate / analyze.
 * Provider transport (Gemini today) lives behind an implementation; nothing provider-specific appears in
 * criteria, plans, findings or the job queue.
 *
 * The earlier synchronous `ContinuityAnalyzer` (Phase 2C) remains the contract for simple in-process analyzers;
 * `MockAnalysisProvider` adapts it to this one so both run through the same queue and the same contract tests.
 */

export interface MediaBytes {
  inputId: string;
  mime: string;
  bytes: Uint8Array;
}

export interface UsageCall {
  kind: "analysis" | "correction";
  inputTokens: number | null;
  outputTokens: number | null;
  thoughtsTokens: number | null;
}

export interface BatchOutcome {
  batchId: string;
  findings: NormalizedFinding[];
  calls: UsageCall[];
  correctionUsed: boolean;
  /** Provider response id (operational metadata for audit only). */
  providerRef: string | null;
  /** True when the provider declined the whole batch: its criteria are UNCHECKED, not FAIL. */
  refused: boolean;
}

export interface AnalysisContext {
  now(): Date;
  signal?: AbortSignal;
  sleep(ms: number): Promise<void>;
  /**
   * Called immediately before EVERY transport invocation (initial or correction), in the same breath as the
   * call. The worker uses it to enforce the per-run transport ceiling, count the invocation durably and persist
   * "request sent". It may throw `AnalysisBatchError("local_policy_block")`: the transport is then never invoked
   * and nothing is counted as sent.
   */
  beforeTransportCall?(info: { batch: AnalysisBatch; kind: "analysis" | "correction" }): Promise<void>;
  /** Whether the run may still spend a schema-correction request (undefined ⇒ allowed). */
  canCorrect?(): boolean;
  /** A temporary provider-side file now exists (operational metadata only; never canonical media). */
  onProviderFile?(ref: string): void;
}

export interface ContinuityAnalysisProvider {
  readonly id: string;
  readonly version: string;
  readonly kind: "mock" | "model";
  readonly label: string;
  readonly model: string;
  capabilities(): readonly AnalyzerCapability[];
  modes(): readonly AnalysisMode[];
  /** Capabilities needing the whole video (empty unless direct_video is enabled). */
  videoCapabilities(): readonly AnalyzerCapability[];
  plannerView(): PlannerAnalyzer;
  /** Conservative cost estimate for an input (zero for free analyzers). */
  estimate(input: ContinuityAnalysisInput, at: Date): CostEstimateUsd;
  /**
   * Authoritative cost of the calls actually made, derived from provider usage metadata. `amountUsd: null`
   * means UNKNOWN (never invented). Free analyzers return 0.
   */
  actualCost(calls: UsageCall[], at: Date): import("@/domain/continuity/analysis/cost").ActualCost;
  analyzeBatch(args: {
    batch: AnalysisBatch;
    input: ContinuityAnalysisInput;
    media: Map<string, MediaBytes>;
    ctx: AnalysisContext;
  }): Promise<BatchOutcome>;
  /** Best-effort deletion of temporary provider-side files. Never throws; reports what happened per file. */
  cleanupFiles?(refs: string[]): Promise<Array<{ ref: string; state: "deleted" | "cleanup_failed" }>>;
}

export class AnalysisBatchError extends Error {
  constructor(
    readonly category: import("@/domain/continuity/analysis/types").AnalysisErrorCategory,
    readonly code: string,
    message: string,
    readonly calls: UsageCall[] = [],
    /** true once a request was sent: the outcome of that request may be billed even though we have no result. */
    readonly requestSent = false,
    readonly retryAfterMs?: number,
    /** The provider's HTTP status when it answered (audit metadata only). */
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "AnalysisBatchError";
  }
}

export function sumUsage(calls: UsageCall[]): AnalysisUsage {
  const add = (f: (c: UsageCall) => number | null) =>
    calls.length === 0 || calls.some((c) => f(c) == null) ? null : calls.reduce((n, c) => n + (f(c) ?? 0), 0);
  const input = add((c) => c.inputTokens);
  const out = add((c) => c.outputTokens);
  const th = add((c) => c.thoughtsTokens);
  return {
    inputTokens: input,
    outputTokens: out,
    thoughtsTokens: th,
    totalTokens: input != null && out != null ? input + out + (th ?? 0) : null,
    calls,
  };
}

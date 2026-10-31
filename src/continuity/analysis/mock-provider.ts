import { fingerprint } from "@/domain/hash";
import type { AnalyzerCapability } from "@/domain/continuity/model";
import type { ActualCost, CostEstimateUsd } from "@/domain/continuity/analysis/cost";
import type { PlannerAnalyzer } from "@/domain/continuity/analysis/plan";
import { validateBatchResponse } from "@/domain/continuity/analysis/schema";
import { SEMANTIC_CUT_FAMILIES } from "@/domain/continuity/sequence";
import type {
  AnalysisBatch,
  AnalysisMode,
  ContinuityAnalysisInput,
  NormalizedFinding,
} from "@/domain/continuity/analysis/types";
import { MOCK_ANALYSIS_LABEL } from "@/domain/continuity/analyzer";
import {
  AnalysisBatchError,
  type BatchOutcome,
  type ContinuityAnalysisProvider,
  type MediaBytes,
  type AnalysisContext,
} from "./provider";

const CAPS: readonly AnalyzerCapability[] = [
  "image_identity",
  "wardrobe",
  "object_presence",
  "scene_match",
  "character_count",
  "composition",
  "lighting",
  // 3A.4D: the MOCK can run the cut contract so the real queue / planner / validator can be exercised offline
  "cross_cut",
];

export const MOCK_PROVIDER_ID = "mock-continuity";
/** 3A.4D: the mock's cut contract version (mode-scoped; the Shot version stays "2"). */
export const MOCK_SEQUENCE_ANALYSIS_VERSION = "mock-sequence-1";
/**
 * The MOCK trusts itself with every cut family so the pipeline can be exercised offline. It is labelled MOCK
 * ANALYSIS everywhere, costs nothing, sends nothing, and never touches the production Gemini calibration state.
 */
export const MOCK_CROSS_CUT_CALIBRATION = {
  version: "mock-cross-cut-all-families",
  acceptedFamilies: [...SEMANTIC_CUT_FAMILIES] as readonly string[],
};

/**
 * Free, deterministic stand-in running through the SAME queue, plan, manifest and result schema as a real
 * analyzer. A result is a pure function of (subject checksum, criterion key): stable tests, no vision claims.
 * Every finding is labelled MOCK ANALYSIS.
 */
export class MockAnalysisProvider implements ContinuityAnalysisProvider {
  readonly id = MOCK_PROVIDER_ID;
  readonly version = "2";
  readonly kind = "mock" as const;
  readonly label = "Mock continuity analyzer";
  readonly model = "mock";

  analysisVersion(mode: AnalysisMode): string | null {
    return mode === "sequence_transition" ? MOCK_SEQUENCE_ANALYSIS_VERSION : this.version;
  }
  crossCutCalibration() {
    return {
      version: MOCK_CROSS_CUT_CALIBRATION.version,
      acceptedFamilies: [...MOCK_CROSS_CUT_CALIBRATION.acceptedFamilies],
    };
  }
  capabilities() {
    return CAPS;
  }
  modes(): readonly AnalysisMode[] {
    return ["image_set", "sequence_transition"];
  }
  videoCapabilities() {
    return [];
  }
  plannerView(): PlannerAnalyzer {
    return {
      id: this.id,
      model: this.model,
      capabilities: CAPS,
      modes: this.modes(),
      videoCapabilities: [],
      crossCutFamilies: MOCK_CROSS_CUT_CALIBRATION.acceptedFamilies,
    };
  }
  estimate(): CostEstimateUsd {
    return {
      expectedUsd: 0,
      maxUsd: 0,
      tokens: { inputTokens: 0, expectedOutputTokens: 0, maxOutputTokens: 0 },
      pricingVersion: "free",
      basis: "Mock analyzer: no external call, no cost.",
    };
  }

  actualCost(): ActualCost {
    return { amountUsd: 0, inputTokens: 0, outputTokens: 0, thoughtsTokens: 0, pricingVersion: "free" };
  }

  private outcome(batch: AnalysisBatch, findings: NormalizedFinding[]): BatchOutcome {
    return {
      batchId: batch.id,
      findings,
      calls: [{ kind: "analysis", inputTokens: 0, outputTokens: 0, thoughtsTokens: 0 }],
      correctionUsed: false,
      providerRef: null,
      refused: false,
    };
  }

  async analyzeBatch(args: {
    batch: AnalysisBatch;
    input: ContinuityAnalysisInput;
    media: Map<string, MediaBytes>;
    ctx: AnalysisContext;
  }): Promise<BatchOutcome> {
    const { batch, input } = args;
    if (batch.mode === "sequence_transition") return this.analyzeCut(batch, input);
    if (input.subjectKind === "transition")
      throw new AnalysisBatchError(
        "invalid_input",
        "subject_mode_mismatch",
        "A cut input has no Shot batches.",
      );
    const subject = input.media.find((m) => m.kind === "video" || m.assetId === input.subjectAssetId);
    const seed = subject?.checksum ?? input.subjectAssetId;
    const frame = batch.outputInputIds[0] ?? null;
    const frameMedia = input.media.find((m) => m.inputId === frame);
    const findings: NormalizedFinding[] = batch.criterionKeys.map((key) => {
      const c = input.criteria.find((x) => x.key === key)!;
      const n = parseInt(fingerprint({ s: seed, k: key, v: this.version }).slice(0, 8), 16) % 100;
      const result = n < 62 ? "pass" : n < 86 ? "warn" : "fail";
      return {
        criterionKey: key,
        result,
        confidence:
          Math.round(
            (0.55 + (parseInt(fingerprint({ k: key, s: seed }).slice(8, 12), 16) % 40) / 100) * 100,
          ) / 100,
        summary:
          result === "pass"
            ? `${MOCK_ANALYSIS_LABEL}: appears consistent with "${c.expected.slice(0, 80)}"`
            : `${MOCK_ANALYSIS_LABEL}: possible deviation from "${c.expected.slice(0, 80)}"`,
        evidence: frame
          ? [
              {
                input: frame,
                assetId: frameMedia?.assetId ?? null,
                atMs: frameMedia?.atMs ?? null,
                observation: `${MOCK_ANALYSIS_LABEL} — deterministic placeholder, not a real visual comparison.`,
                source: "output_frame" as const,
              },
            ]
          : [],
        contradictions: result === "fail" ? [`${MOCK_ANALYSIS_LABEL}: simulated contradiction.`] : [],
        limitations: [`${MOCK_ANALYSIS_LABEL}: no pixels were examined.`],
      };
    });
    return this.outcome(batch, findings);
  }

  /**
   * 3A.4D: a deterministic MOCK cut answer, written as the JSON a model would return and passed through the REAL
   * sequence validator (sided evidence, per-clip bounds), so the offline path proves exactly what a real one must.
   */
  private analyzeCut(batch: AnalysisBatch, input: ContinuityAnalysisInput): BatchOutcome {
    const clip = (side: "left" | "right") => input.media.find((m) => m.inputId === `${side}:clip`);
    const left = clip("left");
    const right = clip("right");
    const seed = `${left?.checksum ?? "?"}|${right?.checksum ?? "?"}`;
    const mid = (d: number | null | undefined) => Math.max(0, Math.floor((d ?? 0) / 2));
    const answer = {
      criteria: batch.criterionKeys.map((key) => {
        const c = input.criteria.find((x) => x.key === key)!;
        const n =
          parseInt(fingerprint({ s: seed, k: key, v: MOCK_SEQUENCE_ANALYSIS_VERSION }).slice(0, 8), 16) % 100;
        const result = n < 70 ? "pass" : n < 90 ? "warn" : "fail";
        return {
          criterionId: key,
          result,
          confidence: 0.5,
          summary: `${MOCK_ANALYSIS_LABEL}: ${result === "pass" ? "no contradiction simulated for" : "simulated deviation from"} "${c.expected.slice(0, 80)}"`,
          evidence: [
            {
              input: "left:clip",
              timestampMs: mid(left?.durationMs),
              endMs: left?.durationMs ?? null,
              observation: `${MOCK_ANALYSIS_LABEL} — left side placeholder, no pixels examined.`,
            },
            {
              input: "right:first",
              timestampMs: null,
              endMs: null,
              observation: `${MOCK_ANALYSIS_LABEL} — right edge frame placeholder, no pixels examined.`,
            },
          ],
          contradictions: result === "fail" ? [`${MOCK_ANALYSIS_LABEL}: simulated contradiction.`] : [],
          limitations: [`${MOCK_ANALYSIS_LABEL}: no pixels were examined.`],
        };
      }),
    };
    const v = validateBatchResponse(JSON.stringify(answer), batch, input.media);
    if (!v.ok)
      throw new AnalysisBatchError("schema_invalid", "mock_schema_invalid", v.errors.slice(0, 3).join("; "));
    return this.outcome(batch, v.findings);
  }
}

import { fingerprint } from "@/domain/hash";
import type { AnalyzerCapability } from "@/domain/continuity/model";
import type { ActualCost, CostEstimateUsd } from "@/domain/continuity/analysis/cost";
import type { PlannerAnalyzer } from "@/domain/continuity/analysis/plan";
import type {
  AnalysisBatch,
  AnalysisMode,
  ContinuityAnalysisInput,
  NormalizedFinding,
} from "@/domain/continuity/analysis/types";
import { MOCK_ANALYSIS_LABEL } from "@/domain/continuity/analyzer";
import type { BatchOutcome, ContinuityAnalysisProvider, MediaBytes, AnalysisContext } from "./provider";

const CAPS: readonly AnalyzerCapability[] = [
  "image_identity",
  "wardrobe",
  "object_presence",
  "scene_match",
  "character_count",
  "composition",
  "lighting",
];

export const MOCK_PROVIDER_ID = "mock-continuity";

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

  capabilities() {
    return CAPS;
  }
  modes(): readonly AnalysisMode[] {
    return ["image_set"];
  }
  videoCapabilities() {
    return [];
  }
  plannerView(): PlannerAnalyzer {
    return {
      id: this.id,
      model: this.model,
      capabilities: CAPS,
      modes: ["image_set"],
      videoCapabilities: [],
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

  async analyzeBatch(args: {
    batch: AnalysisBatch;
    input: ContinuityAnalysisInput;
    media: Map<string, MediaBytes>;
    ctx: AnalysisContext;
  }): Promise<BatchOutcome> {
    const { batch, input } = args;
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
    return {
      batchId: batch.id,
      findings,
      calls: [{ kind: "analysis", inputTokens: 0, outputTokens: 0, thoughtsTokens: 0 }],
      correctionUsed: false,
      providerRef: null,
      refused: false,
    };
  }
}

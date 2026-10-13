import { fingerprint } from "../hash";
import {
  type AnalyzerCapability,
  type ContinuityCriterion,
  type ContinuityResult,
  type FindingResult,
  type ReferenceItem,
} from "./model";

/**
 * Provider-independent continuity analyzer contract.
 *
 * An analyzer receives FROZEN inputs (the subject asset + its extracted review frames, the reference set, the
 * criteria with their expected values) and returns findings. It never reads or mutates project data, never
 * approves or rejects anything, and is never coupled to a vendor: Phase 2D can add a multimodal model, a face
 * identity model or an embedding model behind this same interface.
 */
export interface AnalyzerFrame {
  atMs: number;
  assetId: string | null;
  checksum: string | null;
}

export interface AnalyzerInput {
  runId: string;
  attemptId: string;
  subject: { assetId: string; checksum: string | null; kind: "video" | "image" | "audio" | "unknown" };
  /** Review frames extracted from the subject (first / 25% / 50% / 75% / last). */
  frames: AnalyzerFrame[];
  references: ReferenceItem[];
  /** Only the criteria this analyzer declared a capability for. */
  criteria: ContinuityCriterion[];
}

export interface AnalyzerFinding {
  criterionKey: string;
  result: ContinuityResult;
  actual: string;
  confidence: number | null;
  notes: string;
  evidence: FindingResult["evidence"];
}

export interface ContinuityAnalyzer {
  readonly id: string;
  readonly version: string;
  /** "mock" results are labelled MOCK ANALYSIS everywhere and never pretend to be real vision. */
  readonly kind: "mock" | "model";
  readonly label: string;
  readonly capabilities: readonly AnalyzerCapability[];
  analyze(input: AnalyzerInput): Promise<AnalyzerFinding[]>;
}

/** The criteria an analyzer is asked about: exactly those it can judge. */
export function criteriaFor(
  analyzer: ContinuityAnalyzer,
  criteria: ContinuityCriterion[],
): ContinuityCriterion[] {
  const can = new Set<AnalyzerCapability>(analyzer.capabilities);
  return criteria.filter((c) => c.handler === "analyzer" && c.capability && can.has(c.capability));
}

// ───────────────────────── mock analyzer ─────────────────────────

export const MOCK_ANALYZER_ID = "mock-continuity";
export const MOCK_ANALYZER_VERSION = "1";
export const MOCK_ANALYSIS_LABEL = "MOCK ANALYSIS";

/**
 * Deterministic, offline stand-in used to exercise queued analysis, findings, scores, overrides, re-runs and
 * the review UI. It does NOT look at pixels: each result is a pure function of (subject checksum, criterion
 * key), so tests are stable and nobody mistakes it for a vision model.
 *
 * It declares only capabilities it can pretend to have; temporal and audio criteria stay `unchecked`, which is
 * also how the product shows "no analyzer can judge this yet".
 */
export class MockContinuityAnalyzer implements ContinuityAnalyzer {
  readonly id = MOCK_ANALYZER_ID;
  readonly version = MOCK_ANALYZER_VERSION;
  readonly kind = "mock" as const;
  readonly label = "Mock continuity analyzer";
  readonly capabilities: readonly AnalyzerCapability[] = [
    "image_identity",
    "wardrobe",
    "object_presence",
    "scene_match",
    "character_count",
    "composition",
    "lighting",
  ];

  async analyze(input: AnalyzerInput): Promise<AnalyzerFinding[]> {
    return input.criteria.map((c) => {
      const h = fingerprint({
        s: input.subject.checksum ?? input.subject.assetId,
        k: c.key,
        v: this.version,
      });
      const n = parseInt(h.slice(0, 8), 16) % 100;
      const result: ContinuityResult = n < 62 ? "pass" : n < 86 ? "warn" : "fail";
      const confidence = Math.round((0.55 + (parseInt(h.slice(8, 12), 16) % 40) / 100) * 100) / 100;
      const lastFrame = input.frames.at(-1)?.atMs ?? 0;
      return {
        criterionKey: c.key,
        result,
        actual:
          result === "pass"
            ? `${MOCK_ANALYSIS_LABEL}: appears consistent with "${c.expected}"`
            : `${MOCK_ANALYSIS_LABEL}: possible deviation from "${c.expected}"`,
        confidence,
        notes: `${MOCK_ANALYSIS_LABEL} — deterministic placeholder, not a real visual comparison.`,
        evidence:
          result === "pass"
            ? {}
            : {
                frames: input.frames.map((f) => f.atMs).slice(0, 2),
                timeRangeMs: [0, lastFrame] as [number, number],
              },
      };
    });
  }
}

import { encodeMockPng } from "@/generation/providers/mock-image";
import type { ContinuityCriterion } from "@/domain/continuity/model";
import { buildAnalysisPlan, type PlannerAnalyzer } from "@/domain/continuity/analysis/plan";
import {
  ANALYSIS_SCHEMA_VERSION,
  PROMPT_VERSIONS,
  RUBRIC_VERSION,
  type AnalysisMedia,
  type ContinuityAnalysisInput,
} from "@/domain/continuity/analysis/types";
import type { MediaBytes } from "../provider";

/** Synthetic, deterministic fixtures: no real people, no project data. */
export const crit = (
  key: string,
  category: ContinuityCriterion["category"],
  capability: ContinuityCriterion["capability"],
  over: Partial<ContinuityCriterion> = {},
): ContinuityCriterion => ({
  key,
  category,
  severity: "major",
  title: key,
  sourceRef: 'Look "Formal Black" (locked)',
  expected: `expected for ${key}`,
  handler: "analyzer",
  capability,
  position: 0,
  ...over,
});

export const CRITERIA: ContinuityCriterion[] = [
  crit("identity:charA", "identity", "image_identity", {
    severity: "critical",
    expected: "Character A: dark shoulder-length hair, pale complexion",
  }),
  crit("wardrobe:charA", "wardrobe", "wardrobe", {
    severity: "critical",
    expected: "black formal evening dress",
  }),
  crit("hair:charA", "hair", "wardrobe", { severity: "minor", expected: "low chignon" }),
  crit("location_set", "location_set", "scene_match", { expected: "marble lobby with a chandelier" }),
  crit("lighting", "lighting", "lighting", { severity: "minor", expected: "hushed, warm chandelier light" }),
  crit("character_count", "character_count", "character_count", { expected: "1" }),
  crit("screen_direction", "screen_direction", "video_temporal", { expected: "moves right-to-left" }),
  crit("lip_sync", "lip_sync", "lip_sync", { severity: "minor", expected: "matches dialogue" }),
  crit("duration", "duration", null, { handler: "deterministic", expected: "4.5s" }),
  crit("protected:0", "composition", "composition", { handler: "manual", expected: "eyes inside the crop" }),
];

const media = (
  inputId: string,
  kind: AnalysisMedia["kind"],
  role: string,
  over: Partial<AnalysisMedia> = {},
): AnalysisMedia => ({
  inputId,
  kind,
  role,
  label: `${role} ${inputId}`,
  assetId: `asset-${inputId}`.replace(/[^a-z0-9-]/gi, "-"),
  checksum: `sum-${inputId}`,
  mime: "image/png",
  width: 1280,
  height: 720,
  byteSize: 5000,
  durationMs: null,
  atMs: null,
  ...over,
});

export const MEDIA: AnalysisMedia[] = [
  media("ref:identity:1", "reference", "identity"),
  media("ref:identity:2", "reference", "identity"),
  media("ref:look:1", "reference", "look"),
  media("ref:look:2", "reference", "look"),
  media("ref:location:1", "reference", "location"),
  media("ref:storyboard:1", "reference", "storyboard"),
  media("ref:previous_shot:1", "reference", "previous_shot"),
  ...[0, 1250, 2500, 3750, 4400].map((t) =>
    media(`frame:${t}`, "output_frame", "output_frame", { atMs: t, width: 192, height: 80 }),
  ),
  media("sheet", "contact_sheet", "contact_sheet", { width: 1600, height: 200 }),
  media("video", "video", "output_video", { mime: "video/mp4", durationMs: 4500, width: 1280, height: 536 }),
];

export const PLANNER: PlannerAnalyzer = {
  id: "gemini",
  model: "gemini-3.8-flash",
  capabilities: [
    "image_identity",
    "wardrobe",
    "object_presence",
    "scene_match",
    "character_count",
    "composition",
    "lighting",
  ],
  modes: ["image_set"],
  videoCapabilities: [],
};

export function makeInput(
  over: Partial<ContinuityAnalysisInput> = {},
  planner: PlannerAnalyzer = PLANNER,
): ContinuityAnalysisInput {
  const plan = buildAnalysisPlan({ analyzer: planner, criteria: CRITERIA, media: MEDIA });
  const criteria = CRITERIA.flatMap((c) =>
    c.capability
      ? [
          {
            key: c.key,
            category: c.category,
            severity: c.severity,
            title: c.title,
            sourceRef: c.sourceRef,
            expected: c.expected,
            capability: c.capability,
          },
        ]
      : [],
  );
  return {
    version: 1,
    runKey: "run-1",
    attemptId: "attempt-1",
    subjectAssetId: "asset-subject",
    providerOriginalAssetId: "asset-original",
    criteria,
    media: MEDIA,
    framing: {
      productionAspectRatio: "2.39:1",
      deliveryWidth: null,
      deliveryHeight: null,
      providerCanvas: "16:9",
      strategy: "overscan_for_crop",
    },
    analyzer: planner.id,
    analyzerVersion: "1",
    model: planner.model,
    promptVersions: PROMPT_VERSIONS,
    rubricVersion: RUBRIC_VERSION,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    plan,
    ...over,
  };
}

export function mediaFor(input: ContinuityAnalysisInput): Map<string, MediaBytes> {
  return new Map(
    input.media
      .filter((m) => m.kind !== "video")
      .map(
        (m, i) =>
          [
            m.inputId,
            { inputId: m.inputId, mime: "image/png", bytes: encodeMockPng(32, 18, i + 1) },
          ] as const,
      ),
  );
}

export const ctx = () => ({ now: () => new Date("2026-10-13T12:00:00Z"), sleep: async () => undefined });

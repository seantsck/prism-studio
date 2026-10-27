import { fingerprint } from "../../hash";
import type { AnalyzerCapability, ContinuityCriterion } from "../model";
import {
  DEFAULT_ANALYSIS_BUDGET,
  promptVersionFor,
  type AnalysisBatch,
  type AnalysisBudget,
  type AnalysisCriterion,
  type AnalysisMedia,
  type AnalysisMode,
  type ContinuityAnalysisPlan,
  type ExternalMediaManifest,
  type ManifestEntry,
  type PlanItem,
} from "./types";

/**
 * Deterministic ContinuityAnalysisPlan: BEFORE anything runs, decide per criterion whether it is analysed
 * (and how), left to deterministic checks, left to a person, or unsupported by the chosen analyzer. This is
 * what prevents one giant vague "analyze everything" prompt, and what the user sees before spending.
 *
 * Pure: same inputs ⇒ same plan (and same fingerprint).
 */

export interface PlannerAnalyzer {
  id: string;
  model: string;
  /** Capabilities the analyzer declares (via the image-set path). */
  capabilities: readonly AnalyzerCapability[];
  /** Modes it can execute AND that are enabled right now. */
  modes: readonly AnalysisMode[];
  /** Capabilities that need the whole video (temporal/audio). Only used when `direct_video` is enabled. */
  videoCapabilities: readonly AnalyzerCapability[];
}

/** Capabilities that cannot be judged from stills. */
export const TEMPORAL_CAPABILITIES: readonly AnalyzerCapability[] = ["video_temporal", "lip_sync", "audio"];

/**
 * Which reference roles are relevant to a criterion category, best first. Roles not listed are never sent for
 * that category. A GENERATED frame never becomes identity truth: `output_frame` is not a reference role.
 */
export const REFERENCE_PRIORITY: Record<string, readonly string[]> = {
  identity: ["identity", "production_frame", "storyboard"],
  wardrobe: ["look", "identity", "production_frame", "storyboard"],
  hair: ["look", "identity", "production_frame", "storyboard"],
  makeup: ["look", "identity", "production_frame", "storyboard"],
  jewelry: ["look", "identity", "production_frame", "storyboard"],
  props: ["reference", "look", "production_frame", "storyboard", "location"],
  location_set: ["location_view", "location", "production_frame", "storyboard", "previous_shot"],
  lighting: ["lighting", "production_frame", "location_view", "location", "storyboard", "previous_shot"],
  weather: ["location_view", "location", "production_frame", "storyboard", "previous_shot"],
  time_of_day: ["location_view", "location", "lighting", "production_frame", "storyboard", "previous_shot"],
  character_count: ["identity", "production_frame", "storyboard"],
  composition: ["production_frame", "storyboard", "location_view", "location"],
  camera: ["production_frame", "storyboard", "location_view", "location"],
  screen_direction: ["production_frame", "storyboard", "previous_shot"],
  eyelines: ["production_frame", "storyboard", "previous_shot"],
  geography: ["location_view", "location", "production_frame", "storyboard", "previous_shot"],
  action_continuity: ["production_frame", "storyboard", "previous_shot"],
  lip_sync: [],
  audio: [],
  duration: [],
  other: ["reference", "production_frame", "storyboard"],
};

/** A criterion's reference routing: its own explicit roles (3A.1 fidelity criteria), else its category's. */
export const referenceRolesFor = (c: Pick<ContinuityCriterion, "category" | "referenceRoles">) =>
  c.referenceRoles ?? REFERENCE_PRIORITY[c.category] ?? REFERENCE_PRIORITY.other!;

export interface PlanInput {
  analyzer: PlannerAnalyzer;
  criteria: ContinuityCriterion[];
  /** Everything eligible. Output media (frames / sheet / video) have kind != "reference". */
  media: AnalysisMedia[];
  budget?: AnalysisBudget;
}

export const toAnalysisCriterion = (c: ContinuityCriterion): AnalysisCriterion | null =>
  c.capability
    ? {
        key: c.key,
        category: c.category,
        severity: c.severity,
        title: c.title,
        sourceRef: c.sourceRef,
        expected: c.expected,
        capability: c.capability,
      }
    : null;

/** Deterministic order: explicit role rank, then input id (stable). */
function rankedReferences(roles: readonly string[], media: AnalysisMedia[]): AnalysisMedia[] {
  const rank = (role: string) => roles.indexOf(role);
  return media
    .filter((m) => m.kind === "reference" && rank(m.role) >= 0)
    .sort((a, b) => rank(a.role) - rank(b.role) || a.inputId.localeCompare(b.inputId));
}

export function buildAnalysisPlan(input: PlanInput): ContinuityAnalysisPlan {
  const budget = input.budget ?? DEFAULT_ANALYSIS_BUDGET;
  const { analyzer } = input;
  const items: PlanItem[] = [];
  const planned: Array<{
    c: AnalysisCriterion;
    mode: AnalysisMode;
    refs: AnalysisMedia[];
    omitted: AnalysisMedia[];
  }> = [];

  const frames = input.media
    .filter((m) => m.kind === "output_frame")
    .sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
  const sheet = input.media.find((m) => m.kind === "contact_sheet") ?? null;
  const video = input.media.find((m) => m.kind === "video") ?? null;
  const outputsForImageSet: AnalysisMedia[] =
    frames.length > 0 ? frames.slice(0, budget.maxOutputImagesPerBatch) : sheet ? [sheet] : [];

  for (const c of input.criteria) {
    const base = { criterionKey: c.key, batchId: null as string | null };
    if (c.handler === "deterministic") {
      items.push({
        ...base,
        status: "deterministic",
        mode: null,
        capability: null,
        reason: "Answered by metadata checks (no AI).",
      });
      continue;
    }
    if (c.handler === "manual" || !c.capability) {
      items.push({
        ...base,
        status: "manual",
        mode: null,
        capability: c.capability,
        reason: "Only a person can judge this criterion.",
      });
      continue;
    }
    const cap = c.capability;
    const temporal = TEMPORAL_CAPABILITIES.includes(cap);
    const ac = toAnalysisCriterion(c)!;

    if (temporal) {
      const supported = analyzer.modes.includes("direct_video") && analyzer.videoCapabilities.includes(cap);
      if (!supported) {
        items.push({
          ...base,
          status: "unsupported",
          mode: "direct_video",
          capability: cap,
          reason: analyzer.modes.includes("direct_video")
            ? `${analyzer.id} does not declare ${cap}.`
            : "Needs direct-video analysis, which is not enabled. Stays unchecked.",
        });
        continue;
      }
      if (!video) {
        items.push({
          ...base,
          status: "no_media",
          mode: "direct_video",
          capability: cap,
          reason: "No output video is available.",
        });
        continue;
      }
      planned.push({ c: ac, mode: "direct_video", refs: [], omitted: [] });
      items.push({
        ...base,
        status: "planned",
        mode: "direct_video",
        capability: cap,
        reason: "Analysed from the output video.",
      });
      continue;
    }

    if (!analyzer.modes.includes("image_set") || !analyzer.capabilities.includes(cap)) {
      items.push({
        ...base,
        status: "unsupported",
        mode: "image_set",
        capability: cap,
        reason: `${analyzer.id} does not declare ${cap}: this criterion stays unchecked (never inferred as pass).`,
      });
      continue;
    }
    if (outputsForImageSet.length === 0) {
      items.push({
        ...base,
        status: "no_media",
        mode: "image_set",
        capability: cap,
        reason: "No output review frames or contact sheet exist yet.",
      });
      continue;
    }
    const roles = referenceRolesFor(c);
    const ranked = rankedReferences(roles, input.media);
    const wantsRefs = roles.length > 0;
    // composition / camera framing can be judged against production text alone, unless a criterion names its one
    // canonical reference (a fidelity check without its reference image stays unchecked)
    const textJudgeable = !c.referenceRoles && (c.category === "composition" || c.category === "camera");
    if (wantsRefs && ranked.length === 0 && !textJudgeable) {
      items.push({
        ...base,
        status: "no_media",
        mode: "image_set",
        capability: cap,
        reason: "No relevant reference image is part of this run's reference set.",
      });
      continue;
    }
    const refs = ranked.slice(0, budget.maxReferencesPerBatch);
    const omitted = ranked.slice(budget.maxReferencesPerBatch);
    planned.push({ c: ac, mode: "image_set", refs, omitted });
    items.push({
      ...base,
      status: "planned",
      mode: "image_set",
      capability: cap,
      reason: `Analysed from ${refs.length} reference(s) and ${outputsForImageSet.length} output image(s).`,
    });
  }

  // ── batching: criteria with IDENTICAL visual inputs share one request, capped per batch ──
  const groups = new Map<string, typeof planned>();
  for (const p of planned) {
    const key = `${p.mode}|${p.refs.map((r) => r.inputId).join(",")}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const batches: AnalysisBatch[] = [];
  let n = 0;
  for (const [, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (let i = 0; i < group.length; i += budget.maxCriteriaPerBatch) {
      const slice = group.slice(i, i + budget.maxCriteriaPerBatch);
      const mode = slice[0]!.mode;
      n += 1;
      batches.push({
        id: `b${n}`,
        mode,
        promptVersion: promptVersionFor(analyzer.id, mode),
        criterionKeys: slice.map((s) => s.c.key),
        referenceInputIds: slice[0]!.refs.map((r) => r.inputId),
        outputInputIds:
          mode === "direct_video" ? (video ? [video.inputId] : []) : outputsForImageSet.map((m) => m.inputId),
        omittedReferenceInputIds: slice[0]!.omitted.map((r) => r.inputId),
      });
    }
  }
  for (const b of batches)
    for (const k of b.criterionKeys) items.find((it) => it.criterionKey === k)!.batchId = b.id;

  // ── manifest: everything eligible, sent or not, with the reason ──
  const sentIds = new Set(batches.flatMap((b) => [...b.referenceInputIds, ...b.outputInputIds]));
  const entries: ManifestEntry[] = input.media
    .map((m) => ({
      inputId: m.inputId,
      assetId: m.assetId,
      checksum: m.checksum,
      kind: m.kind,
      role: m.role,
      sent: sentIds.has(m.inputId),
      derivative: sentIds.has(m.inputId) && m.kind !== "video" ? boundedDerivative(m, budget) : null,
      omissionReason: sentIds.has(m.inputId)
        ? null
        : m.kind === "video"
          ? ("direct_video_disabled" as const)
          : batches.some((b) => b.omittedReferenceInputIds.includes(m.inputId))
            ? ("input_budget" as const)
            : ("no_matching_criterion" as const),
    }))
    .sort((a, b) => a.inputId.localeCompare(b.inputId));
  const manifest: ExternalMediaManifest = {
    version: 1,
    analyzer: analyzer.id,
    model: analyzer.model,
    entries,
    criteriaSent: planned.length,
  };

  const body = { analyzer: analyzer.id, model: analyzer.model, items, batches, manifest, budget };
  return { version: 1, ...body, fingerprint: fingerprint(body) };
}

/** The size an image would be sent at: bounded long edge, aspect preserved, even dimensions. */
export function boundedDerivative(
  m: Pick<AnalysisMedia, "width" | "height" | "mime">,
  budget: AnalysisBudget,
): { width: number | null; height: number | null; mime: string | null } {
  if (!m.width || !m.height) return { width: null, height: null, mime: m.mime };
  const long = Math.max(m.width, m.height);
  if (long <= budget.maxImageDimension) return { width: m.width, height: m.height, mime: m.mime };
  const k = budget.maxImageDimension / long;
  const even = (x: number) => Math.max(2, 2 * Math.round(x / 2));
  return { width: even(m.width * k), height: even(m.height * k), mime: m.mime };
}

export interface PlanSummary {
  analysed: number;
  deterministic: number;
  manual: number;
  unsupported: number;
  noMedia: number;
  referencesSent: number;
  referencesOmitted: number;
  outputImagesSent: number;
  requests: number;
}

export function summarizePlan(plan: ContinuityAnalysisPlan): PlanSummary {
  const c = (s: PlanItem["status"]) => plan.items.filter((i) => i.status === s).length;
  const sent = plan.manifest.entries.filter((e) => e.sent);
  return {
    analysed: c("planned"),
    deterministic: c("deterministic"),
    manual: c("manual"),
    unsupported: c("unsupported"),
    noMedia: c("no_media"),
    referencesSent: sent.filter((e) => e.kind === "reference").length,
    referencesOmitted: plan.manifest.entries.filter((e) => e.omissionReason === "input_budget").length,
    outputImagesSent: sent.filter((e) => e.kind !== "reference" && e.kind !== "video").length,
    requests: plan.batches.length,
  };
}

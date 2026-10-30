import { fingerprint } from "../../hash";
import { CUT_EDGE_POLICY, type CutCriterion } from "../sequence";
import { boundedDerivative, type PlannerAnalyzer } from "./plan";
import { DIRECT_VIDEO_MIMES } from "./temporal";
import {
  DEFAULT_ANALYSIS_BUDGET,
  isShotAnalysisMode,
  promptVersionFor,
  type AnalysisBatch,
  type AnalysisBudget,
  type AnalysisCriterion,
  type AnalysisMedia,
  type ContinuityAnalysisInput,
  type ContinuityAnalysisPlan,
  type ExternalMediaManifest,
  type ManifestEntry,
  type PlanItem,
  type ShotAnalysisMode,
} from "./types";

/**
 * Phase 3A.4D: the deterministic plan of a SEQUENCE (cut) analysis. Pure: same inputs ⇒ same plan and fingerprint.
 *
 * Only the semantic cut criteria of a `CutTransition` can become sequence batches, and only when ALL of these hold:
 *   1. the analyzer executes `sequence_transition` and declares the internal `cross_cut` capability;
 *   2. the criterion's family is one the analyzer is TRUSTED with (`crossCutFamilies`: calibration acceptance; empty
 *      for production Gemini in 3A.4D, so every production family stays unsupported). `cross_cut` alone never plans a
 *      family;
 *   3. the Project allows bounded cut-edge video to leave Prism (`direct_video_allowed`);
 *   4. both sides have their exact edge clip and edge still, within `cut-edge-static-v1` bounds.
 * Prism's `n_a`, deterministic and manual criteria are never submitted.
 */

/** Truthful reason for a family that has not been accepted by a calibration gate. */
export const NOT_CALIBRATED_SEQUENCE_REASON =
  "Sequence continuity for this family has not passed calibration yet.";

/** Bounds of one derived cut-edge clip (a normal v1 clip is ≤ 2 s; the frame-boundary slack is bounded here). */
export const CUT_EDGE_CLIP_LIMITS = { maxDurationMs: 3000, maxBytes: 20 * 1024 * 1024 } as const;

/** The four edge inputs of a cut, in prompt order: the two clips, then the two exact edge stills. */
export const EDGE_INPUT_IDS = ["left:clip", "right:clip", "left:last", "right:first"] as const;

export interface SequencePlanInput {
  analyzer: PlannerAnalyzer;
  /** the cut's criteria exactly as `buildEpisodeCuts` produced them */
  criteria: readonly CutCriterion[];
  /** the edge media (`left:clip` …) and the sided references (`ref:left:…`) */
  media: AnalysisMedia[];
  /** reference input id → the criterion keys that reference may serve (`CutReference.usedBy`) */
  referenceUses: Readonly<Record<string, readonly string[]>>;
  /** the Project allows bounded cut-edge video to leave Prism (`direct_video_allowed`) */
  directVideoAllowed: boolean;
  budget?: AnalysisBudget;
}

/** A cut criterion as the analyzer sees it (capability `cross_cut`, its family attached). */
export const toSequenceCriterion = (c: CutCriterion): AnalysisCriterion | null =>
  c.handler === "analyzer" && c.family && c.applicability === "applies"
    ? {
        key: c.key,
        category: c.category,
        severity: c.severity,
        title: c.title,
        sourceRef: c.sourceRef,
        expected: c.expected,
        capability: "cross_cut",
        family: c.family,
      }
    : null;

/** Why a side's edge media cannot be sent (null = eligible). Checked BEFORE any transport and again by the worker. */
export function edgeMediaProblem(media: readonly AnalysisMedia[], side: "left" | "right"): string | null {
  const clip = media.find((m) => m.inputId === `${side}:clip`);
  const still = media.find((m) => m.inputId === (side === "left" ? "left:last" : "right:first"));
  if (!clip || !still) return `The ${side} side has no cut-edge media.`;
  if (!clip.mime || !(DIRECT_VIDEO_MIMES as readonly string[]).includes(clip.mime))
    return `The ${side} edge clip format (${clip.mime ?? "unknown"}) is not supported.`;
  if (clip.durationMs == null || !Number.isFinite(clip.durationMs) || clip.durationMs <= 0)
    return `The ${side} edge clip's duration is unknown.`;
  if (clip.durationMs > CUT_EDGE_CLIP_LIMITS.maxDurationMs)
    return `The ${side} edge clip is longer than ${CUT_EDGE_CLIP_LIMITS.maxDurationMs / 1000} s.`;
  if (clip.byteSize == null || clip.byteSize > CUT_EDGE_CLIP_LIMITS.maxBytes)
    return `The ${side} edge clip is larger than ${CUT_EDGE_CLIP_LIMITS.maxBytes / 1024 / 1024} MB.`;
  if (!clip.checksum || !still.checksum)
    return `The ${side} edge media has no recorded checksum, so Prism cannot prove which file would be sent.`;
  return null;
}

export function buildSequencePlan(input: SequencePlanInput): ContinuityAnalysisPlan {
  const budget = input.budget ?? DEFAULT_ANALYSIS_BUDGET;
  const { analyzer } = input;
  const executes =
    analyzer.modes.includes("sequence_transition") && analyzer.capabilities.includes("cross_cut");
  const trusted = new Set(analyzer.crossCutFamilies ?? []);
  const mediaProblem = edgeMediaProblem(input.media, "left") ?? edgeMediaProblem(input.media, "right");
  const items: PlanItem[] = [];
  const planned: Array<{ c: AnalysisCriterion; refs: AnalysisMedia[]; omitted: AnalysisMedia[] }> = [];

  for (const c of input.criteria) {
    const base = { criterionKey: c.key, batchId: null as string | null };
    if (c.handler === "deterministic") {
      items.push({
        ...base,
        status: "deterministic",
        mode: null,
        capability: null,
        reason: "Answered by Prism's cut checks (no AI).",
      });
      continue;
    }
    if (c.applicability === "n_a") {
      items.push({
        ...base,
        status: "not_applicable",
        mode: null,
        capability: null,
        reason: "Does not apply to this cut (Prism's decision).",
      });
      continue;
    }
    const ac = toSequenceCriterion(c);
    if (!ac) {
      items.push({
        ...base,
        status: "manual",
        mode: null,
        capability: null,
        reason: "Only a person can judge this criterion.",
      });
      continue;
    }
    const at = { ...base, mode: "sequence_transition" as const, capability: "cross_cut" as const };
    if (!executes) {
      items.push({
        ...at,
        status: "unsupported",
        reason: `${analyzer.id} does not offer Sequence Continuity analysis here: this criterion stays unchecked (never inferred as pass).`,
      });
      continue;
    }
    if (!trusted.has(c.family!)) {
      items.push({ ...at, status: "unsupported", reason: NOT_CALIBRATED_SEQUENCE_REASON });
      continue;
    }
    if (!input.directVideoAllowed) {
      items.push({
        ...at,
        status: "not_allowed",
        reason:
          "The Project has not allowed bounded cut-edge video to leave Prism (Shot QA settings). Stays unchecked.",
      });
      continue;
    }
    if (mediaProblem) {
      items.push({ ...at, status: "no_media", reason: mediaProblem });
      continue;
    }
    const ranked = input.media
      .filter((m) => m.kind === "reference" && (input.referenceUses[m.inputId] ?? []).includes(c.key))
      .sort((a, b) => (a.side ?? "").localeCompare(b.side ?? "") || a.inputId.localeCompare(b.inputId));
    const refs = ranked.slice(0, budget.maxReferencesPerBatch);
    planned.push({ c: ac, refs, omitted: ranked.slice(budget.maxReferencesPerBatch) });
    items.push({
      ...at,
      status: "planned",
      reason: `Analysed from both cut-edge clips, both edge stills and ${refs.length} sided reference(s).`,
    });
  }

  // ── batching: criteria with IDENTICAL inputs share one request, capped per batch ──
  const groups = new Map<string, typeof planned>();
  for (const p of planned) {
    const key = p.refs.map((r) => r.inputId).join(",");
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const batches: AnalysisBatch[] = [];
  let n = 0;
  for (const [, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (let i = 0; i < group.length; i += budget.maxCriteriaPerBatch) {
      const slice = group.slice(i, i + budget.maxCriteriaPerBatch);
      n += 1;
      batches.push({
        id: `b${n}`,
        mode: "sequence_transition",
        promptVersion: promptVersionFor(analyzer.id, "sequence_transition"),
        criterionKeys: slice.map((s) => s.c.key),
        referenceInputIds: slice[0]!.refs.map((r) => r.inputId),
        outputInputIds: [...EDGE_INPUT_IDS],
        omittedReferenceInputIds: slice[0]!.omitted.map((r) => r.inputId),
        sampling: { policy: CUT_EDGE_POLICY.id, fps: CUT_EDGE_POLICY.fps },
      });
    }
  }
  for (const b of batches)
    for (const k of b.criterionKeys) items.find((it) => it.criterionKey === k)!.batchId = b.id;

  const semantic = items.filter((i) => i.mode === "sequence_transition");
  const edgeOmission: ManifestEntry["omissionReason"] = semantic.some((i) => i.status === "not_allowed")
    ? "sequence_video_not_allowed"
    : semantic.length > 0 && semantic.every((i) => i.status === "unsupported")
      ? "sequence_not_calibrated"
      : "no_matching_criterion";
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
        : m.kind !== "reference"
          ? edgeOmission
          : batches.some((b) => b.omittedReferenceInputIds.includes(m.inputId))
            ? ("input_budget" as const)
            : semantic.some((i) => i.status === "planned")
              ? ("no_matching_criterion" as const)
              : edgeOmission,
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

// ───────────────────────── execution identity (worker) ─────────────────────────

export type ExecutionIdentity =
  | { ok: true; subject: "attempt"; mode: ShotAnalysisMode }
  | { ok: true; subject: "transition"; mode: "sequence_transition" }
  | { ok: false; code: "mixed_modes" | "subject_mode_mismatch"; message: string };

/**
 * The ONE execution identity of a frozen input, derived from its plan's batch modes and its subject (never from the
 * provider, the media count or the subject kind alone). A Shot input may only carry Shot modes (image_set and
 * direct_video share one analyzer version); a transition input only `sequence_transition` batches. Anything else is
 * refused locally, before any media is loaded or any transport is touched.
 */
export function executionIdentity(input: ContinuityAnalysisInput): ExecutionIdentity {
  const modes = [...new Set(input.plan.batches.map((b) => b.mode))];
  if (input.subjectKind === "transition") {
    if (modes.some((m) => m !== "sequence_transition"))
      return {
        ok: false,
        code: "subject_mode_mismatch",
        message: "A transition analysis may only carry sequence-transition batches; nothing was sent.",
      };
    return { ok: true, subject: "transition", mode: "sequence_transition" };
  }
  if (modes.some((m) => !isShotAnalysisMode(m)))
    return {
      ok: false,
      code: modes.length > 1 ? "mixed_modes" : "subject_mode_mismatch",
      message: "A Shot analysis may not carry sequence-transition batches; nothing was sent.",
    };
  const shot = modes.filter(isShotAnalysisMode);
  return { ok: true, subject: "attempt", mode: shot.includes("direct_video") ? "direct_video" : "image_set" };
}

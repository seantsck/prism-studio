import { buildShotContext, shotOrder, type ShotContext } from "@/domain/context";
import { layoutPerformance } from "@/domain/duration";
import { computeShotParts } from "@/domain/fingerprint";
import { isShotOutputAttempt } from "@/domain/generation/schemas";
import type { Asset, GenerationAttempt, ProjectData } from "@/domain/schemas";
import { editRateFromFps, type EditRate } from "./edit-rate";
import { videoSourceViolations, type EditMediaFacts } from "./eligibility";
import {
  itemDurationMs,
  type AudioPlacement,
  type PlacementBasis,
  type SourceAudio,
  type VisualSource,
} from "./model";

/**
 * Phase 2I.1 initial assembly PROPOSAL: what Prism suggests for an Episode edit, with the reason for every choice.
 * A proposal is never an editorial decision: nothing is persisted here and nothing follows Best. Creating the edit
 * from it (2I.1B/C) is the explicit human act; after that the edit owns its order, sources and trims.
 *
 * Rules (docs/timeline-performance-assembly.md):
 *   order    the Sequence Board order (`shotOrder` within the Episode)
 *   picture  the Shot's APPROVED clip (its selected delivery master if usable, else its primary output); without one,
 *            a labelled placeholder: the selected Production Frame, else the approved Storyboard, else none
 *   trim     a clip plays from 0 to min(clip duration, planned Shot duration); it is never stretched or padded
 *   audio    the Shot's currently selected takes, laid out by `layoutPerformance`, clipped to the item (2I.1 keeps
 *            placements inside their item); the clip's own audio muted
 */

/** Used only when a placeholder still has nothing to hold for (no planned duration): said so, never silent. */
export const PLACEHOLDER_FALLBACK_MS = 3000;

export type VisualProposalReason =
  | "approved_clip_delivery_master"
  | "approved_clip_primary_output"
  | "placeholder_production_frame"
  | "placeholder_storyboard"
  | "no_source";

export const VISUAL_PROPOSAL_TEXT: Record<VisualProposalReason, string> = {
  approved_clip_delivery_master: "The Shot's approved clip, as its selected delivery master.",
  approved_clip_primary_output:
    "The Shot's approved clip, as its provider output (no delivery master selected).",
  placeholder_production_frame:
    "No approved clip yet: the selected Production Frame, as a placeholder still.",
  placeholder_storyboard:
    "No approved clip or Production Frame yet: the approved Storyboard, as a placeholder still.",
  no_source: "Nothing to show yet: an explicit empty slot.",
};

export type ProposalNote =
  | { code: "best_not_followed"; attemptId: string }
  | { code: "approved_clip_unusable"; attemptId: string }
  | { code: "clip_shorter_than_planned"; shortByMs: number }
  | { code: "planned_duration_unset"; fallbackMs: number }
  | { code: "missing_take"; dialogueLineId: string }
  | { code: "take_clipped_to_item"; dialogueLineId: string }
  | { code: "take_outside_item"; dialogueLineId: string };

export interface ProposedItem {
  shotId: string;
  visual: VisualSource;
  visualReason: VisualProposalReason;
  sourceAudio: SourceAudio;
  performance: AudioPlacement[];
  performanceBasis: PlacementBasis;
  notes: ProposalNote[];
}

export interface EditProposal {
  episodeId: string;
  editRate: EditRate;
  /** false when the project's frame rate is not a supported edit rate (24 fps used, said so). */
  editRateExact: boolean;
  items: ProposedItem[];
}

/** The Shot's approved Shot-output attempt (approval is one per Shot), if any. */
export function approvedClipAttempt(
  data: Pick<ProjectData, "attempts">,
  shotId: string,
): GenerationAttempt | null {
  return (
    data.attempts.find(
      (a) => a.shotId === shotId && a.approved && a.status === "succeeded" && isShotOutputAttempt(a),
    ) ?? null
  );
}

/**
 * The exact Asset Prism proposes for an attempt: its selected delivery master when that is a usable video, else its
 * primary output. Null when neither is placeable (the reason is the caller's note).
 */
export function preferredClipAsset(
  data: Pick<ProjectData, "project" | "attempts" | "assets">,
  attempt: GenerationAttempt,
  media: EditMediaFacts,
): { asset: Asset; reason: "approved_clip_delivery_master" | "approved_clip_primary_output" } | null {
  const facts = media.attempts.get(attempt.id);
  const usable = (assetId: string | null | undefined) => {
    const asset = assetId ? data.assets.find((a) => a.id === assetId) : undefined;
    if (!asset?.durationMs) return null;
    const probe = {
      kind: "video" as const,
      attemptId: attempt.id,
      assetId: asset.id,
      sourceInMs: 0,
      sourceOutMs: 1,
    };
    return videoSourceViolations(data, attempt.shotId, probe, media).length === 0 ? asset : null;
  };
  const master = usable(facts?.deliveryAssetId);
  if (master) return { asset: master, reason: "approved_clip_delivery_master" };
  const primary = usable(facts?.outputs.find((o) => o.role === "primary")?.assetId);
  return primary ? { asset: primary, reason: "approved_clip_primary_output" } : null;
}

/** The Shot's selected takes laid out exactly as the Shot timeline lays them, clipped to an item of `durationMs`. */
export function proposePerformance(
  ctx: ShotContext,
  durationMs: number,
): { placements: AudioPlacement[]; notes: ProposalNote[] } {
  const lines = ctx.lines;
  const layout = layoutPerformance(
    ctx.shot.audio.preRollMs,
    ctx.shot.audio.interLineGapMs,
    lines.map((l) => l.selectedTake?.durationMs ?? null),
  );
  const placements: AudioPlacement[] = [];
  const notes: ProposalNote[] = [];
  lines.forEach((l, i) => {
    const seg = layout.segments[i];
    if (!seg || !l.selectedTake) {
      notes.push({ code: "missing_take", dialogueLineId: l.line.id });
      return;
    }
    if (seg.startMs >= durationMs) {
      notes.push({ code: "take_outside_item", dialogueLineId: l.line.id });
      return;
    }
    const playable = Math.min(seg.durationMs, durationMs - seg.startMs);
    if (playable < seg.durationMs) notes.push({ code: "take_clipped_to_item", dialogueLineId: l.line.id });
    placements.push({
      dialogueLineId: l.line.id,
      takeId: l.selectedTake.id,
      startMs: seg.startMs,
      takeInMs: 0,
      takeOutMs: playable,
    });
  });
  return { placements, notes };
}

export function proposeShotItem(data: ProjectData, shotId: string, media: EditMediaFacts): ProposedItem {
  const ctx = buildShotContext(data, shotId);
  const planned = ctx.duration.durationMs;
  const notes: ProposalNote[] = [];
  let visual: VisualSource;
  let visualReason: VisualProposalReason;

  const approved = approvedClipAttempt(data, shotId);
  const clip = approved ? preferredClipAsset(data, approved, media) : null;
  if (approved && !clip) notes.push({ code: "approved_clip_unusable", attemptId: approved.id });
  if (approved && clip) {
    const clipMs = clip.asset.durationMs!;
    const out = planned > 0 ? Math.min(clipMs, planned) : clipMs;
    visual = {
      kind: "video",
      attemptId: approved.id,
      assetId: clip.asset.id,
      sourceInMs: 0,
      sourceOutMs: out,
    };
    visualReason = clip.reason;
    if (planned > clipMs) notes.push({ code: "clip_shorter_than_planned", shortByMs: planned - clipMs });
  } else {
    const holdMs = planned > 0 ? planned : PLACEHOLDER_FALLBACK_MS;
    if (planned <= 0) notes.push({ code: "planned_duration_unset", fallbackMs: PLACEHOLDER_FALLBACK_MS });
    if (ctx.selectedProductionFrame) {
      visual = {
        kind: "production_frame",
        productionFrameId: ctx.selectedProductionFrame.id,
        durationMs: holdMs,
      };
      visualReason = "placeholder_production_frame";
    } else if (ctx.approvedFrame) {
      visual = { kind: "storyboard_frame", storyboardFrameId: ctx.approvedFrame.id, durationMs: holdMs };
      visualReason = "placeholder_storyboard";
    } else {
      visual = { kind: "none", durationMs: holdMs };
      visualReason = "no_source";
    }
  }
  // Best is advisory: when it names a clip other than the proposed one, say so; never pick it
  for (const b of media.bestPointers)
    if (b.shotId === shotId && b.attemptId && b.attemptId !== approved?.id)
      notes.push({ code: "best_not_followed", attemptId: b.attemptId });

  const perf = proposePerformance(ctx, itemDurationMs(visual));
  const parts = computeShotParts(ctx);
  return {
    shotId,
    visual,
    visualReason,
    sourceAudio: "muted",
    performance: perf.placements,
    performanceBasis: { performance: parts.performance, timing: parts.timing },
    notes: [...notes, ...perf.notes],
  };
}

/** One proposed item per Shot of the Episode, in Sequence Board order. Pure: persists nothing. */
export function proposeEpisodeAssembly(
  data: ProjectData,
  episodeId: string,
  media: EditMediaFacts,
): EditProposal {
  const { rate, exact } = editRateFromFps(data.bible.defaultFrameRate);
  const shots = data.shots.filter((s) => s.episodeId === episodeId).sort(shotOrder(data));
  return {
    episodeId,
    editRate: rate,
    editRateExact: exact,
    items: shots.map((s) => proposeShotItem(data, s.id, media)),
  };
}

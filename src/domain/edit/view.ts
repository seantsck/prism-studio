import { buildShotContext, shotOrder, type ShotContext } from "@/domain/context";
import { selectedTake } from "@/domain/duration";
import { computeShotParts, storyboardFreshness } from "@/domain/fingerprint";
import { animationFreshness, type AnimationFreshness } from "@/domain/generation/animation";
import { parseGenerationPurpose, type GenerationPurpose } from "@/domain/generation/schemas";
import { PRODUCTION_FRAME_REFERENCE } from "@/domain/generated-production-frame";
import { productionFrameFreshness, type ProductionFrameFreshness } from "@/domain/production-frame";
import type { ProjectData } from "@/domain/schemas";
import { frameAtMs, type EditRate } from "./edit-rate";
import {
  attemptAssetRole,
  itemSourceViolations,
  type AttemptAssetRole,
  type EditMediaFacts,
} from "./eligibility";
import { itemDurationMs, type EditItem, type EpisodeEdit, type VisualSource } from "./model";
import { approvedClipAttempt, preferredClipAsset } from "./proposal";

/**
 * Phase 2I.1 read side: where every item sits, which Scene runs the order forms, and what is true NOW about each
 * pinned source. Pure and derived on every read (the existing freshness pattern); nothing here mutates the edit. An
 * item keeps playing exactly what it pins until an explicit editorial action changes it.
 */

// ───────────────────────── timing ─────────────────────────

export interface ItemTiming {
  startMs: number;
  endMs: number;
  durationMs: number;
  /** frames of the ABSOLUTE positions (never a rounded duration added up) */
  startFrame: number;
  endFrame: number;
}

/**
 * Contiguous placement: the first item starts at 0, each next item at the previous end, all in exact integer ms.
 * Frames are derived per absolute position, so the frame of any instant is the same however the edit before it is cut:
 * there is no per-item rounding to accumulate.
 */
export function editTiming(items: readonly Pick<EditItem, "visual">[], rate: EditRate) {
  let cursor = 0;
  const timings: ItemTiming[] = items.map((item) => {
    const durationMs = itemDurationMs(item.visual);
    const t = {
      startMs: cursor,
      endMs: cursor + durationMs,
      durationMs,
      startFrame: frameAtMs(cursor, rate),
      endFrame: frameAtMs(cursor + durationMs, rate),
    };
    cursor = t.endMs;
    return t;
  });
  return { timings, totalMs: cursor, totalFrames: frameAtMs(cursor, rate) };
}

// ───────────────────────── Scene runs ─────────────────────────

/**
 * A maximal run of consecutive items whose Shots belong to one Scene. A Scene the edit intercuts or revisits has
 * several runs (`occurrence` 1, 2, …): runs are derived from the item order, never assumed contiguous.
 */
export interface SceneRun {
  sceneId: string;
  occurrence: number;
  firstIndex: number;
  lastIndex: number;
  startMs: number;
  endMs: number;
}

export function sceneRuns(
  sceneIds: readonly string[],
  timings: readonly Pick<ItemTiming, "startMs" | "endMs">[],
): SceneRun[] {
  const runs: SceneRun[] = [];
  const seen = new Map<string, number>();
  sceneIds.forEach((sceneId, i) => {
    const last = runs.at(-1);
    if (last && last.sceneId === sceneId) {
      last.lastIndex = i;
      last.endMs = timings[i].endMs;
      return;
    }
    const occurrence = (seen.get(sceneId) ?? 0) + 1;
    seen.set(sceneId, occurrence);
    runs.push({
      sceneId,
      occurrence,
      firstIndex: i,
      lastIndex: i,
      startMs: timings[i].startMs,
      endMs: timings[i].endMs,
    });
  });
  return runs;
}

// ───────────────────────── facts ─────────────────────────

export interface VideoFacts {
  kind: "video";
  /** every eligibility rule still holds for the pinned attempt + Asset + trim */
  usable: boolean;
  violations: string[];
  purpose: GenerationPurpose | null;
  /** the pinned attempt is the Shot's approved clip */
  approved: boolean;
  /** the Shot's approved clip now, when it is NOT the pinned attempt */
  approvedElsewhereAttemptId: string | null;
  /** the pinned attempt is the current Best of a set */
  isBest: boolean;
  /** current Best of the Shot's sets naming another clip (advisory, never followed) */
  bestElsewhereAttemptIds: string[];
  assetRole: AttemptAssetRole | null;
  /** the pinned attempt's selected delivery master, when it is not the pinned Asset */
  newerDeliveryMasterAssetId: string | null;
  /** generated from the Shot's current truth? (incl. the selected Production Frame, 2H) */
  freshness: AnimationFreshness;
  productionFrameChanged: boolean;
}

export interface PlaceholderFacts {
  kind: "production_frame" | "storyboard_frame" | "none";
  usable: boolean;
  violations: string[];
  /** production_frame: the pinned frame is no longer the Shot's selected one */
  selectionChanged: boolean;
  freshness: ProductionFrameFreshness | { status: string; messages: string[] } | null;
  /** the Shot now has an approved clip this placeholder could become */
  clipAvailableAttemptId: string | null;
}

export type PlacementState =
  "current" | "take_superseded" | "take_archived" | "line_removed" | "take_missing";

export interface PlacementFacts {
  dialogueLineId: string;
  takeId: string;
  state: PlacementState;
  /** the line's selected take now, when it differs from the pinned one */
  selectedTakeId: string | null;
}

export interface PerformanceFacts {
  placements: PlacementFacts[];
  /** lines of the Shot with a selected take but no placement in this item (the editor chose silence, or not yet) */
  unplacedLineIds: string[];
  /** lines of the Shot with no selected take (silence by absence) */
  missingTakeLineIds: string[];
  /** the Shot's performance / planned timing changed since the performance was placed (unknown without a basis) */
  performanceChanged: boolean | null;
  plannedTimingChanged: boolean | null;
}

export interface DurationFacts {
  itemMs: number;
  plannedMs: number;
  /** item − planned (negative: the chosen source is shorter than planned; nothing is stretched) */
  deltaMs: number;
}

export type ReplacementReason = "approval_moved" | "delivery_master_changed" | "clip_available";

export interface Replacement {
  reason: ReplacementReason;
  /** what an explicit "Use replacement" would pin (never applied here) */
  visual: Extract<VisualSource, { kind: "video" }>;
}

export interface ItemView {
  item: EditItem;
  index: number;
  timing: ItemTiming;
  sceneId: string | null;
  inEpisode: boolean;
  visual: VideoFacts | PlaceholderFacts;
  performance: PerformanceFacts;
  duration: DurationFacts;
  replacement: Replacement | null;
}

export interface EpisodeEditView {
  edit: EpisodeEdit;
  items: ItemView[];
  totalMs: number;
  totalFrames: number;
  sceneRuns: SceneRun[];
  /** edit order vs the Sequence Board order of the Shots in the edit (reported, never applied) */
  orderDiffersFromSequence: boolean;
  sequenceShotIds: string[];
  /** Shots of the Episode that are not in the edit */
  notInEditShotIds: string[];
}

function videoFacts(
  data: ProjectData,
  ctx: ShotContext,
  item: EditItem,
  visual: Extract<VisualSource, { kind: "video" }>,
  media: EditMediaFacts,
): VideoFacts {
  const attempt = data.attempts.find((a) => a.id === visual.attemptId);
  const violations = itemSourceViolations(data, { ...item, performance: [] }, media);
  const approvedNow = approvedClipAttempt(data, item.shotId);
  const best = media.bestPointers.filter((b) => b.shotId === item.shotId && b.attemptId);
  const facts = media.attempts.get(visual.attemptId);
  const master = facts?.deliveryAssetId ?? null;
  const freshness: AnimationFreshness = attempt
    ? animationFreshness(ctx, attempt)
    : { status: "unknown", changed: [], messages: ["The generation attempt no longer exists."] };
  return {
    kind: "video",
    usable: violations.length === 0,
    violations,
    purpose: attempt ? parseGenerationPurpose(attempt.request?.purpose) : null,
    approved: approvedNow?.id === visual.attemptId,
    approvedElsewhereAttemptId: approvedNow && approvedNow.id !== visual.attemptId ? approvedNow.id : null,
    isBest: best.some((b) => b.attemptId === visual.attemptId),
    bestElsewhereAttemptIds: [
      ...new Set(best.filter((b) => b.attemptId !== visual.attemptId).map((b) => b.attemptId!)),
    ],
    assetRole: attemptAssetRole(facts, visual.assetId),
    newerDeliveryMasterAssetId: master && master !== visual.assetId ? master : null,
    freshness,
    productionFrameChanged: freshness.changed.includes(PRODUCTION_FRAME_REFERENCE),
  };
}

function placeholderFacts(
  data: ProjectData,
  ctx: ShotContext,
  item: EditItem,
  visual: Exclude<VisualSource, { kind: "video" }>,
): PlaceholderFacts {
  const violations = itemSourceViolations(
    data,
    { ...item, performance: [] },
    { attempts: new Map(), bestPointers: [] },
  );
  const approved = approvedClipAttempt(data, item.shotId);
  let selectionChanged = false;
  let freshness: PlaceholderFacts["freshness"] = null;
  if (visual.kind === "production_frame") {
    const frame = ctx.productionFrames.find((f) => f.id === visual.productionFrameId) ?? null;
    selectionChanged = ctx.selectedProductionFrame?.id !== visual.productionFrameId;
    freshness = frame ? productionFrameFreshness(ctx, frame) : null;
  } else if (visual.kind === "storyboard_frame") {
    const frame = ctx.frames.find((f) => f.id === visual.storyboardFrameId) ?? null;
    freshness = frame?.approved ? storyboardFreshness(ctx, frame) : null;
  }
  return {
    kind: visual.kind,
    usable: violations.length === 0,
    violations,
    selectionChanged,
    freshness,
    clipAvailableAttemptId: approved?.id ?? null,
  };
}

function performanceFacts(data: ProjectData, ctx: ShotContext, item: EditItem): PerformanceFacts {
  const shotLineIds = new Set(ctx.shot.audio.dialogueLineIds);
  const placements = item.performance.map<PlacementFacts>((p) => {
    const take = data.takes.find((t) => t.id === p.takeId);
    const selected = selectedTake(data.takes, p.dialogueLineId);
    const lineExists = data.dialogueLines.some((l) => l.id === p.dialogueLineId);
    const state: PlacementState = !take
      ? "take_missing"
      : !lineExists || !shotLineIds.has(p.dialogueLineId)
        ? "line_removed"
        : selected?.id !== p.takeId
          ? take.archived && !selected
            ? "take_archived"
            : "take_superseded"
          : "current";
    return {
      dialogueLineId: p.dialogueLineId,
      takeId: p.takeId,
      state,
      selectedTakeId: selected && selected.id !== p.takeId ? selected.id : null,
    };
  });
  const placed = new Set(item.performance.map((p) => p.dialogueLineId));
  const parts = item.performanceBasis ? computeShotParts(ctx) : null;
  return {
    placements,
    unplacedLineIds: ctx.lines.filter((l) => l.selectedTake && !placed.has(l.line.id)).map((l) => l.line.id),
    missingTakeLineIds: ctx.lines.filter((l) => !l.selectedTake).map((l) => l.line.id),
    performanceChanged: parts ? parts.performance !== item.performanceBasis!.performance : null,
    plannedTimingChanged: parts ? parts.timing !== item.performanceBasis!.timing : null,
  };
}

/**
 * What an explicit "Use replacement" would pin, if anything (pure; never applied):
 *   approval_moved           the Shot's approved clip is another attempt than the pinned one
 *   delivery_master_changed  same attempt, but its selected delivery master is not the pinned Asset
 *   clip_available           a placeholder / empty item whose Shot now has an approved clip
 * The proposed trim keeps the item's current duration when the new clip is long enough (else the clip's length).
 */
export function replacementFor(data: ProjectData, item: EditItem, media: EditMediaFacts): Replacement | null {
  const approved = approvedClipAttempt(data, item.shotId);
  if (!approved) return null;
  const clip = preferredClipAsset(data, approved, media);
  if (!clip) return null;
  const v = item.visual;
  const reason: ReplacementReason | null =
    v.kind !== "video"
      ? "clip_available"
      : v.attemptId !== approved.id
        ? "approval_moved"
        : v.assetId !== clip.asset.id && clip.reason === "approved_clip_delivery_master"
          ? "delivery_master_changed"
          : null;
  if (!reason) return null;
  const out = Math.min(clip.asset.durationMs!, itemDurationMs(v));
  return {
    reason,
    visual: {
      kind: "video",
      attemptId: approved.id,
      assetId: clip.asset.id,
      sourceInMs: 0,
      sourceOutMs: out,
    },
  };
}

export function buildEpisodeEditView(
  data: ProjectData,
  edit: EpisodeEdit,
  media: EditMediaFacts,
): EpisodeEditView {
  const { timings, totalMs, totalFrames } = editTiming(edit.items, edit.editRate);
  const shots = new Map(data.shots.map((s) => [s.id, s]));
  const episodeShots = data.shots.filter((s) => s.episodeId === edit.episodeId).sort(shotOrder(data));
  const inEdit = new Set(edit.items.map((i) => i.shotId));

  const items = edit.items.map<ItemView>((item, index) => {
    const shot = shots.get(item.shotId);
    const inEpisode = shot?.episodeId === edit.episodeId;
    const timing = timings[index];
    if (!shot) {
      return {
        item,
        index,
        timing,
        sceneId: null,
        inEpisode: false,
        visual: {
          kind: item.visual.kind === "video" ? "none" : item.visual.kind,
          usable: false,
          violations: ["shot_not_found"],
          selectionChanged: false,
          freshness: null,
          clipAvailableAttemptId: null,
        },
        performance: {
          placements: [],
          unplacedLineIds: [],
          missingTakeLineIds: [],
          performanceChanged: null,
          plannedTimingChanged: null,
        },
        duration: { itemMs: timing.durationMs, plannedMs: 0, deltaMs: timing.durationMs },
        replacement: null,
      };
    }
    const ctx = buildShotContext(data, shot.id);
    const v = item.visual;
    return {
      item,
      index,
      timing,
      sceneId: shot.sceneId,
      inEpisode,
      visual:
        v.kind === "video" ? videoFacts(data, ctx, item, v, media) : placeholderFacts(data, ctx, item, v),
      performance: performanceFacts(data, ctx, item),
      duration: {
        itemMs: timing.durationMs,
        plannedMs: ctx.duration.durationMs,
        deltaMs: timing.durationMs - ctx.duration.durationMs,
      },
      replacement: replacementFor(data, item, media),
    };
  });

  const sequenceShotIds = episodeShots.filter((s) => inEdit.has(s.id)).map((s) => s.id);
  const editShotIds = edit.items
    .filter((i) => shots.get(i.shotId)?.episodeId === edit.episodeId)
    .map((i) => i.shotId);
  return {
    edit,
    items,
    totalMs,
    totalFrames,
    sceneRuns: sceneRuns(
      items.map((i) => i.sceneId ?? "(missing)"),
      timings,
    ),
    orderDiffersFromSequence: editShotIds.some((id, i) => sequenceShotIds[i] !== id),
    sequenceShotIds,
    notInEditShotIds: episodeShots.filter((s) => !inEdit.has(s.id)).map((s) => s.id),
  };
}

// ───────────────────────── lineage ─────────────────────────

export type LineageStep =
  | { step: "shot"; shotId: string; shotCode: string }
  | { step: "attempt"; attemptId: string; attemptNumber: number; model: string; purpose: GenerationPurpose }
  | { step: "asset"; assetId: string; role: AttemptAssetRole | null; isCurrentDeliveryMaster: boolean }
  | { step: "derived_from"; assetId: string; version: number }
  | { step: "production_frame"; productionFrameId: string; version: number | null; assetId: string | null }
  | { step: "storyboard_frame"; storyboardFrameId: string; version: number | null; assetId: string | null }
  | { step: "none" };

export interface PlacementLineage {
  dialogueLineId: string;
  speaker: string | null;
  takeId: string;
  takeNumber: number | null;
  sourceType: string | null;
  audioAssetId: string | null;
}

/**
 * Where an item's picture and sound come from, followed through references only (nothing copied):
 *   Shot → attempt → exact Asset (→ the provider output it was derived from, for a delivery version)
 *   dialogue line → take → audio Asset
 */
export function editItemLineage(
  data: ProjectData,
  item: EditItem,
  media: EditMediaFacts,
): { picture: LineageStep[]; audio: PlacementLineage[] } {
  const shot = data.shots.find((s) => s.id === item.shotId);
  const picture: LineageStep[] = shot ? [{ step: "shot", shotId: shot.id, shotCode: shot.shotCode }] : [];
  const v = item.visual;
  if (v.kind === "video") {
    const attempt = data.attempts.find((a) => a.id === v.attemptId);
    if (attempt)
      picture.push({
        step: "attempt",
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        model: attempt.model,
        purpose: parseGenerationPurpose(attempt.request?.purpose),
      });
    const facts = media.attempts.get(v.attemptId);
    picture.push({
      step: "asset",
      assetId: v.assetId,
      role: attemptAssetRole(facts, v.assetId),
      isCurrentDeliveryMaster: facts?.deliveryAssetId === v.assetId,
    });
    const derived = facts?.deliveryVersions.find((d) => d.assetId === v.assetId);
    if (derived)
      picture.push({ step: "derived_from", assetId: derived.parentAssetId, version: derived.version });
  } else if (v.kind === "production_frame") {
    const f = (data.productionFrames ?? []).find((x) => x.id === v.productionFrameId);
    picture.push({
      step: "production_frame",
      productionFrameId: v.productionFrameId,
      version: f?.version ?? null,
      assetId: f?.assetId ?? null,
    });
  } else if (v.kind === "storyboard_frame") {
    const f = data.frames.find((x) => x.id === v.storyboardFrameId);
    picture.push({
      step: "storyboard_frame",
      storyboardFrameId: v.storyboardFrameId,
      version: f?.version ?? null,
      assetId: f?.assetId ?? null,
    });
  } else picture.push({ step: "none" });

  const audio = item.performance.map<PlacementLineage>((p) => {
    const line = data.dialogueLines.find((l) => l.id === p.dialogueLineId);
    const take = data.takes.find((t) => t.id === p.takeId);
    const character = line?.characterId ? data.characters.find((c) => c.id === line.characterId) : null;
    return {
      dialogueLineId: p.dialogueLineId,
      speaker: character?.name ?? line?.speakerLabel ?? null,
      takeId: p.takeId,
      takeNumber: take?.takeNumber ?? null,
      sourceType: take?.sourceType ?? null,
      audioAssetId: take?.audioAssetId ?? null,
    };
  });
  return { picture, audio };
}

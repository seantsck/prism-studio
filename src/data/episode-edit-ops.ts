import { cutIntentProblem, type CutIntent } from "@/domain/continuity/cut-intent";
import { isEditRate } from "@/domain/edit/edit-rate";
import {
  placeholderViolations,
  placementViolations,
  VIDEO_SOURCE_VIOLATION_TEXT,
  videoSourceViolations,
  type ClipSourceData,
  type EditMediaFacts,
  type VideoSourceViolation,
} from "@/domain/edit/eligibility";
import {
  editShapeViolations,
  itemDurationMs,
  type AudioPlacement,
  type EditItem,
  type EditShapeViolation,
  type EpisodeEdit,
  type PlacementBasis,
  type VisualSource,
} from "@/domain/edit/model";
import { approvedClipAttempt, preferredClipAsset } from "@/domain/edit/proposal";
import type { ProductionFrame } from "@/domain/production-frame";
import type { PerformanceTake, StoryboardFrame } from "@/domain/schemas";
import {
  EpisodeEditError,
  REPLACEMENT_CHANGED_MESSAGE,
  SHOT_ALREADY_IN_EDIT_MESSAGE,
  SHOT_NOT_IN_EPISODE_MESSAGE,
  type EditOp,
  type NewEditItem,
} from "./episode-edit-repository";

/**
 * The op semantics and checks of the Episode edit repositories, shared by memory and Postgres so the two cannot drift.
 * A mutation is:
 *   1. `editRefs`         which rows the ops reference (each implementation loads exactly those, inside its unit)
 *   2. `applyEditOps`     the next edit state, in memory (pure; items keep their ids, positions are the array order)
 *   3. `assertEditValid`  the 2I.1 shape rules on the WHOLE next edit, then the source rules on every item whose
 *                         picture or performance the ops changed, using the domain checks (eligibility.ts)
 * after which the implementation writes the difference and bumps the revision. Unchanged items are not re-validated:
 * an edit only references immutable rows (attempts' creative fields, Assets, frames, takes), so what was valid when
 * placed stays valid, and Postgres re-checks every written row in its triggers anyway.
 */

/** What the ops of one mutation reference; the implementation loads these rows (and nothing else). */
export interface EditRefs {
  shotIds: string[];
  attemptIds: string[];
  assetIds: string[];
  storyboardFrameIds: string[];
  productionFrameIds: string[];
  takeIds: string[];
  /** Shots whose CURRENT approved clip is needed (`use_replacement`): load their approved attempts and its media. */
  replacementShotIds: string[];
}

/**
 * The loaded rows. Every list may contain rows of another project (the caller's RLS scope); the checks compare
 * `projectId`. `clip.attempts` holds the referenced attempts AND the approved attempts of `replacementShotIds`, with
 * their Assets (outputs and delivery versions) in `clip.assets` and their facts in `media`.
 */
export interface EditSourceFacts {
  shots: ReadonlyArray<{ id: string; projectId: string; episodeId: string }>;
  clip: Pick<ClipSourceData, "attempts" | "assets">;
  media: EditMediaFacts;
  storyboardFrames: ReadonlyArray<Pick<StoryboardFrame, "id" | "shotId" | "projectId">>;
  productionFrames: ReadonlyArray<Pick<ProductionFrame, "id" | "shotId" | "projectId">>;
  takes: ReadonlyArray<
    Pick<PerformanceTake, "id" | "dialogueLineId" | "durationMs" | "archived" | "projectId">
  >;
}

export interface PlannedEdit {
  next: EpisodeEdit;
  /** Items whose picture is new or changed (added, set_visual, use_replacement, trim, set_hold). */
  visualChanged: Set<string>;
  /** Items whose placements are new or changed (added, set_performance, clear_performance). */
  performanceChanged: Set<string>;
  /** 3A.4C: items whose incoming cut intent was cleared because their predecessor changed (never retargeted). */
  intentCleared: Set<string>;
}

/** Who declares a cut intent, and when: the authenticated user and the server's clock, never the request. */
export interface OpContext {
  userId: string | null;
  now: string;
}

export const CUT_INTENT_PREDECESSOR_CHANGED_MESSAGE =
  "This cut changed since you opened it (another item is now before it). Nothing was saved; reload and review the cut again.";

const uniq = (xs: Iterable<string>) => [...new Set(xs)];

/** Placements in one canonical order (start, then line) and shape: the order and shape Postgres reads back. */
const ordered = (placements: readonly AudioPlacement[]): AudioPlacement[] =>
  placements
    .map((p) => ({
      dialogueLineId: p.dialogueLineId,
      takeId: p.takeId,
      startMs: p.startMs,
      takeInMs: p.takeInMs,
      takeOutMs: p.takeOutMs,
    }))
    .sort(
      (a, b) =>
        a.startMs - b.startMs ||
        (a.dialogueLineId < b.dialogueLineId ? -1 : a.dialogueLineId > b.dialogueLineId ? 1 : 0),
    );

const basisOf = (b: PlacementBasis | null): PlacementBasis | null =>
  b ? { performance: b.performance, timing: b.timing } : null;

export function editRefs(current: Pick<EpisodeEdit, "items">, ops: readonly EditOp[]): EditRefs {
  const shots: string[] = [];
  const attempts: string[] = [];
  const assets: string[] = [];
  const storyboard: string[] = [];
  const production: string[] = [];
  const takes: string[] = [];
  const replacement: string[] = [];
  const visual = (v: NewEditItem["visual"]) => {
    if (v.kind === "video") {
      attempts.push(v.attemptId);
      assets.push(v.assetId);
    } else if (v.kind === "production_frame") production.push(v.productionFrameId);
    else if (v.kind === "storyboard_frame") storyboard.push(v.storyboardFrameId);
  };
  for (const op of ops) {
    if (op.op === "add") {
      shots.push(op.item.shotId);
      visual(op.item.visual);
      takes.push(...op.item.performance.map((p) => p.takeId));
    } else if (op.op === "set_visual") visual(op.visual);
    else if (op.op === "set_performance") takes.push(...op.placements.map((p) => p.takeId));
    else if (op.op === "use_replacement") {
      const item = current.items.find((i) => i.id === op.itemId);
      if (item) replacement.push(item.shotId);
    }
  }
  // a changed picture of an existing item re-checks its Shot; a trim / hold re-checks the picture it keeps (the pinned
  // clip against its Asset, the placeholder frame against its Shot)
  for (const op of ops) {
    if (op.op !== "set_visual" && op.op !== "use_replacement" && op.op !== "trim" && op.op !== "set_hold")
      continue;
    const item = current.items.find((i) => i.id === op.itemId);
    if (!item) continue;
    shots.push(item.shotId);
    if (op.op === "trim" || op.op === "set_hold") visual(item.visual);
  }
  return {
    shotIds: uniq(shots),
    attemptIds: uniq(attempts),
    assetIds: uniq(assets),
    storyboardFrameIds: uniq(storyboard),
    productionFrameIds: uniq(production),
    takeIds: uniq(takes),
    replacementShotIds: uniq(replacement),
  };
}

/**
 * The picture exactly as its kind defines it (only the kind's fields), so memory stores what the database's kind/column
 * check allows and nothing else. An unknown kind is refused.
 */
function canonicalVisual(v: VisualSource): VisualSource {
  switch (v.kind) {
    case "video":
      return {
        kind: "video",
        attemptId: v.attemptId,
        assetId: v.assetId,
        sourceInMs: v.sourceInMs,
        sourceOutMs: v.sourceOutMs,
      };
    case "production_frame":
      return { kind: "production_frame", productionFrameId: v.productionFrameId, durationMs: v.durationMs };
    case "storyboard_frame":
      return { kind: "storyboard_frame", storyboardFrameId: v.storyboardFrameId, durationMs: v.durationMs };
    case "none":
      return { kind: "none", durationMs: v.durationMs };
    default:
      throw new EpisodeEditError("invalid", "Unknown picture kind.");
  }
}

const itemOf = (items: EditItem[], itemId: string): EditItem => {
  const item = items.find((i) => i.id === itemId);
  if (!item) throw new EpisodeEditError("not_found", "That edit item no longer exists.");
  return item;
};

/**
 * The next edit state (pure). Refuses an op that names an item not in the edit, an out-of-range position, a reorder
 * that is not exactly the current items, a trim of a still, a hold of a clip, or a replacement that is missing or no
 * longer the one the caller saw. The source/shape checks run afterwards (`assertEditValid`).
 */
export function applyEditOps(
  current: EpisodeEdit,
  ops: readonly EditOp[],
  facts: EditSourceFacts,
  newId: () => string,
  ctx: OpContext = { userId: null, now: new Date().toISOString() },
): PlannedEdit {
  let items: EditItem[] = structuredClone(current.items);
  const visualChanged = new Set<string>();
  const performanceChanged = new Set<string>();
  const replace = (next: EditItem) => {
    items = items.map((i) => (i.id === next.id ? next : i));
  };

  for (const op of ops) {
    switch (op.op) {
      case "add": {
        if (!Number.isSafeInteger(op.atPosition) || op.atPosition < 0 || op.atPosition > items.length)
          throw new EpisodeEditError("invalid", "That position is outside the edit.");
        const item: EditItem = {
          id: newId(),
          shotId: op.item.shotId,
          visual: canonicalVisual(op.item.visual),
          sourceAudio: op.item.sourceAudio ?? "muted",
          performance: ordered(op.item.performance),
          performanceBasis: basisOf(op.item.performanceBasis),
          incomingCutIntent: null,
        };
        items.splice(op.atPosition, 0, item);
        visualChanged.add(item.id);
        performanceChanged.add(item.id);
        break;
      }
      case "remove":
        itemOf(items, op.itemId);
        items = items.filter((i) => i.id !== op.itemId);
        visualChanged.delete(op.itemId);
        performanceChanged.delete(op.itemId);
        break;
      case "reorder": {
        const ids = new Set(op.itemIds);
        if (
          ids.size !== op.itemIds.length ||
          op.itemIds.length !== items.length ||
          items.some((i) => !ids.has(i.id))
        )
          throw new EpisodeEditError(
            "invalid",
            "A reorder must list exactly the edit's current items, each once.",
          );
        items = op.itemIds.map((id) => itemOf(items, id));
        break;
      }
      case "set_visual":
        replace({ ...itemOf(items, op.itemId), visual: canonicalVisual(op.visual) });
        visualChanged.add(op.itemId);
        break;
      case "use_replacement": {
        const item = itemOf(items, op.itemId);
        const approved = approvedClipAttempt(facts.clip, item.shotId);
        const clip = approved
          ? preferredClipAsset({ ...facts.clip, project: { id: current.projectId } }, approved, facts.media)
          : null;
        if (!approved || !clip)
          throw new EpisodeEditError(
            "invalid",
            "This item has no replacement: the Shot has no usable approved clip.",
          );
        if (approved.id !== op.expected.attemptId || clip.asset.id !== op.expected.assetId)
          throw new EpisodeEditError("conflict", REPLACEMENT_CHANGED_MESSAGE);
        const v = item.visual;
        if (v.kind === "video" && v.attemptId === approved.id && v.assetId === clip.asset.id)
          throw new EpisodeEditError("invalid", "This item already shows that clip.");
        replace({
          ...item,
          visual: {
            kind: "video",
            attemptId: approved.id,
            assetId: clip.asset.id,
            sourceInMs: 0,
            sourceOutMs: Math.min(clip.asset.durationMs!, itemDurationMs(v)),
          },
        });
        visualChanged.add(op.itemId);
        break;
      }
      case "trim": {
        const item = itemOf(items, op.itemId);
        if (item.visual.kind !== "video")
          throw new EpisodeEditError(
            "invalid",
            "Only a clip has source in and out points; a still has a hold duration.",
          );
        replace({
          ...item,
          visual: { ...item.visual, sourceInMs: op.sourceInMs, sourceOutMs: op.sourceOutMs },
        });
        visualChanged.add(op.itemId);
        break;
      }
      case "set_hold": {
        const item = itemOf(items, op.itemId);
        if (item.visual.kind === "video")
          throw new EpisodeEditError(
            "invalid",
            "A clip's duration is its trim; only a still or an empty slot holds.",
          );
        replace({ ...item, visual: { ...item.visual, durationMs: op.durationMs } });
        visualChanged.add(op.itemId);
        break;
      }
      case "set_source_audio":
        replace({ ...itemOf(items, op.itemId), sourceAudio: op.sourceAudio });
        break;
      case "set_performance":
        replace({
          ...itemOf(items, op.itemId),
          performance: ordered(op.placements),
          performanceBasis: basisOf(op.performanceBasis),
        });
        performanceChanged.add(op.itemId);
        break;
      case "clear_performance":
        replace({ ...itemOf(items, op.itemId), performance: [] });
        performanceChanged.add(op.itemId);
        break;
      case "set_cut_intent": {
        const item = itemOf(items, op.itemId);
        const index = items.indexOf(item);
        if (index === 0)
          throw new EpisodeEditError("invalid", "The first item of the edit has no incoming cut.");
        if (items[index - 1]!.id !== op.expectedPredecessorId)
          throw new EpisodeEditError("conflict", CUT_INTENT_PREDECESSOR_CHANGED_MESSAGE);
        const intent: CutIntent = {
          fromItemId: op.expectedPredecessorId,
          kinds: [...op.kinds],
          scope: [...op.scope],
          note: op.note.trim(),
          declaredBy: ctx.userId,
          declaredAt: ctx.now,
        };
        const problem = cutIntentProblem(intent);
        if (problem)
          throw new EpisodeEditError(
            "invalid",
            problem === "kinds"
              ? "Choose at least one kind of intentional discontinuity."
              : problem === "note"
                ? "Say why the cut is deliberate (up to 2,000 characters)."
                : "That cut intent is not valid.",
          );
        replace({ ...item, incomingCutIntent: intent });
        break;
      }
      case "clear_cut_intent": {
        const item = itemOf(items, op.itemId);
        if (!item.incomingCutIntent)
          throw new EpisodeEditError("invalid", "This cut has no declared intent.");
        replace({ ...item, incomingCutIntent: null });
        break;
      }
    }
  }
  // 3A.4C: an intent is bound to the cut it was declared against. When an item's predecessor changed (reorder, add,
  // remove, moved first) its intent no longer describes this cut: clear it in the same unit, never retarget it.
  const intentCleared = new Set<string>();
  items = items.map((item, index) => {
    const intent = item.incomingCutIntent;
    if (!intent || (index > 0 && items[index - 1]!.id === intent.fromItemId)) return item;
    intentCleared.add(item.id);
    return { ...item, incomingCutIntent: null };
  });
  return { next: { ...current, items }, visualChanged, performanceChanged, intentCleared };
}

const SHAPE_TEXT: Record<EditShapeViolation["code"], string> = {
  invalid_edit_rate: "That edit rate is not supported.",
  duplicate_item_id: "Two edit items have the same id.",
  duplicate_shot: SHOT_ALREADY_IN_EDIT_MESSAGE,
  invalid_time: "Edit times must be non-negative whole milliseconds.",
  empty_item: "An edit item must last longer than 0 ms.",
  duplicate_line: "A dialogue line can be placed only once under an item.",
  invalid_placement: "A placement's take in/out must be whole milliseconds with in < out.",
  placement_outside_item:
    "A placed performance must stay inside its item. Move or trim the performance, or keep the item longer.",
};

const VIDEO_CODE: Partial<Record<VideoSourceViolation, EpisodeEditError["code"]>> = {
  attempt_not_found: "not_found",
  asset_not_found: "not_found",
  wrong_project: "wrong_project",
  wrong_shot: "wrong_shot",
};

/** The 2I.1 rules on the whole next edit, then the source rules on the changed items. Throws the first refusal. */
export function assertEditValid(
  plan: PlannedEdit,
  facts: EditSourceFacts,
  edit: Pick<EpisodeEdit, "projectId" | "episodeId">,
): void {
  if (!isEditRate(plan.next.editRate)) throw new EpisodeEditError("invalid", SHAPE_TEXT.invalid_edit_rate);
  const shape = editShapeViolations(plan.next);
  if (shape[0])
    throw new EpisodeEditError(
      shape[0].code === "duplicate_shot" ? "conflict" : "invalid",
      SHAPE_TEXT[shape[0].code],
    );
  // the database's final-state rule (0046), checked in code too so memory refuses what Postgres refuses
  for (const [index, item] of plan.next.items.entries()) {
    const intent = item.incomingCutIntent;
    if (!intent) continue;
    if (cutIntentProblem(intent)) throw new EpisodeEditError("invalid", "That cut intent is not valid.");
    if (index === 0 || plan.next.items[index - 1]!.id !== intent.fromItemId)
      throw new EpisodeEditError("invalid", "A cut intent must name the item immediately before it.");
  }

  const clip: ClipSourceData = { ...facts.clip, project: { id: edit.projectId } };
  for (const item of plan.next.items) {
    if (plan.visualChanged.has(item.id)) {
      const shot = facts.shots.find((s) => s.id === item.shotId);
      if (!shot) throw new EpisodeEditError("not_found", "That Shot no longer exists.");
      if (shot.projectId !== edit.projectId)
        throw new EpisodeEditError("wrong_project", "That Shot belongs to another project.");
      if (shot.episodeId !== edit.episodeId)
        throw new EpisodeEditError("wrong_shot", SHOT_NOT_IN_EPISODE_MESSAGE);

      const v = item.visual;
      if (v.kind === "video") {
        const violation = videoSourceViolations(clip, item.shotId, v, facts.media)[0];
        if (violation)
          throw new EpisodeEditError(
            VIDEO_CODE[violation] ?? "invalid_source",
            VIDEO_SOURCE_VIOLATION_TEXT[violation],
          );
      } else if (v.kind !== "none") {
        const frames = v.kind === "production_frame" ? facts.productionFrames : facts.storyboardFrames;
        const frameId = v.kind === "production_frame" ? v.productionFrameId : v.storyboardFrameId;
        const frame = frames.find((f) => f.id === frameId);
        if (frame && frame.projectId !== edit.projectId)
          throw new EpisodeEditError("wrong_project", "That frame belongs to another project.");
        const violation = placeholderViolations(
          { frames: facts.storyboardFrames, productionFrames: facts.productionFrames },
          item.shotId,
          v,
        )[0];
        if (violation === "frame_not_found")
          throw new EpisodeEditError("not_found", "That frame no longer exists.");
        if (violation === "frame_wrong_shot")
          throw new EpisodeEditError("wrong_shot", "That frame belongs to another Shot.");
      }
    }
    if (plan.performanceChanged.has(item.id)) {
      for (const p of item.performance) {
        const take = facts.takes.find((t) => t.id === p.takeId);
        if (take && take.projectId !== edit.projectId)
          throw new EpisodeEditError("wrong_project", "That take belongs to another project.");
        const violation = placementViolations(facts, p)[0];
        if (violation === "take_not_found")
          throw new EpisodeEditError("not_found", "That take no longer exists.");
        if (violation === "take_wrong_line")
          throw new EpisodeEditError("invalid", "That take is not a take of the placed line.");
        if (violation === "beyond_take")
          throw new EpisodeEditError("invalid", "The placement plays beyond the end of its take.");
        if (take!.archived) throw new EpisodeEditError("invalid", "An archived take cannot be placed.");
      }
    }
  }
}

/** An empty edit to plan a create against (its items are the create's adds). */
export const emptyEdit = (
  base: Pick<EpisodeEdit, "id" | "projectId" | "episodeId" | "editRate">,
): EpisodeEdit => ({
  ...base,
  editRate: { num: base.editRate.num, den: base.editRate.den },
  revision: 0,
  items: [],
});

export const addsOf = (items: readonly NewEditItem[]): EditOp[] =>
  items.map((item, i) => ({ op: "add", item, atPosition: i }));

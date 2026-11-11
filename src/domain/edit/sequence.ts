import { buildShotContext, shotOrder } from "@/domain/context";
import type { ProjectData } from "@/domain/schemas";
import type { EditMediaFacts } from "./eligibility";
import { itemDurationMs, type EditItem, type EpisodeEdit, type VisualSource } from "./model";
import { approvedClipAttempt } from "./proposal";
import { replacementFor } from "./view";

/**
 * Phase 5B-V2: the Episode Sequence is the existing Episode Edit (2I.1, migration 0043): an editorial arrangement of
 * the Episode's Shots that never rewrites Scene or Shot structure. Pure helpers for two editorial actions:
 *
 *   storyOrderIds    the item ids in STORY order (Scene order, then Shot order — the Sequence Board's `shotOrder`):
 *                    "Reset to story order" is one `reorder` of these ids.
 *   currentMedia     what "Use current Shot Clips and frames" pins, item by item, as explicit edit operations:
 *                    the Shot's selected Shot Clip where one exists (the 2I.1 `use_replacement`), else — for a
 *                    placeholder — the Shot's CURRENT canonical Production Frame, held for the item's duration.
 *
 * MEDIA POLICY (documented, tested): items PIN exact media (a clip attempt + Asset + trim, or a frame), as 2I.1 always
 * has. A change upstream (a new Shot Clip, a new canonical Production Frame) is never applied silently: the row says so
 * ("Replacement available", "Newer Production Frame selected") and one explicit click re-pins everything current.
 * Pinned media is never edited; older clips and frames stay as history.
 */
export function storyOrderIds(data: ProjectData, edit: Pick<EpisodeEdit, "items">): string[] {
  const order = shotOrder(data);
  const shotOf = new Map(data.shots.map((s) => [s.id, s]));
  return [...edit.items]
    .map((item, index) => ({ item, index, shot: shotOf.get(item.shotId) }))
    .sort((a, b) => {
      if (a.shot && b.shot) return order(a.shot, b.shot) || a.index - b.index;
      if (a.shot) return -1;
      if (b.shot) return 1;
      return a.index - b.index;
    })
    .map((x) => x.item.id);
}

export const isStoryOrder = (data: ProjectData, edit: Pick<EpisodeEdit, "items">) =>
  storyOrderIds(data, edit).join() === edit.items.map((i) => i.id).join();

export type CurrentMediaChange =
  | { itemId: string; kind: "clip"; attemptId: string; assetId: string }
  | { itemId: string; kind: "frame"; visual: Extract<VisualSource, { kind: "production_frame" }> };

/** Every item whose pinned picture is not the Shot's current selection, and what it would become. */
export function currentMediaChanges(
  data: ProjectData,
  edit: Pick<EpisodeEdit, "items">,
  media: EditMediaFacts,
): CurrentMediaChange[] {
  const out: CurrentMediaChange[] = [];
  for (const item of edit.items) {
    const replacement = replacementFor(data, item, media);
    if (replacement && replacement.visual.kind === "video") {
      out.push({
        itemId: item.id,
        kind: "clip",
        attemptId: replacement.visual.attemptId,
        assetId: replacement.visual.assetId,
      });
      continue;
    }
    if (item.visual.kind === "video" || approvedClipAttempt(data, item.shotId)) continue;
    const frame = data.shots.some((s) => s.id === item.shotId)
      ? buildShotContext(data, item.shotId).selectedProductionFrame
      : null;
    const current = item.visual.kind === "production_frame" ? item.visual.productionFrameId : null;
    if (frame && frame.id !== current)
      out.push({
        itemId: item.id,
        kind: "frame",
        visual: {
          kind: "production_frame",
          productionFrameId: frame.id,
          durationMs: itemDurationMs(item.visual),
        },
      });
  }
  return out;
}

/** The picture an item shows, in creator words. */
export const SEQUENCE_MEDIA_LABEL: Record<VisualSource["kind"], string> = {
  video: "Shot Clip",
  production_frame: "Production Frame",
  storyboard_frame: "Storyboard",
  none: "Missing media",
};

export const sequenceMediaLabel = (item: Pick<EditItem, "visual">) => SEQUENCE_MEDIA_LABEL[item.visual.kind];

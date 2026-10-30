import { transitionKey } from "@/domain/continuity/sequence";
import { MediaQaError, type NewTransitionRun } from "./media-qa-repository";

/**
 * Phase 3A.4C: the check both media-QA repositories make INSIDE their unit before freezing a transition run, so memory
 * and Postgres refuse exactly the same requests. The subject's ids are recorded history afterwards; at creation they
 * must describe a cut that exists right now: the edit, its Episode, the two items adjacent left → right, their Shots,
 * and the transition key of that address.
 */
export interface LiveEditShape {
  id: string;
  projectId: string;
  episodeId: string;
  revision: number;
  /** in edit order */
  items: ReadonlyArray<{ id: string; shotId: string }>;
}

export const TRANSITION_CUT_CHANGED_MESSAGE =
  "This cut no longer exists in the edit as reviewed (its items are not adjacent any more). Nothing was recorded.";

export function transitionRunRefusal(
  edit: LiveEditShape | null,
  input: NewTransitionRun,
): MediaQaError | null {
  const s = input.subject;
  if (!edit || edit.projectId !== input.projectId)
    return new MediaQaError("not_found", "That edit no longer exists.");
  if (edit.id !== s.editId || edit.episodeId !== s.episodeId)
    return new MediaQaError("invalid", "The transition names another edit or Episode.");
  if (s.leftSide.side !== "left" || s.rightSide.side !== "right")
    return new MediaQaError("invalid", "The transition's side snapshots are swapped.");
  if (s.leftSide.itemId !== s.leftItemId || s.rightSide.itemId !== s.rightItemId)
    return new MediaQaError("invalid", "The transition's side snapshots name other items.");
  if (s.leftSide.shotId !== s.leftShotId || s.rightSide.shotId !== s.rightShotId)
    return new MediaQaError("invalid", "The transition's side snapshots name other Shots.");
  if (
    s.transitionKey !==
    transitionKey({ editId: s.editId, leftItemId: s.leftItemId, rightItemId: s.rightItemId })
  )
    return new MediaQaError("invalid", "The transition key does not match its address.");
  const at = edit.items.findIndex((i) => i.id === s.leftItemId);
  const right = at >= 0 ? edit.items[at + 1] : undefined;
  if (!right || right.id !== s.rightItemId)
    return new MediaQaError("conflict", TRANSITION_CUT_CHANGED_MESSAGE);
  if (edit.items[at]!.shotId !== s.leftShotId || right.shotId !== s.rightShotId)
    return new MediaQaError("conflict", TRANSITION_CUT_CHANGED_MESSAGE);
  return null;
}

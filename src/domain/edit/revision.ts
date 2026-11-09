import { fingerprint } from "@/domain/hash";
import type { EditItem, EditTitleCard, EpisodeEdit } from "./model";

/**
 * Phase 5B-V3: the editorial STATE of an edit, as a saved revision freezes it and as its fingerprint identifies it:
 * edit rate, items in order (each with its own id, pinned picture and trim / hold, clip-audio policy, placements,
 * placement basis, cut intent, transition) and title cards. Not part of it: the edit's id / Project / Episode (the
 * container) and the working revision counter (bumped by every change, including a change and its undo).
 */
export interface EditState {
  editRate: EpisodeEdit["editRate"];
  items: EditItem[];
  titles: EditTitleCard[];
}

/** The state in one canonical shape: every optional field present (null) so absent and null fingerprint alike. */
export function editState(edit: Pick<EpisodeEdit, "editRate" | "items" | "titles">): EditState {
  return {
    editRate: { num: edit.editRate.num, den: edit.editRate.den },
    items: edit.items.map((i) => ({
      id: i.id,
      shotId: i.shotId,
      visual: structuredClone(i.visual),
      sourceAudio: i.sourceAudio,
      performance: structuredClone(i.performance),
      performanceBasis: i.performanceBasis ? { ...i.performanceBasis } : null,
      incomingCutIntent: i.incomingCutIntent ? structuredClone(i.incomingCutIntent) : null,
      incomingTransition: i.incomingTransition ? { ...i.incomingTransition } : null,
    })),
    titles: [...(edit.titles ?? [])]
      .sort((a, b) => (a.placement < b.placement ? -1 : a.placement > b.placement ? 1 : 0))
      .map((t) => ({ ...t })),
  };
}

/** Equal fingerprints = the same edit (same order, media, trims, holds, audio, transitions, titles). */
export const editStateFingerprint = (edit: Pick<EpisodeEdit, "editRate" | "items" | "titles">): string =>
  fingerprint(editState(edit));

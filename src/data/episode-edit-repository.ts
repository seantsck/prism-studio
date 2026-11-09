import type { CutIntentKind } from "@/domain/continuity/cut-intent";
import type { ContinuityCategory } from "@/domain/continuity/model";
import type { CutSettlementClock } from "@/domain/continuity/sequence-automation";
import type { EditRate } from "@/domain/edit/edit-rate";
import type {
  AudioPlacement,
  EditItem,
  EditTitleCard,
  EpisodeEdit,
  PlacementBasis,
  SourceAudio,
  TitlePlacement,
  TitleStyle,
  TransitionKind,
  VisualSource,
} from "@/domain/edit/model";

/**
 * Persistence contract for Phase 2I.1 Episode edits: the edit of an Episode (its own stable id), its items in explicit
 * order (each with its own stable id) and the performance placed under each item. The application path only (acts as
 * the signed-in user; RLS applies in Postgres). Neither worker role has any access: the edit is not a generation
 * package or QA input.
 *
 * Every mutation names the edit by id and carries `expectedRevision`; items are addressed by their own ids, never by
 * their Shot or position. A mutation runs as ONE unit: lock the edit, compare the revision, validate every reference
 * and invariant, write, bump the revision by exactly one. A stale revision writes nothing.
 *
 * Implementations: src/data/episode-edit-memory.ts and src/data/episode-edit-postgres.ts (same semantics as migration
 * 0043; the shared op semantics and checks are src/data/episode-edit-ops.ts).
 */
export class EpisodeEditError extends Error {
  constructor(
    readonly code:
      "not_found" | "wrong_project" | "wrong_shot" | "invalid_source" | "conflict" | "invalid" | "in_use",
    message: string,
  ) {
    super(message);
    this.name = "EpisodeEditError";
  }
}

/** An item to add: the repository assigns its id. */
export interface NewEditItem {
  shotId: string;
  visual: VisualSource;
  sourceAudio?: SourceAudio;
  performance: AudioPlacement[];
  performanceBasis: PlacementBasis | null;
}

/**
 * One editorial change. `apply` runs a list of them in order as one transaction; positions are renumbered densely
 * afterwards.
 *   add                adds an item for a Shot of the edit's Episode at `atPosition` (0..n; n = at the end)
 *   remove             removes an item and its placements (the Shot is then not in the edit and may be deleted)
 *   reorder            the complete new order: exactly the current item ids
 *   set_visual         pins an eligible clip interval or a placeholder (the union carries its own times)
 *   use_replacement    pins the replacement Prism reports (the Shot's approved clip, as its delivery master else its
 *                      primary output), only if it is still exactly the one the caller saw (`expected`); the trim keeps
 *                      the item's duration when the new clip is long enough
 *   trim               a video item's source in/out (ms of its exact Asset)
 *   set_hold           a still / empty item's duration
 *   set_source_audio   the clip's own audio track: muted / included
 *   set_performance    replaces the item's placements (and their basis); an empty list is explicit silence
 *   clear_performance  explicit silence: removes every placement of the item
 *   set_transition     5B-V3: the transition INTO an item: cut, or a cross dissolve of `durationMs` (validated against
 *                      both neighbours); bound to the predecessor the person saw (`expectedPredecessorId`)
 *   set_title          5B-V3: creates or replaces the opening / closing title card
 *   remove_title       5B-V3: removes a title card
 *   restore            5B-V3: the items and titles of a saved revision become the edit's state again (a NEW revision;
 *                      the saved one is never changed). Issued by `restoreRevision`, not by a request.
 */
export type EditOp =
  | { op: "add"; item: NewEditItem; atPosition: number }
  | { op: "remove"; itemId: string }
  | { op: "reorder"; itemIds: string[] }
  | { op: "set_visual"; itemId: string; visual: VisualSource }
  | { op: "use_replacement"; itemId: string; expected: { attemptId: string; assetId: string } }
  | { op: "trim"; itemId: string; sourceInMs: number; sourceOutMs: number }
  | { op: "set_hold"; itemId: string; durationMs: number }
  | { op: "set_source_audio"; itemId: string; sourceAudio: SourceAudio }
  | {
      op: "set_performance";
      itemId: string;
      placements: AudioPlacement[];
      performanceBasis: PlacementBasis | null;
    }
  | { op: "clear_performance"; itemId: string }
  /**
   * 3A.4C: declare the cut INTO `itemId` deliberate. `expectedPredecessorId` is the left item the person reviewed; it
   * must still be the item before `itemId`. Who and when come from the server (`userId`, `now`), never the request.
   */
  | {
      op: "set_cut_intent";
      itemId: string;
      expectedPredecessorId: string;
      kinds: CutIntentKind[];
      scope: ContinuityCategory[];
      note: string;
    }
  | { op: "clear_cut_intent"; itemId: string }
  | {
      op: "set_transition";
      itemId: string;
      expectedPredecessorId: string;
      kind: TransitionKind;
      /** dissolve only */
      durationMs?: number;
    }
  | {
      op: "set_title";
      placement: TitlePlacement;
      title: string;
      subtitle: string;
      durationMs: number;
      style: TitleStyle;
    }
  | { op: "remove_title"; placement: TitlePlacement }
  | { op: "restore"; items: EditItem[]; titles: EditTitleCard[] };

export interface CreateEpisodeEditInput {
  projectId: string;
  episodeId: string;
  editRate: EditRate;
  /** In editorial order. */
  items: NewEditItem[];
  userId: string | null;
  now: string;
}

export interface ApplyEpisodeEditInput {
  editId: string;
  projectId: string;
  expectedRevision: number;
  ops: EditOp[];
  userId: string | null;
  now: string;
}

export interface DeleteEpisodeEditInput {
  editId: string;
  projectId: string;
  expectedRevision: number;
}

/**
 * 5B-V3: a SAVED revision of an edit: an immutable snapshot of its editorial state (items with their pinned media,
 * trims, holds, placements, transitions, cut intents; title cards) at the edit's working revision `editRevision`.
 * Numbered 1, 2, … per edit. Never updated; it goes only with its edit (or Project).
 */
export interface SavedEditRevision {
  id: string;
  editId: string;
  projectId: string;
  /** 1, 2, … per edit */
  number: number;
  /** the edit's working revision counter when it was saved */
  editRevision: number;
  label: string;
  /** the editorial state, exactly as it was */
  snapshot: EditSnapshot;
  /** `editStateFingerprint(snapshot)`: equal fingerprints = the same edit */
  fingerprint: string;
  /** the saved revision this one restored, when it was made by a restore */
  restoredFromId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface EditSnapshot {
  editRate: EpisodeEdit["editRate"];
  items: EditItem[];
  titles: EditTitleCard[];
}

export interface SaveEditRevisionInput {
  editId: string;
  projectId: string;
  /** the working revision the person saw: the snapshot is exactly that state, or nothing is saved */
  expectedRevision: number;
  label: string;
  userId: string | null;
  now: string;
}

export interface RestoreEditRevisionInput {
  editId: string;
  projectId: string;
  expectedRevision: number;
  revisionId: string;
  userId: string | null;
  now: string;
}

export interface EpisodeEditRepository {
  get(projectId: string, editId: string): Promise<EpisodeEdit | null>;
  /** The Episode's edit (Phase 2I.1: at most one). */
  getForEpisode(projectId: string, episodeId: string): Promise<EpisodeEdit | null>;
  /** Every edit of a project, for the loaders and where-used. */
  listForProject(projectId: string): Promise<EpisodeEdit[]>;
  /** Creates the Episode's edit at revision 0. Refused (`conflict`) when the Episode already has one. */
  create(input: CreateEpisodeEditInput): Promise<EpisodeEdit>;
  /** Applies the ops in order, all or nothing, and returns the edit at `expectedRevision + 1`. */
  apply(input: ApplyEpisodeEditInput): Promise<EpisodeEdit>;
  /** Deletes the edit with its items and placements (explicit; nothing else deletes an edit but its Episode/Project). */
  delete(input: DeleteEpisodeEditInput): Promise<void>;
  /**
   * 3A.4F: the clocks of the rows a cut's fingerprints can depend on (`cutSettlementSources`). A narrow read: these
   * timestamps are not part of the creative domain shape.
   */
  getCutSettlementClock(projectId: string, editId: string): Promise<CutSettlementClock>;
  /** Whether any edit (of any project the caller owns) pins this Asset. */
  usesAsset(assetId: string): Promise<boolean>;
  /**
   * 5B-V3: saves the edit's CURRENT state (at `expectedRevision`) as the next numbered revision. The working edit is
   * not changed. Refused when the edit moved on, or when the state is already the latest saved revision.
   */
  saveRevision(input: SaveEditRevisionInput): Promise<SavedEditRevision>;
  /** 5B-V3: every saved revision of an edit, oldest first. */
  listRevisions(projectId: string, editId: string): Promise<SavedEditRevision[]>;
  /**
   * 5B-V3: makes a saved revision's state current as ONE unit: a `restore` (the edit's revision + 1, every source
   * re-checked) and a new saved revision recording it (`restoredFromId`). The restored revision is never changed.
   */
  restoreRevision(
    input: RestoreEditRevisionInput,
  ): Promise<{ edit: EpisodeEdit; revision: SavedEditRevision }>;
}

export const EDIT_REVISION_CONFLICT_MESSAGE = "The edit changed in the meantime. Reload and try again.";
export const EDIT_EXISTS_MESSAGE = "This Episode already has an edit.";
export const SHOT_ALREADY_IN_EDIT_MESSAGE = "That Shot is already in the edit.";
export const SHOT_NOT_IN_EPISODE_MESSAGE = "That Shot is not part of this edit's Episode.";
export const REPLACEMENT_CHANGED_MESSAGE =
  "The replacement changed in the meantime. Reload to see the current replacement.";
export const IN_EDIT_MESSAGE = "It is used in the Episode edit. Remove it from the edit first.";
export const REVISION_ALREADY_SAVED_MESSAGE = "This edit is already saved as the latest revision.";
export const REVISION_NOT_FOUND_MESSAGE = "That saved revision no longer exists.";

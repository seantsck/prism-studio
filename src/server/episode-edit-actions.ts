"use server";

import { revalidatePath } from "next/cache";
import {
  EDIT_REVISION_CONFLICT_MESSAGE,
  EpisodeEditError,
  type EditOp,
} from "@/data/episode-edit-repository";
import { buildShotContext } from "@/domain/context";
import { VIDEO_SOURCE_VIOLATION_TEXT } from "@/domain/edit/eligibility";
import { computeShotParts } from "@/domain/fingerprint";
import {
  itemDurationMs,
  type AudioPlacement,
  type EditItem,
  type EpisodeEdit,
  type SourceAudio,
  type VisualSource,
} from "@/domain/edit/model";
import { proposeEpisodeAssembly, proposePerformance, proposeShotItem } from "@/domain/edit/proposal";
import { proposalKey, proposedItemKey } from "@/domain/edit/proposal-key";
import type { ProjectData } from "@/domain/schemas";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { loadEditMediaFacts } from "./episode-edit-media";
import { getEpisodeEditRepo } from "./episode-edits";
import { getRepo, requireProjectFresh } from "./repo";

/**
 * Phase 2I.1C/2I.1D Episode Edit actions. Every write goes through the 2I.1B repository (`create` / `apply` with
 * `EditOp`s): the actions only translate the browser's request into ops; the repository re-validates every source,
 * keeps placements inside their item, locks the edit, compares the revision and bumps it exactly once. Nothing here
 * follows Best, approval, a selection or the Sequence order on its own.
 *
 * createEpisodeEdit: the browser sends the project slug, the Episode id and the proposal KEY it showed
 * (`proposalKey`, src/domain/edit/proposal-key.ts), never a source id. The server re-reads the project as the signed-in
 * user (RLS-bound; ownership), recomputes the proposal from current facts and creates it ONLY when its key equals the
 * one the user reviewed; any change to what would be persisted refuses with a stale-proposal message. A second identical
 * create (double click, two tabs) resolves to the edit that now exists: never a second edit, never a raw database error.
 *
 * Editing (2I.1D): every mutation names the edit and the item by id and carries the revision the page showed
 * (`expectedRevision`). A stale revision is refused with REVISION_CONFLICT, nothing is written, nothing is retried or
 * merged, and the page re-renders the latest edit. Source ids from the browser are only REQUESTS: the repository
 * re-checks eligibility (same Shot and project, Shot-output purpose, succeeded, the Asset one of the attempt's pictures,
 * the trim inside it). No provider call.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const now = () => new Date().toISOString();

const STALE_PROPOSAL_MESSAGE =
  "The proposed assembly changed since this page was loaded (order, approval, frames, takes or timing). Review the current proposal and create the edit again.";
const ALREADY_CREATED_MESSAGE = "This Episode's edit already exists; showing it.";
const REVISION_CONFLICT =
  "This edit changed before your update was saved. Review the latest version and try again.";
const STALE_ADD_MESSAGE =
  "What would be added for that Shot changed since this page was loaded. Review it and add it again.";

const refresh = (slug: string) => revalidatePath(`/projects/${slug}`, "layout");

async function createEpisodeEdit_impl(form: FormData): Promise<ActionResult> {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const episodeId = str(form, "episodeId");
  if (!data.episodes.some((e) => e.id === episodeId)) throw new UserFacingError("Episode not found.");
  const edits = await getEpisodeEditRepo();

  if (await edits.getForEpisode(data.project.id, episodeId)) {
    refresh(slug);
    return { ok: true, message: ALREADY_CREATED_MESSAGE };
  }
  const proposal = proposeEpisodeAssembly(data, episodeId, await loadEditMediaFacts(data, episodeId));
  if (proposalKey(proposal) !== str(form, "proposalKey")) throw new UserFacingError(STALE_PROPOSAL_MESSAGE);
  if (proposal.items.length === 0) throw new UserFacingError("This Episode has no Shots to assemble yet.");

  try {
    await edits.create({
      projectId: data.project.id,
      episodeId,
      editRate: proposal.editRate,
      items: proposal.items.map((i) => ({
        shotId: i.shotId,
        visual: i.visual,
        sourceAudio: i.sourceAudio,
        performance: i.performance,
        performanceBasis: i.performanceBasis,
      })),
      userId: (await getRepo()).currentUserId(),
      now: now(),
    });
  } catch (err) {
    if (!(err instanceof EpisodeEditError)) throw err;
    // a concurrent identical create won the one-edit-per-Episode race: resolve to the edit it created
    if (err.code === "conflict" && (await edits.getForEpisode(data.project.id, episodeId))) {
      refresh(slug);
      return { ok: true, message: ALREADY_CREATED_MESSAGE };
    }
    throw new UserFacingError(err.message);
  }
  refresh(slug);
  return { ok: true, message: `Edit created: ${proposal.items.length} Shots, revision 0.` };
}

export async function createEpisodeEdit(form: FormData): Promise<ActionResult> {
  return runAction(() => createEpisodeEdit_impl(form), { name: "createEpisodeEdit" });
}

// ───────────────────────── 2I.1D editing ─────────────────────────

interface EditContext {
  data: ProjectData;
  edit: EpisodeEdit;
  form: FormData;
  /** the item the request names (refused when it is not in the edit) */
  item: () => EditItem;
}

/**
 * One editorial mutation: load the user's project and the edit, refuse a stale revision before anything else, build
 * the ops, apply them in ONE repository call, re-render. The repository is the authority for every check.
 */
async function mutate(
  form: FormData,
  build: (ctx: EditContext) => EditOp[] | Promise<EditOp[]>,
  success: string,
): Promise<ActionResult> {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const edits = await getEpisodeEditRepo();
  const edit = await edits.get(data.project.id, str(form, "editId"));
  if (!edit) throw new UserFacingError("That edit no longer exists.");
  const expectedRevision = Number(str(form, "expectedRevision"));
  if (!Number.isSafeInteger(expectedRevision)) throw new UserFacingError("The edit revision is missing.");
  if (edit.revision !== expectedRevision) {
    refresh(slug);
    throw new UserFacingError(REVISION_CONFLICT);
  }
  const item = () => {
    const found = edit.items.find((i) => i.id === str(form, "itemId"));
    if (!found) throw new UserFacingError("That edit item no longer exists.");
    return found;
  };
  const ops = await build({ data, edit, form, item });
  try {
    await edits.apply({
      editId: edit.id,
      projectId: data.project.id,
      expectedRevision,
      ops,
      userId: (await getRepo()).currentUserId(),
      now: now(),
    });
  } catch (err) {
    if (!(err instanceof EpisodeEditError)) throw err;
    refresh(slug);
    throw new UserFacingError(
      err.message === EDIT_REVISION_CONFLICT_MESSAGE ? REVISION_CONFLICT : err.message,
    );
  }
  refresh(slug);
  return { ok: true, message: success };
}

/** A whole number of milliseconds from a seconds field ("1.25" → 1250); refused when it is not a number. */
function msField(form: FormData, key: string, label: string): number {
  const raw = str(form, key);
  const seconds = Number(raw);
  if (raw === "" || !Number.isFinite(seconds))
    throw new UserFacingError(`${label} must be a number of seconds.`);
  return Math.round(seconds * 1000);
}

/**
 * The picture the browser asks for, as a request: `video:<attemptId>:<assetId>` (the full clip by default),
 * `production_frame:<id>` / `storyboard_frame:<id>` (held for the item's current duration), or `none`.
 */
function requestedVisual(data: ProjectData, item: EditItem, raw: string): VisualSource {
  const [kind, a, b] = raw.split(":");
  const hold = itemDurationMs(item.visual);
  if (kind === "video" && a && b) {
    const asset = data.assets.find((x) => x.id === b);
    if (!asset) throw new UserFacingError(VIDEO_SOURCE_VIOLATION_TEXT.asset_not_found);
    if (asset.durationMs == null)
      throw new UserFacingError(VIDEO_SOURCE_VIOLATION_TEXT.asset_duration_unknown);
    return { kind: "video", attemptId: a, assetId: b, sourceInMs: 0, sourceOutMs: asset.durationMs };
  }
  if (kind === "production_frame" && a)
    return { kind: "production_frame", productionFrameId: a, durationMs: hold };
  if (kind === "storyboard_frame" && a)
    return { kind: "storyboard_frame", storyboardFrameId: a, durationMs: hold };
  if (kind === "none") return { kind: "none", durationMs: hold };
  throw new UserFacingError("Choose a picture source.");
}

/** The Shot's current performance / timing parts: the basis of a performance placed now. */
const basisNow = (data: ProjectData, shotId: string) => {
  const parts = computeShotParts(buildShotContext(data, shotId));
  return { performance: parts.performance, timing: parts.timing };
};

export async function setEditItemSource(form: FormData): Promise<ActionResult> {
  return runAction(
    () =>
      mutate(
        form,
        ({ data, item }) => [
          { op: "set_visual", itemId: item().id, visual: requestedVisual(data, item(), str(form, "source")) },
        ],
        "Picture source pinned.",
      ),
    { name: "setEditItemSource" },
  );
}

export async function useEditItemReplacement(form: FormData): Promise<ActionResult> {
  return runAction(
    () =>
      mutate(
        form,
        ({ item }) => [
          {
            op: "use_replacement",
            itemId: item().id,
            expected: { attemptId: str(form, "attemptId"), assetId: str(form, "assetId") },
          },
        ],
        "Replacement pinned.",
      ),
    { name: "useEditItemReplacement" },
  );
}

export async function trimEditItem(form: FormData): Promise<ActionResult> {
  return runAction(
    () =>
      mutate(
        form,
        ({ item }) => [
          {
            op: "trim",
            itemId: item().id,
            sourceInMs: msField(form, "sourceIn", "Source in"),
            sourceOutMs: msField(form, "sourceOut", "Source out"),
          },
        ],
        "Trim applied.",
      ),
    { name: "trimEditItem" },
  );
}

export async function setEditItemHold(form: FormData): Promise<ActionResult> {
  return runAction(
    () =>
      mutate(
        form,
        ({ item }) => [
          { op: "set_hold", itemId: item().id, durationMs: msField(form, "duration", "Duration") },
        ],
        "Hold duration applied.",
      ),
    { name: "setEditItemHold" },
  );
}

export async function moveEditItem(form: FormData): Promise<ActionResult> {
  return runAction(
    () =>
      mutate(
        form,
        ({ edit, item }) => {
          const ids = edit.items.map((i) => i.id);
          const from = ids.indexOf(item().id);
          const to = str(form, "direction") === "up" ? from - 1 : from + 1;
          if (to < 0 || to >= ids.length)
            throw new UserFacingError("The item is already at that end of the edit.");
          [ids[from], ids[to]] = [ids[to]!, ids[from]!];
          return [{ op: "reorder", itemIds: ids }];
        },
        "Order changed.",
      ),
    { name: "moveEditItem" },
  );
}

export async function addShotToEdit(form: FormData): Promise<ActionResult> {
  return runAction(
    () =>
      mutate(
        form,
        async ({ data, edit }) => {
          const shot = data.shots.find((s) => s.id === str(form, "shotId"));
          if (!shot || shot.episodeId !== edit.episodeId)
            throw new UserFacingError("That Shot is not part of this edit's Episode.");
          if (edit.items.some((i) => i.shotId === shot.id))
            throw new UserFacingError("That Shot is already in the edit.");
          const proposed = proposeShotItem(data, shot.id, await loadEditMediaFacts(data, edit.episodeId));
          if (proposedItemKey(proposed) !== str(form, "itemKey"))
            throw new UserFacingError(STALE_ADD_MESSAGE);
          const at = str(form, "position");
          const atPosition = at === "end" || at === "" ? edit.items.length : Number(at);
          return [
            {
              op: "add",
              atPosition,
              item: {
                shotId: proposed.shotId,
                visual: proposed.visual,
                sourceAudio: proposed.sourceAudio,
                performance: proposed.performance,
                performanceBasis: proposed.performanceBasis,
              },
            },
          ];
        },
        "Shot added to the edit.",
      ),
    { name: "addShotToEdit" },
  );
}

export async function removeEditItem(form: FormData): Promise<ActionResult> {
  return runAction(
    () => mutate(form, ({ item }) => [{ op: "remove", itemId: item().id }], "Item removed from the edit."),
    { name: "removeEditItem" },
  );
}

/**
 * Pins one exact take for one line of the item (the other placements are kept). The take starts where that line's
 * placement already starts, else where the Shot timeline lays the line out, and plays as much as fits in the item; the
 * repository refuses a placement that would leave the item. Choosing a take never changes the Shot's selected take.
 */
export async function pinEditItemTake(form: FormData): Promise<ActionResult> {
  return runAction(
    () =>
      mutate(
        form,
        ({ data, item }) => {
          const it = item();
          const lineId = str(form, "dialogueLineId");
          const take = data.takes.find((t) => t.id === str(form, "takeId") && t.dialogueLineId === lineId);
          if (!take) throw new UserFacingError("That take is not a take of this line.");
          const duration = itemDurationMs(it.visual);
          const laidOut = proposePerformance(buildShotContext(data, it.shotId), duration).placements.find(
            (p) => p.dialogueLineId === lineId,
          );
          const startMs =
            it.performance.find((p) => p.dialogueLineId === lineId)?.startMs ??
            laidOut?.startMs ??
            buildShotContext(data, it.shotId).shot.audio.preRollMs;
          const takeOutMs = Math.min(take.durationMs, duration - startMs);
          if (takeOutMs <= 0)
            throw new UserFacingError(
              "The item is too short to play this take at its position. Lengthen the item first.",
            );
          const placement: AudioPlacement = {
            dialogueLineId: lineId,
            takeId: take.id,
            startMs,
            takeInMs: 0,
            takeOutMs,
          };
          return [
            {
              op: "set_performance",
              itemId: it.id,
              placements: [...it.performance.filter((p) => p.dialogueLineId !== lineId), placement],
              performanceBasis: basisNow(data, it.shotId),
            },
          ];
        },
        "Take pinned.",
      ),
    { name: "pinEditItemTake" },
  );
}

/** Re-pins the Shot's CURRENTLY selected takes, laid out as the Shot timeline lays them (an explicit choice). */
export async function repinSelectedTakes(form: FormData): Promise<ActionResult> {
  return runAction(
    () =>
      mutate(
        form,
        ({ data, item }) => {
          const it = item();
          const { placements } = proposePerformance(
            buildShotContext(data, it.shotId),
            itemDurationMs(it.visual),
          );
          return [
            { op: "set_performance", itemId: it.id, placements, performanceBasis: basisNow(data, it.shotId) },
          ];
        },
        "Selected takes pinned.",
      ),
    { name: "repinSelectedTakes" },
  );
}

/** Explicit silence: the whole item (no `dialogueLineId`) or one line. No "silence take" exists: no placement is silence. */
export async function silenceEditItem(form: FormData): Promise<ActionResult> {
  return runAction(
    () =>
      mutate(
        form,
        ({ item }) => {
          const it = item();
          const lineId = str(form, "dialogueLineId");
          if (!lineId) return [{ op: "clear_performance", itemId: it.id }];
          return [
            {
              op: "set_performance",
              itemId: it.id,
              placements: it.performance.filter((p) => p.dialogueLineId !== lineId),
              performanceBasis: it.performanceBasis,
            },
          ];
        },
        "Silence.",
      ),
    { name: "silenceEditItem" },
  );
}

/**
 * The clip's own audio track: muted (default) or included. Including it is refused when the item is not a clip, or
 * when Prism has no record of an audio track in the clip (it would play nothing).
 */
export async function setEditItemClipAudio(form: FormData): Promise<ActionResult> {
  return runAction(
    () =>
      mutate(
        form,
        ({ data, item }) => {
          const it = item();
          const sourceAudio: SourceAudio = str(form, "sourceAudio") === "included" ? "included" : "muted";
          if (sourceAudio === "included") {
            if (it.visual.kind !== "video")
              throw new UserFacingError("Only a generated clip has its own audio.");
            const videoAssetId = it.visual.assetId;
            const asset = data.assets.find((a) => a.id === videoAssetId);
            if (!asset?.channels)
              throw new UserFacingError(
                "Prism has no record of an audio track in this clip, so there is nothing to include.",
              );
          }
          return [{ op: "set_source_audio", itemId: it.id, sourceAudio }];
        },
        "Clip audio updated.",
      ),
    { name: "setEditItemClipAudio" },
  );
}

"use server";

import { revalidatePath } from "next/cache";
import { EpisodeEditError } from "@/data/episode-edit-repository";
import { proposeEpisodeAssembly } from "@/domain/edit/proposal";
import { proposalKey } from "@/domain/edit/proposal-key";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { loadEditMediaFacts } from "./episode-edit-media";
import { getEpisodeEditRepo } from "./episode-edits";
import { getRepo, requireProjectFresh } from "./repo";

/**
 * Phase 2I.1C Episode Edit actions. The ONLY write of 2I.1C is the explicit creation of the initial edit; editing comes
 * in 2I.1D.
 *
 * createEpisodeEdit: the browser sends the project slug, the Episode id and the proposal KEY it showed
 * (`proposalKey`, src/domain/edit/proposal-key.ts), never a source id. The server re-reads the project as the signed-in
 * user (RLS-bound; ownership), recomputes the proposal from current facts and creates it ONLY when its key equals the
 * one the user reviewed; any change to what would be persisted (Sequence order, approval, delivery master, Production
 * Frame or Storyboard, selected takes, planned timing) refuses with a stale-proposal message. A second identical create
 * (double click, two tabs) resolves to the edit that now exists: never a second edit, never a raw database error.
 * No provider call.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

const STALE_PROPOSAL_MESSAGE =
  "The proposed assembly changed since this page was loaded (order, approval, frames, takes or timing). Review the current proposal and create the edit again.";
const ALREADY_CREATED_MESSAGE = "This Episode's edit already exists; showing it.";

async function createEpisodeEdit_impl(form: FormData): Promise<ActionResult> {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const episodeId = str(form, "episodeId");
  if (!data.episodes.some((e) => e.id === episodeId)) throw new UserFacingError("Episode not found.");
  const edits = await getEpisodeEditRepo();
  const refresh = () => revalidatePath(`/projects/${slug}`, "layout");

  if (await edits.getForEpisode(data.project.id, episodeId)) {
    refresh();
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
      now: new Date().toISOString(),
    });
  } catch (err) {
    if (!(err instanceof EpisodeEditError)) throw err;
    // a concurrent identical create won the one-edit-per-Episode race: resolve to the edit it created
    if (err.code === "conflict" && (await edits.getForEpisode(data.project.id, episodeId))) {
      refresh();
      return { ok: true, message: ALREADY_CREATED_MESSAGE };
    }
    throw new UserFacingError(err.message);
  }
  refresh();
  return { ok: true, message: `Edit created: ${proposal.items.length} Shots, revision 0.` };
}

export async function createEpisodeEdit(form: FormData): Promise<ActionResult> {
  return runAction(() => createEpisodeEdit_impl(form), { name: "createEpisodeEdit" });
}

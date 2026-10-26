import "server-only";
import { EpisodeEditError } from "@/data/episode-edit-repository";
import { proposeEpisodeAssembly } from "@/domain/edit/proposal";
import type { ProjectData } from "@/domain/schemas";
import { redactText } from "@/lib/auth/redact";
import {
  editPage,
  proposalPage,
  type EditPageVM,
  type ProposalPageVM,
} from "@/components/views/episode-edit-model";
import { loadEditMediaFacts } from "./episode-edit-media";
import { getEpisodeEditRepo } from "./episode-edits";

export type EpisodeEditPage = ProposalPageVM | EditPageVM | { state: "error"; message: string };

/**
 * The Episode Edit page's READ (Phase 2I.1C). Pure with respect to edit state: it loads the Episode's persisted edit
 * if there is one and builds its view, otherwise it builds the initial-assembly PROPOSAL. It never creates, completes,
 * normalises or re-pins anything (no hidden get-or-create); "Create edit" is the only write, and it is explicit.
 * `data` is the signed-in user's own project (RLS-bound in Supabase mode); a failure is reported, never papered over.
 */
export async function loadEpisodeEditPage(data: ProjectData, episodeId: string): Promise<EpisodeEditPage> {
  try {
    const edit = await (await getEpisodeEditRepo()).getForEpisode(data.project.id, episodeId);
    const pinnedAttempts = (edit?.items ?? []).flatMap((i) =>
      i.visual.kind === "video" ? [i.visual.attemptId] : [],
    );
    const media = await loadEditMediaFacts(data, episodeId, pinnedAttempts);
    if (edit) return editPage(data, edit, media);
    return proposalPage(data, proposeEpisodeAssembly(data, episodeId, media), media);
  } catch (err) {
    if (err instanceof EpisodeEditError) return { state: "error", message: err.message };
    const reference = Math.random().toString(36).slice(2, 10);
    console.error(
      `[episode-edit-page] ${reference}`,
      redactText(err instanceof Error ? (err.stack ?? err.message) : err),
    );
    return {
      state: "error",
      message: `The Episode Edit could not be built from this project's records. Nothing was changed. (ref ${reference})`,
    };
  }
}

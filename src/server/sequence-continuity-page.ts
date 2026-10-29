import "server-only";
import { EpisodeEditError } from "@/data/episode-edit-repository";
import type { Episode, ProjectData } from "@/domain/schemas";
import { redactText } from "@/lib/auth/redact";
import {
  continuityPage,
  supervisorLinks,
  type ContinuityPageVM,
} from "@/components/views/sequence-continuity-model";
import { loadEditMediaFacts } from "./episode-edit-media";
import { getEpisodeEditRepo } from "./episode-edits";

/**
 * The Continuity Supervisor page's READ (Phase 3A.4B): exactly the Episode Edit page's read path (the persisted edit
 * and its media facts), then the pure 3A.4A cut projection. It writes nothing: no edit is created, no transition run,
 * Asset, derivation or analysis exists afterwards that did not exist before. Without a persisted edit there are no
 * cuts (never invented from Shot order). A failure is reported, never papered over.
 */
export async function loadContinuityPage(data: ProjectData, episode: Episode): Promise<ContinuityPageVM> {
  const links = supervisorLinks(data, episode);
  try {
    const edit = await (await getEpisodeEditRepo()).getForEpisode(data.project.id, episode.id);
    if (!edit) return { state: "no_edit", links };
    const pinned = edit.items.flatMap((i) => (i.visual.kind === "video" ? [i.visual.attemptId] : []));
    const media = await loadEditMediaFacts(data, episode.id, pinned);
    return continuityPage({ data, episode, edit, media });
  } catch (err) {
    if (err instanceof EpisodeEditError) return { state: "error", message: err.message, links };
    const reference = Math.random().toString(36).slice(2, 10);
    console.error(
      `[continuity-supervisor-page] ${reference}`,
      redactText(err instanceof Error ? (err.stack ?? err.message) : err),
    );
    return {
      state: "error",
      message: `The Continuity Supervisor could not read this Episode's edit. Nothing was changed. (ref ${reference})`,
      links,
    };
  }
}

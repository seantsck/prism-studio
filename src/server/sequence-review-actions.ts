"use server";

import { revalidatePath } from "next/cache";
import {
  SequenceReviewError,
  submitSequenceReview,
  type SequenceSelection,
} from "@/continuity/sequence-review";
import { buildEpisodeEditView } from "@/domain/edit/view";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { loadEditMediaFacts } from "./episode-edit-media";
import { getEpisodeEditRepo } from "./episode-edits";
import { getAnalysisConfig, getAnalysisProviders, getDeliveryDeps, getMediaQaRepo } from "./media-qa";
import { getRepo, requireProjectFresh } from "./repo";

/**
 * Phase 3A.4D: the person's CONFIRMATION of a manual Sequence Continuity review of selected cuts. Everything is
 * re-read here, server-side: the Project, the persisted edit, its media facts, the Project's QA policy and the server's
 * analyzer + spend configuration. The browser supplies only which cuts were reviewed (with the truth it was shown, so a
 * changed cut is refused), the analyzer id, a nonce and the confirmation. No identity, cost or policy is trusted from it.
 */
async function startSequenceReview_impl(form: FormData) {
  const slug = String(form.get("projectSlug") ?? "");
  const episodeId = String(form.get("episodeId") ?? "");
  const data = await requireProjectFresh(slug);
  const episode = data.episodes.find((e) => e.id === episodeId);
  if (!episode) throw new UserFacingError("That Episode no longer exists.");
  const provider = getAnalysisProviders().get(String(form.get("analyzer") ?? ""));
  if (!provider) throw new UserFacingError("That analyzer is not available on this server.");
  const selections: SequenceSelection[] = form.getAll("cut").map((v) => {
    const [transitionKey, subjectFingerprint, criteriaFingerprint, referenceFingerprint] =
      String(v).split("|");
    return {
      transitionKey: transitionKey ?? "",
      subjectFingerprint: subjectFingerprint ?? "",
      criteriaFingerprint: criteriaFingerprint ?? "",
      referenceFingerprint: referenceFingerprint ?? "",
    };
  });
  const edit = await (await getEpisodeEditRepo()).getForEpisode(data.project.id, episode.id);
  if (!edit) throw new UserFacingError("This Episode has no persisted edit.");
  const pinned = edit.items.flatMap((i) => (i.visual.kind === "video" ? [i.visual.attemptId] : []));
  const view = buildEpisodeEditView(data, edit, await loadEditMediaFacts(data, episode.id, pinned));
  const userId = (await getRepo()).currentUserId();
  const config = getAnalysisConfig();
  // the submitting path starts the memory demo's worker (Supabase mode runs `npm run continuity:worker`)
  const qa = await getMediaQaRepo();
  try {
    await submitSequenceReview({
      data,
      view,
      selections,
      provider,
      qaPolicy: await qa.getQaPolicy(data.project.id),
      paid: config.paid,
      deps: await getDeliveryDeps(userId),
      confirmed: form.get("confirm") === "1",
      nonce: String(form.get("nonce") ?? "") || crypto.randomUUID(),
      limits: config.limits,
    });
  } catch (err) {
    if (err instanceof SequenceReviewError) throw new UserFacingError(err.message);
    throw err;
  }
  revalidatePath(`/projects/${slug}`, "layout");
}

export async function startSequenceReview(form: FormData): Promise<ActionResult> {
  return runAction(() => startSequenceReview_impl(form), { name: "startSequenceReview" });
}

import "server-only";
import { randomUUID } from "node:crypto";
import {
  loadSequenceAutoState,
  sequenceAutoView,
  type SequenceAutoView,
} from "@/continuity/sequence-automation";
import { findEdgeAssets, previewSequenceReview } from "@/continuity/sequence-review";
import { isAnalysisActive } from "@/domain/continuity/analysis/job-state";
import { buildEpisodeCuts } from "@/domain/continuity/sequence";
import { sequenceStatusOf, type SequenceStatus } from "@/domain/continuity/sequence-status";
import { EpisodeEditError } from "@/data/episode-edit-repository";
import type { TransitionRunView } from "@/data/media-qa-repository";
import { buildEpisodeEditView } from "@/domain/edit/view";
import type { Episode, ProjectData } from "@/domain/schemas";
import { redactText } from "@/lib/auth/redact";
import {
  continuityPage,
  supervisorLinks,
  type ContinuityPageVM,
} from "@/components/views/sequence-continuity-model";
import { loadEditMediaFacts } from "./episode-edit-media";
import { getEpisodeEditRepo } from "./episode-edits";
import {
  getAnalysisConfig,
  getMediaProcessor,
  getMediaQaRepo,
  getPreviewProviders,
  sequenceAutoDeps,
} from "./media-qa";

/**
 * The Continuity Supervisor page's READ (Phase 3A.4B, extended by 3A.4D): the persisted edit and its media facts, the
 * stored transition runs of its cuts, and, when cuts were selected (`?review=`), the exact review disclosure. It writes
 * nothing: no edit, transition run, job, Asset or derivation exists afterwards that did not exist before, and the
 * analysis worker is never started (`startInlineWorker: false`). A failure is reported, never papered over.
 */
export async function loadContinuityPage(
  data: ProjectData,
  episode: Episode,
  query: { review?: string[]; analyzer?: string | null } = {},
): Promise<ContinuityPageVM> {
  const links = supervisorLinks(data, episode);
  try {
    const edit = await (await getEpisodeEditRepo()).getForEpisode(data.project.id, episode.id);
    if (!edit) return { state: "no_edit", links };
    const pinned = edit.items.flatMap((i) => (i.visual.kind === "video" ? [i.visual.attemptId] : []));
    const media = await loadEditMediaFacts(data, episode.id, pinned);
    const qa = await getMediaQaRepo({ startInlineWorker: false });
    const transitionRuns = new Map<string, TransitionRunView[]>();
    for (const latest of await qa.listLatestEditTransitionRuns(data.project.id, edit.id)) {
      const key = latest.subject.transitionKey;
      const all = await qa.listTransitionRuns(data.project.id, key);
      transitionRuns.set(
        key,
        [...all].sort((a, b) => b.run.runNumber - a.run.runNumber),
      );
    }
    const providers = getPreviewProviders();
    const analyzers = [...providers.values()]
      .filter((p) => p.analysisVersion("sequence_transition") != null)
      .map((p) => ({ id: p.id, label: p.label }));
    const selectedAnalyzer =
      query.analyzer && providers.has(query.analyzer) ? query.analyzer : (analyzers[0]?.id ?? null);
    let review: { disclosure: ReturnType<typeof previewSequenceReview>; nonce: string } | null = null;
    if (query.review?.length && selectedAnalyzer) {
      const now = new Date();
      const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
      const view = buildEpisodeEditView(data, edit, media);
      // read-only lookup of already-derived edge media (by derivation key): the disclosure is then EXACT
      const edges = new Map<string, NonNullable<Awaited<ReturnType<typeof findEdgeAssets>>>>();
      for (const cut of buildEpisodeCuts({ data, view }).filter((c) =>
        query.review!.includes(c.transitionKey),
      )) {
        const found = await findEdgeAssets({
          cut,
          processor: getMediaProcessor(),
          qa,
          projectId: data.project.id,
        }).catch(() => null); // no processor here: the disclosure stays an (explicitly labelled) estimate
        if (found) edges.set(cut.transitionKey, found);
      }
      review = {
        disclosure: previewSequenceReview({
          data,
          view,
          edges,
          transitionKeys: query.review,
          provider: providers.get(selectedAnalyzer)!,
          qaPolicy: await qa.getQaPolicy(data.project.id),
          paid: getAnalysisConfig().paid,
          spentLast24hUsd: await qa.analysisSpentSince(null, since),
          projectSpentLast24hUsd: await qa.analysisSpentSince(data.project.id, since),
          now,
        }),
        // one confirmation = one nonce: a re-sent confirmation of THIS disclosure replays instead of duplicating
        nonce: randomUUID(),
      };
    }
    // automation status is advisory: a failure to read it never hides the deterministic Supervisor
    let autoSequence: SequenceAutoView | null = null;
    let sequenceStatus: SequenceStatus | null = null;
    try {
      const state = await loadSequenceAutoState({
        data,
        view: buildEpisodeEditView(data, edit, media),
        policy: await qa.getQaPolicy(data.project.id),
        deps: await sequenceAutoDeps(qa),
        now: new Date(),
      });
      autoSequence = sequenceAutoView(state);
      sequenceStatus = sequenceStatusOf({
        editJobs: await qa.listEditTransitionAnalysisJobs(data.project.id, edit.id),
        projectActiveJobs: await qa.listActiveProjectAnalysisJobs(data.project.id),
        isActive: isAnalysisActive,
      });
    } catch (err) {
      console.error(
        "[continuity-supervisor-page] automation",
        redactText(err instanceof Error ? err.message : err),
      );
    }
    return {
      ...continuityPage({
        data,
        episode,
        edit,
        media,
        transitionRuns,
        review,
        analyzers,
        selectedAnalyzer,
      }),
      autoSequence,
      sequenceStatus,
      episodeId: episode.id,
    };
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

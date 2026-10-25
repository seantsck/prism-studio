import "server-only";
import type { AttemptMediaFacts, EditMediaFacts } from "@/domain/edit/eligibility";
import { isShotOutputAttempt } from "@/domain/generation/schemas";
import type { ProjectData } from "@/domain/schemas";
import { getCandidateRepo } from "./candidates";
import { getGenerationRepo } from "./generation";
import { getMediaQaRepo } from "./media-qa";

/**
 * The generation media facts an Episode's edit and proposal need (`EditMediaFacts`, src/domain/edit/eligibility.ts),
 * read for the CURRENT user (RLS-bound in Supabase mode) from the generation, media and candidate repositories:
 *   per succeeded Shot-output attempt of the Episode's Shots (and of any attempt the edit pins): its outputs, its
 *   `slot = 'delivery'` versions with their parents, and its selected delivery master;
 *   per candidate set of those Shots: the current Best (advisory only).
 * Read only: nothing here writes, selects, approves or follows anything.
 */
export async function loadEditMediaFacts(
  data: ProjectData,
  episodeId: string,
  pinnedAttemptIds: readonly string[] = [],
): Promise<EditMediaFacts> {
  const shotIds = new Set(data.shots.filter((s) => s.episodeId === episodeId).map((s) => s.id));
  const pinned = new Set(pinnedAttemptIds);
  const attempts = data.attempts.filter(
    (a) => pinned.has(a.id) || (shotIds.has(a.shotId) && a.status === "succeeded" && isShotOutputAttempt(a)),
  );
  if (attempts.length === 0 && shotIds.size === 0) return { attempts: new Map(), bestPointers: [] };

  const [generation, mediaQa, candidates] = await Promise.all([
    getGenerationRepo(),
    getMediaQaRepo(),
    getCandidateRepo(),
  ]);
  const [deliveries, sets] = await Promise.all([
    mediaQa.listProjectDeliveries(data.project.id),
    candidates.listSets(data.project.id),
  ]);
  const facts = await Promise.all(
    attempts.map(async (attempt): Promise<AttemptMediaFacts> => {
      const [view, derived] = await Promise.all([
        generation.getAttemptView(attempt.id),
        mediaQa.listAttemptDerivations(attempt.id),
      ]);
      return {
        attemptId: attempt.id,
        outputs: (view?.outputs ?? []).map((o) => ({ assetId: o.output.assetId, role: o.output.role })),
        deliveryVersions: derived
          .filter((d) => d.derivation.slot === "delivery")
          .map((d) => ({
            assetId: d.asset.id,
            parentAssetId: d.derivation.parentAssetId,
            version: d.derivation.version,
          })),
        deliveryAssetId: deliveries.find((d) => d.attemptId === attempt.id)?.assetId ?? null,
      };
    }),
  );
  return {
    attempts: new Map(facts.map((f) => [f.attemptId, f])),
    bestPointers: sets
      .filter((v) => shotIds.has(v.set.shotId))
      .map((v) => ({ setId: v.set.id, shotId: v.set.shotId, attemptId: v.set.preferredAttemptId })),
  };
}

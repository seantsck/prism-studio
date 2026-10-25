import { canonicalJson, sha256 } from "@/domain/hash";
import type { EditProposal } from "./proposal";

/**
 * The identity of an initial-assembly proposal AS IT WOULD BE PERSISTED: the Episode, the edit rate and, per item in
 * order, the Shot, the exact picture (kind + references + times), the clip-audio policy, the exact performance
 * placements and their basis. Reasons and notes are explanation, not decisions, and are left out (a Best change that
 * proposes nothing different does not make a proposal stale).
 *
 * The Episode Edit page shows a proposal with its key; "Create edit" sends only the key. The server recomputes the
 * proposal from the CURRENT project and creates it only when the key is unchanged, so what is persisted is exactly
 * what the user reviewed, built from server-side facts (no client-supplied source id is ever trusted). Not stored.
 */
export function proposalKey(proposal: EditProposal): string {
  return sha256(
    canonicalJson({
      episodeId: proposal.episodeId,
      editRate: proposal.editRate,
      items: proposal.items.map((i) => ({
        shotId: i.shotId,
        visual: i.visual,
        sourceAudio: i.sourceAudio,
        performance: i.performance,
        performanceBasis: i.performanceBasis,
      })),
    }),
  );
}

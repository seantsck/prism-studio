import "server-only";
import type { StoryProposalRecord } from "@/data/story-repository";
import type { ProjectData } from "@/domain/schemas";
import { defaultReview, proposalMatches, type ProposalReview } from "@/domain/story/review";
import { carryReview } from "@/story/worker";

/**
 * Phase 5B-S1: the review as the creator left it — the stored one, or on first view the default: everything selected,
 * possible matches against the project's CURRENT Characters / Locations surfaced (on the web, never by the worker), and
 * a revision's earlier decisions carried for items that still exist. Not a server action.
 */
export async function reviewOf(
  record: StoryProposalRecord,
  data: Pick<ProjectData, "characters" | "locations">,
  parent?: StoryProposalRecord | null,
): Promise<ProposalReview | null> {
  if (record.review) return record.review;
  if (!record.proposal) return null;
  const fresh = defaultReview(record.proposal, proposalMatches(record.proposal, data));
  return parent?.review ? carryReview(fresh, parent.review) : fresh;
}

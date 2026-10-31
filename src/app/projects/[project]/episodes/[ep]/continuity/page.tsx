import { notFound } from "next/navigation";
import { SequenceContinuityView } from "@/components/views/sequence-continuity-view";
import { loadContinuityPage } from "@/server/sequence-continuity-page";
import { requireProject } from "@/server/repo";

/**
 * The Continuity Supervisor of the Episode's persisted edit (3A.4B), with 3A.4D's manual Sequence Continuity review:
 * `?review=<cut>&review=<cut>&analyzer=<id>` only DISCLOSES what a review would do (a read); confirming is a server
 * action.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ project: string; ep: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { project: slug, ep } = await params;
  const q = await searchParams;
  const data = await requireProject(slug);
  const episode = data.episodes.find((e) => e.slug === ep);
  if (!episode) notFound();
  const review = q.review == null ? [] : Array.isArray(q.review) ? q.review : [q.review];
  const page = await loadContinuityPage(data, episode, {
    review: review.filter(Boolean),
    analyzer: typeof q.analyzer === "string" ? q.analyzer : null,
  });
  return <SequenceContinuityView episode={episode} page={page} />;
}

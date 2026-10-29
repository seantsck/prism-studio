import { notFound } from "next/navigation";
import { SequenceContinuityView } from "@/components/views/sequence-continuity-view";
import { loadContinuityPage } from "@/server/sequence-continuity-page";
import { requireProject } from "@/server/repo";

/** Phase 3A.4B: the Continuity Supervisor of the Episode's persisted edit (read-only, deterministic). */
export default async function Page({ params }: { params: Promise<{ project: string; ep: string }> }) {
  const { project: slug, ep } = await params;
  const data = await requireProject(slug);
  const episode = data.episodes.find((e) => e.slug === ep);
  if (!episode) notFound();
  const page = await loadContinuityPage(data, episode);
  return <SequenceContinuityView episode={episode} page={page} />;
}

import { notFound } from "next/navigation";
import { EpisodeEditView } from "@/components/views/episode-edit-view";
import { loadEpisodeEditPage } from "@/server/episode-edit-page";
import { requireProject } from "@/server/repo";

/** Phase 2I.1C: the Episode's persisted edit (read-only), or the proposed initial assembly when none exists yet. */
export default async function Page({ params }: { params: Promise<{ project: string; ep: string }> }) {
  const { project: slug, ep } = await params;
  const data = await requireProject(slug);
  const episode = data.episodes.find((e) => e.slug === ep);
  if (!episode) notFound();
  const page = await loadEpisodeEditPage(data, episode.id);
  return <EpisodeEditView data={data} episode={episode} page={page} />;
}

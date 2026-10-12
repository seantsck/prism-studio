import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { EpisodeSwitcher, NoEpisode } from "@/components/shared";
import type { Episode, ProjectData } from "@/domain/schemas";
import { pickEpisode } from "@/lib/paths";
import { requireProject } from "@/server/repo";

type Render = (data: ProjectData, episode: Episode) => ReactNode;

/** Project-level, episode-scoped page: episode chosen via `?ep=slug`, defaulting to the first episode. */
export async function ProjectEpisodePage({
  params,
  searchParams,
  subPath,
  render,
}: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ ep?: string }>;
  subPath: string;
  render: Render;
}) {
  const { project: slug } = await params;
  const { ep } = await searchParams;
  const data = await requireProject(slug);
  const episode = pickEpisode(data, ep);
  if (!episode) return <NoEpisode slug={slug} />;
  return (
    <div>
      <div className="flex items-center gap-3 border-b border-line bg-panel px-6 py-1.5 text-[11.5px]">
        <span className="text-faint">Episode</span>
        <EpisodeSwitcher data={data} current={episode} basePath={`/projects/${slug}${subPath}`} />
      </div>
      {render(data, episode)}
    </div>
  );
}

/** Route inside `/episodes/[ep]/…`. */
export async function EpisodeRoutePage({
  params,
  render,
}: {
  params: Promise<{ project: string; ep: string }>;
  render: Render;
}) {
  const { project: slug, ep } = await params;
  const data = await requireProject(slug);
  const episode = data.episodes.find((e) => e.slug === ep);
  if (!episode) notFound();
  return <>{render(data, episode)}</>;
}

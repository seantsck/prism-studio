import { notFound } from "next/navigation";
import { ShotPrepView } from "@/components/views/shot-prep-view";
import { requireProject } from "@/server/repo";

export default async function ShotPrepPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string; ep: string; shotId: string }>;
  searchParams: Promise<{ section?: string }>;
}) {
  const { project: slug, ep, shotId } = await params;
  const { section } = await searchParams;
  const data = await requireProject(slug);
  const episode = data.episodes.find((e) => e.slug === ep);
  if (!episode || !data.shots.some((s) => s.id === shotId)) notFound();
  return <ShotPrepView data={data} episode={episode} shotId={shotId} openSection={section} />;
}

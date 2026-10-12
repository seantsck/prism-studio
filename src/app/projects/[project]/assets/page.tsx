import { AssetLibraryView } from "@/components/views/assets-view";
import { requireProject } from "@/server/repo";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ filter?: string; q?: string; asset?: string }>;
}) {
  const { project: slug } = await params;
  const data = await requireProject(slug);
  return <AssetLibraryView data={data} base={`/projects/${slug}/assets`} searchParams={await searchParams} />;
}

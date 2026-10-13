import { ProjectEpisodePage } from "@/components/episode-pages";
import { GenerationsView } from "@/components/views/generations-view";

export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{
    ep?: string;
    status?: string;
    provider?: string;
    model?: string;
    scene?: string;
    review?: string;
  }>;
}) {
  const filters = await props.searchParams;
  return (
    <ProjectEpisodePage
      params={props.params}
      searchParams={props.searchParams}
      subPath="/generations"
      render={(data, episode) => <GenerationsView data={data} episode={episode} filters={filters} />}
    />
  );
}

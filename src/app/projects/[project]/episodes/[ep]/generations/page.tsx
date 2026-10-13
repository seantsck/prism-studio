import { EpisodeRoutePage } from "@/components/episode-pages";
import { GenerationsView } from "@/components/views/generations-view";

export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ project: string; ep: string }>;
  searchParams: Promise<{
    status?: string;
    provider?: string;
    model?: string;
    scene?: string;
    review?: string;
  }>;
}) {
  const filters = await props.searchParams;
  return (
    <EpisodeRoutePage
      params={props.params}
      render={(data, episode) => <GenerationsView data={data} episode={episode} filters={filters} />}
    />
  );
}

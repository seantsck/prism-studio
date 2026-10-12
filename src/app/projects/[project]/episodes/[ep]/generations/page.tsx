import { EpisodeRoutePage } from "@/components/episode-pages";
import { GenerationsView } from "@/components/views/generations-view";

export default function Page(props: { params: Promise<{ project: string; ep: string }> }) {
  return (
    <EpisodeRoutePage
      {...props}
      render={(data, episode) => <GenerationsView data={data} episode={episode} />}
    />
  );
}

import { EpisodeRoutePage } from "@/components/episode-pages";
import { ShotsView } from "@/components/views/shots-view";

export default function Page(props: { params: Promise<{ project: string; ep: string }> }) {
  return (
    <EpisodeRoutePage {...props} render={(data, episode) => <ShotsView data={data} episode={episode} />} />
  );
}

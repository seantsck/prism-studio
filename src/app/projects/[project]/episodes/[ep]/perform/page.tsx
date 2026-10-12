import { EpisodeRoutePage } from "@/components/episode-pages";
import { PerformView } from "@/components/views/perform-view";

export default function Page(props: { params: Promise<{ project: string; ep: string }> }) {
  return (
    <EpisodeRoutePage {...props} render={(data, episode) => <PerformView data={data} episode={episode} />} />
  );
}

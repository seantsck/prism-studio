import { EpisodeRoutePage } from "@/components/episode-pages";
import { ScenesView } from "@/components/views/scenes-view";

export default function Page(props: { params: Promise<{ project: string; ep: string }> }) {
  return (
    <EpisodeRoutePage {...props} render={(data, episode) => <ScenesView data={data} episode={episode} />} />
  );
}

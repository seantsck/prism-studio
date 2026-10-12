import { EpisodeRoutePage } from "@/components/episode-pages";
import { AssetsView } from "@/components/views/assets-view";

export default function Page(props: { params: Promise<{ project: string; ep: string }> }) {
  return (
    <EpisodeRoutePage {...props} render={(data, episode) => <AssetsView data={data} episode={episode} />} />
  );
}

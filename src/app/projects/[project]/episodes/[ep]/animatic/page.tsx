import { EpisodeRoutePage } from "@/components/episode-pages";
import { AnimaticView } from "@/components/views/animatic-view";

export default function Page(props: { params: Promise<{ project: string; ep: string }> }) {
  return (
    <EpisodeRoutePage {...props} render={(data, episode) => <AnimaticView data={data} episode={episode} />} />
  );
}

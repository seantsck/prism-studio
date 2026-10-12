import { EpisodeRoutePage } from "@/components/episode-pages";
import { StoryboardView } from "@/components/views/storyboard-view";

export default function Page(props: { params: Promise<{ project: string; ep: string }> }) {
  return (
    <EpisodeRoutePage
      {...props}
      render={(data, episode) => <StoryboardView data={data} episode={episode} />}
    />
  );
}

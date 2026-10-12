import { EpisodeRoutePage } from "@/components/episode-pages";
import { BreakdownView } from "@/components/views/breakdown-view";

export default function Page(props: { params: Promise<{ project: string; ep: string }> }) {
  return (
    <EpisodeRoutePage {...props} render={(data, episode) => <BreakdownView data={data} episode={episode} />} />
  );
}

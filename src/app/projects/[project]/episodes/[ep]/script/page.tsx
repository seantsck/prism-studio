import { EpisodeRoutePage } from "@/components/episode-pages";
import { ScriptView } from "@/components/views/script-view";

export default function Page(props: { params: Promise<{ project: string; ep: string }> }) {
  return (
    <EpisodeRoutePage {...props} render={(data, episode) => <ScriptView data={data} episode={episode} />} />
  );
}

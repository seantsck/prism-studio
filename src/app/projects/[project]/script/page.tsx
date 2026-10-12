import { ProjectEpisodePage } from "@/components/episode-pages";
import { ScriptView } from "@/components/views/script-view";

export default function Page(props: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ ep?: string }>;
}) {
  return (
    <ProjectEpisodePage
      {...props}
      subPath="/script"
      render={(data, episode) => <ScriptView data={data} episode={episode} />}
    />
  );
}

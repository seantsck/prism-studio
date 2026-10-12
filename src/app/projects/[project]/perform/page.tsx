import { ProjectEpisodePage } from "@/components/episode-pages";
import { PerformView } from "@/components/views/perform-view";

export default function Page(props: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ ep?: string }>;
}) {
  return (
    <ProjectEpisodePage
      {...props}
      subPath="/perform"
      render={(data, episode) => <PerformView data={data} episode={episode} />}
    />
  );
}

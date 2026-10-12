import { ProjectEpisodePage } from "@/components/episode-pages";
import { BreakdownView } from "@/components/views/breakdown-view";

export default function Page(props: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ ep?: string }>;
}) {
  return (
    <ProjectEpisodePage
      {...props}
      subPath="/breakdown"
      render={(data, episode) => <BreakdownView data={data} episode={episode} />}
    />
  );
}

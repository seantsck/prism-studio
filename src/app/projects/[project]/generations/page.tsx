import { ProjectEpisodePage } from "@/components/episode-pages";
import { GenerationsView } from "@/components/views/generations-view";

export default function Page(props: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ ep?: string }>;
}) {
  return (
    <ProjectEpisodePage
      {...props}
      subPath="/generations"
      render={(data, episode) => <GenerationsView data={data} episode={episode} />}
    />
  );
}

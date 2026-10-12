import { ProjectEpisodePage } from "@/components/episode-pages";
import { StoryboardView } from "@/components/views/storyboard-view";

export default function Page(props: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ ep?: string }>;
}) {
  return (
    <ProjectEpisodePage
      {...props}
      subPath="/storyboard"
      render={(data, episode) => <StoryboardView data={data} episode={episode} />}
    />
  );
}

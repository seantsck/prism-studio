import { ProjectEpisodePage } from "@/components/episode-pages";
import { AnimaticView } from "@/components/views/animatic-view";

export default function Page(props: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ ep?: string }>;
}) {
  return (
    <ProjectEpisodePage
      {...props}
      subPath="/animatic"
      render={(data, episode) => <AnimaticView data={data} episode={episode} />}
    />
  );
}

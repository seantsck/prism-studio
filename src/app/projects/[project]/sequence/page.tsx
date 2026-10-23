import { ProjectEpisodePage } from "@/components/episode-pages";
import { SequenceView } from "@/components/views/sequence-view";

export default async function Page(props: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ ep?: string; compare?: string }>;
}) {
  const [{ project }, { compare }] = await Promise.all([props.params, props.searchParams]);
  return (
    <ProjectEpisodePage
      {...props}
      subPath="/sequence"
      render={(data, episode) => (
        <SequenceView
          data={data}
          episode={episode}
          basePath={`/projects/${project}/sequence?ep=${episode.slug}`}
          compareShotId={compare ?? null}
        />
      )}
    />
  );
}

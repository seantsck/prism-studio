import { EpisodeRoutePage } from "@/components/episode-pages";
import { SequenceView } from "@/components/views/sequence-view";

export default async function Page(props: {
  params: Promise<{ project: string; ep: string }>;
  searchParams: Promise<{ compare?: string }>;
}) {
  const [{ project, ep }, { compare }] = await Promise.all([props.params, props.searchParams]);
  return (
    <EpisodeRoutePage
      params={props.params}
      render={(data, episode) => (
        <SequenceView
          data={data}
          episode={episode}
          basePath={`/projects/${project}/episodes/${ep}/sequence`}
          compareShotId={compare ?? null}
        />
      )}
    />
  );
}

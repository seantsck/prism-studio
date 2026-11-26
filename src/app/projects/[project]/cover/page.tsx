import { CoverArtPanel } from "@/components/projects/cover-art";
import { PageHeader, Panel } from "@/components/ui";
import { requireUser } from "@/server/auth";
import { coverArtState } from "@/server/cover-art";
import { requireProject } from "@/server/repo";
import { MAX_SUBJECT_DIRECTION_CHARS } from "@/domain/generation/subject-image";

export const dynamic = "force-dynamic";

/** Cover art for the project: make posters with Prism and choose the cover (the title is laid over it). */
export default async function CoverArtPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>;
  /** `direction`: the cover description written on the front page's cover box */
  searchParams: Promise<{ direction?: string }>;
}) {
  const { project: slug } = await params;
  const { direction } = await searchParams;
  const user = await requireUser();
  const data = await requireProject(slug);
  const state = await coverArtState(data, user.kind === "supabase" ? user.id : null);
  return (
    <div>
      <PageHeader
        title="Cover art"
        subtitle="A poster for your project, in the shape you choose. You see the price before anything is made."
      />
      <div className="p-6">
        <Panel title="Cover art">
          <CoverArtPanel
            slug={slug}
            title={data.project.title}
            state={state}
            initialDirection={(direction ?? "").slice(0, MAX_SUBJECT_DIRECTION_CHARS)}
          />
        </Panel>
      </div>
    </div>
  );
}

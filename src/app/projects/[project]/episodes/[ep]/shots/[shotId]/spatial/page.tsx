import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { VirtualSetLoader } from "@/components/previs/virtual-set-loader";
import { shotPrepSetHref } from "@/domain/previs/spatial-workspace";
import { shotPath } from "@/lib/paths";
import { getPrevisRepo } from "@/server/previs";
import { requireProject } from "@/server/repo";
import { loadVirtualSetProps } from "@/server/virtual-set-props";

export const dynamic = "force-dynamic";

/**
 * Phase 4C-I2: the Shot-centric Spatial Workspace. The ROUTE owns the Shot (there is no Shot selector here), and the
 * Shot's CURRENT Location decides the one set it opens (`shot.spatial.locationId` -> that Location's
 * `location_scene_documents` row). Location assignment stays a Shot Prep operation, so this page can never change
 * story intent. 3D stays optional: with no Location the editor is not mounted at all and nothing is created.
 */
export default async function ShotSpatialWorkspacePage({
  params,
}: {
  params: Promise<{ project: string; ep: string; shotId: string }>;
}) {
  const { project: slug, ep, shotId } = await params;
  const data = await requireProject(slug);
  const episode = data.episodes.find((e) => e.slug === ep);
  const shot = data.shots.find((s) => s.id === shotId);
  if (!episode || !shot || shot.episodeId !== episode.id) notFound();

  const prepHref = shotPath(slug, episode.slug, shot.id);
  const location = shot.spatial.locationId
    ? (data.locations.find((l) => l.id === shot.spatial.locationId) ?? null)
    : null;
  const header = (
    <>
      <PageHeader
        title={`Spatial Workspace — Shot ${shot.shotCode}`}
        subtitle={`Episode ${episode.number} · ${episode.title}${location ? ` · ${location.name}` : ""}. Frame this Shot's camera, block and light it, capture a Master Frame, and choose a Production Frame.`}
      />
      <div className="flex gap-3 px-6 pb-1 text-xs text-muted">
        <Link href={prepHref} className="underline" data-testid="back-to-shot-prep">
          ← Shot Prep
        </Link>
      </div>
    </>
  );

  if (!location) {
    return (
      <div>
        {header}
        <div
          className="m-6 border border-dashed border-line2 p-4 text-sm"
          data-testid="workspace-no-location"
        >
          <p className="font-medium">Assign a Location to use optional spatial tools.</p>
          <p className="mt-1 text-[12px] text-muted">
            3D is optional. This Shot&apos;s Production Frame can come from its Storyboard, an upload or
            generated candidates without any 3D Set.
          </p>
          <Link
            href={shotPrepSetHref(slug, episode.slug, shot.id)}
            className="mt-2 inline-block text-[12px] text-accent underline"
            data-testid="assign-location-link"
          >
            Choose this Shot&apos;s Location
          </Link>
        </div>
      </div>
    );
  }

  const props = await loadVirtualSetProps({
    slug,
    data,
    previs: await getPrevisRepo(),
    location,
    activeShotId: shot.id,
    context: { kind: "shot", shotPrepHref: prepHref },
  });

  return (
    <div>
      {header}
      {/* keyed by the Shot AND its current Location: either change remounts one clean editor + adapter */}
      <VirtualSetLoader key={`${location.id}:${shot.id}`} {...props} />
    </div>
  );
}

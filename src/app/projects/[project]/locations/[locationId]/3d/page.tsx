import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { VirtualSetLoader } from "@/components/previs/virtual-set-loader";
import { getPrevisRepo } from "@/server/previs";
import { requireProject } from "@/server/repo";
import { loadVirtualSetProps } from "@/server/virtual-set-props";

export const dynamic = "force-dynamic";

/**
 * Location-first 3D Set management (Phase 2F onwards). Phase 4C-I2: the props come from the ONE shared loader, the
 * Shot selector NAVIGATES to `?shot=`, and the editor is keyed by Location + Shot, so a Shot change remounts it from
 * the server's state and can never keep another Shot's camera, blocking, lighting or Master Frames.
 */
export default async function VirtualSetPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string; locationId: string }>;
  searchParams: Promise<{ shot?: string }>;
}) {
  const { project: slug, locationId } = await params;
  const { shot: shotParam } = await searchParams;
  const data = await requireProject(slug);
  const location = data.locations.find((l) => l.id === locationId);
  if (!location) notFound();

  const props = await loadVirtualSetProps({
    slug,
    data,
    previs: await getPrevisRepo(),
    location,
    activeShotId: shotParam ?? null,
    context: { kind: "location" },
  });

  return (
    <div>
      <PageHeader
        title={`3D Set — ${location.name}`}
        subtitle="A persistent virtual set for this location, shared by every Shot set here. Place objects and character blocking, frame the production camera, and render a master frame."
      />
      <div className="px-6 pb-1 text-xs text-muted">
        <Link href={`/projects/${slug}/locations`} className="underline">
          ← Locations
        </Link>
      </div>
      <VirtualSetLoader key={`${location.id}:${props.activeShotId ?? "none"}`} {...props} />
    </div>
  );
}

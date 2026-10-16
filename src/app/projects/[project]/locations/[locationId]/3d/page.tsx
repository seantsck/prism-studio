import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { VirtualSetLoader } from "@/components/previs/virtual-set-loader";
import { getPrevisRepo } from "@/server/previs";
import { requireProject } from "@/server/repo";

export const dynamic = "force-dynamic";

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

  const previs = await getPrevisRepo();
  const scene = await previs.getSceneForLocation(location.id);

  // Shots set in this location (plus the shot the user came from, whatever its location currently is).
  const episodeOf = new Map(data.episodes.map((e) => [e.id, e]));
  const shots = data.shots
    .filter((s) => s.spatial.locationId === location.id || s.id === shotParam)
    .map((s) => ({
      id: s.id,
      label: `Ep ${episodeOf.get(s.episodeId)?.number ?? "?"} · Shot ${s.shotCode}`,
    }));
  const activeShotId = shotParam && shots.some((s) => s.id === shotParam) ? shotParam : null;

  const bookmark = activeShotId ? await previs.getBookmarkForShot(activeShotId) : null;
  const frames = activeShotId ? await previs.listMasterFrames(activeShotId) : [];

  return (
    <div>
      <PageHeader
        title={`3D Set — ${location.name}`}
        subtitle="A persistent virtual set for this location. Place objects and character blocking, frame the production camera, and render a master frame."
      />
      <div className="px-6 pb-1 text-xs text-muted">
        <Link href={`/projects/${slug}/locations`} className="underline">
          ← Locations
        </Link>
      </div>
      <VirtualSetLoader
        projectSlug={slug}
        locationId={location.id}
        locationName={location.name}
        scene={{
          sceneDocumentId: scene?.id ?? null,
          revision: scene?.revision ?? null,
          fingerprint: scene?.sceneFingerprint ?? null,
          engineScene: scene ? (scene.document.scene as Record<string, unknown>) : null,
        }}
        characters={data.characters.map((c) => ({ id: c.id, name: c.name }))}
        glbAssets={data.assets
          .filter((a) => a.mime === "model/gltf-binary" && a.objectPath)
          .map((a) => ({ id: a.id, name: a.name, checksum: a.checksum ?? null }))}
        shots={shots}
        activeShotId={activeShotId}
        bookmark={
          bookmark
            ? {
                id: bookmark.id,
                cameraLabel: bookmark.cameraLabel,
                sceneRevision: bookmark.sceneRevision,
                sceneFingerprint: bookmark.sceneFingerprint,
                value: bookmark.value,
              }
            : null
        }
        masterFrames={frames.map((f) => ({
          id: f.id,
          assetId: f.assetId,
          sceneRevision: f.sceneRevision,
          capturedAt: f.capturedAt,
          adopted: f.adoptedAt !== null,
        }))}
      />
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { VirtualSetLoader } from "@/components/previs/virtual-set-loader";
import { buildShotContext } from "@/domain/context";
import type { TimelineCue } from "@/domain/previs/audio-mix";
import { shotTimelineCues } from "@/domain/previs/audio-mix-shot";
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
  const cameraPath = activeShotId ? await previs.getCameraPathForShot(activeShotId) : null;
  const clips = activeShotId ? await previs.listPrevisClips(activeShotId) : [];

  // Shot timing authority: the canonical Shot duration (selected performance, else manual target) and the
  // Shot's own frame rate. Camera motion aligns to these; nothing here invents a duration.
  let shotTiming: {
    durationMs: number;
    source: string;
    frameRate: number;
    timelineCues: TimelineCue[];
    assetNames: Record<string, string>;
  } | null = null;
  if (activeShotId) {
    const shot = data.shots.find((s) => s.id === activeShotId);
    if (shot) {
      const ctx = buildShotContext(data, activeShotId);
      // the one Shot-timeline arithmetic (layoutPerformance): interactive playback and the previs mix both use it
      const { cues } = shotTimelineCues(data, activeShotId);
      const assetNames: Record<string, string> = {};
      for (const line of ctx.lines)
        if (line.selectedAudioAsset) assetNames[line.selectedAudioAsset.id] = line.selectedAudioAsset.name;
      shotTiming = {
        durationMs: ctx.duration.durationMs,
        source: ctx.duration.source,
        frameRate: shot.generation.fps,
        timelineCues: cues,
        assetNames,
      };
    }
  }

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
        shotTiming={shotTiming}
        cameraPath={
          cameraPath
            ? {
                id: cameraPath.id,
                revision: cameraPath.revision,
                sceneRevision: cameraPath.sceneRevision,
                sceneFingerprint: cameraPath.sceneFingerprint,
                pathFingerprint: cameraPath.pathFingerprint,
                path: cameraPath.path,
              }
            : null
        }
        previsClips={clips.map((c) => ({
          id: c.id,
          assetId: c.assetId,
          pathRevision: c.pathRevision,
          pathFingerprint: c.pathFingerprint,
          sceneRevision: c.sceneRevision,
          sceneFingerprint: c.sceneFingerprint,
          frameRate: c.frameRate,
          durationMs: c.durationMs,
          renderWidth: c.renderWidth,
          renderHeight: c.renderHeight,
          container: c.container,
          codec: c.codec,
          hasAudio: c.hasAudio,
          audioMixFingerprint: c.audioMixFingerprint,
          audioCodec: c.audioMix?.codec ?? null,
          renderedAt: c.renderedAt,
        }))}
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

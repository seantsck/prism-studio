import { notFound } from "next/navigation";
import { ShotPrepView } from "@/components/views/shot-prep-view";
import { audioMixFingerprint } from "@/domain/previs/audio-mix";
import { renderedBlockingFingerprint } from "@/domain/previs/blocking";
import { performanceAudioPlanForShot } from "@/domain/previs/audio-mix-shot";
import { getPrevisRepo } from "@/server/previs";
import { requireProject } from "@/server/repo";

export default async function ShotPrepPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string; ep: string; shotId: string }>;
  searchParams: Promise<{ section?: string }>;
}) {
  const { project: slug, ep, shotId } = await params;
  const { section } = await searchParams;
  const data = await requireProject(slug);
  const episode = data.episodes.find((e) => e.slug === ep);
  if (!episode || !data.shots.some((s) => s.id === shotId)) notFound();
  const previs = await getPrevisRepo();
  const clips = await previs.listPrevisClips(shotId);
  const path = await previs.getCameraPathForShot(shotId);
  // what the Shot's selected performance audio would currently render as (null = none): judges audio previs freshness
  const plan = path ? performanceAudioPlanForShot(data, shotId, path.durationMs) : null;
  // what the Shot's saved character blocking would currently show in a render (null = no visible proxies)
  const blocking = await previs.listShotBlocking(shotId);
  // the Shot's optional 3D Master Frames (none without a 3D set): only offered as a Production Frame SOURCE
  const masterFrames = (await previs.listMasterFrames(shotId)).map((m) => ({
    id: m.id,
    assetId: m.assetId,
    capturedAt: m.capturedAt,
    width: m.renderWidth,
    height: m.renderHeight,
  }));
  const currentBlockingFingerprint = blocking.length
    ? renderedBlockingFingerprint(
        blocking.map((b) => b.entry),
        { locationId: blocking[0]!.locationId },
      )
    : null;
  return (
    <ShotPrepView
      data={data}
      episode={episode}
      shotId={shotId}
      openSection={section}
      masterFrames={masterFrames}
      previs={{
        pathFingerprint: path?.pathFingerprint ?? null,
        pathRevision: path?.revision ?? null,
        keyframeCount: path?.path.keyframes.length ?? 0,
        durationMs: path?.durationMs ?? null,
        currentAudioMixFingerprint: plan ? audioMixFingerprint(plan) : null,
        currentBlockingFingerprint,
        clips: clips.map((c) => ({
          id: c.id,
          assetId: c.assetId,
          pathRevision: c.pathRevision,
          pathFingerprint: c.pathFingerprint,
          sceneFingerprint: c.sceneFingerprint,
          renderedAt: c.renderedAt,
          container: c.container,
          codec: c.codec,
          hasAudio: c.hasAudio,
          audioMixFingerprint: c.audioMixFingerprint,
          blockingFingerprint: c.blockingFingerprint,
        })),
      }}
    />
  );
}

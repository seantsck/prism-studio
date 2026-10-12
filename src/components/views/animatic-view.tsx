import { AnimaticPlayer, type ClipVM } from "@/components/animatic-player";
import { Badge, PageHeader } from "@/components/ui";
import { buildAnimaticTimeline } from "@/domain/animatic";
import { formatDuration } from "@/domain/duration";
import type { Episode, ProjectData } from "@/domain/schemas";
import { assetUrl } from "@/lib/utils";

export function AnimaticView({ data, episode }: { data: ProjectData; episode: Episode }) {
  const timeline = buildAnimaticTimeline(data, episode.id);
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const shots = new Map(data.shots.map((s) => [s.id, s]));

  const clips: ClipVM[] = timeline.clips.map((c) => {
    const shot = shots.get(c.shotId)!;
    const frameAsset = c.frame?.assetId ? assets.get(c.frame.assetId) : undefined;
    return {
      shotId: c.shotId,
      shotCode: c.shotCode,
      title: c.title,
      sceneId: c.sceneId,
      sceneNumber: c.sceneNumber,
      startMs: c.startMs,
      durationMs: c.durationMs,
      durationSource: c.durationSource,
      durationMode: shot.durationMode,
      hasDialogue: shot.audio.dialogueLineIds.length > 0,
      frameUrl: assetUrl(frameAsset),
      frameLabel: [shot.composition.shotSize, shot.composition.framing].filter(Boolean).join(" · "),
      frameApproved: c.frame?.approved ?? false,
      hasFrame: Boolean(c.frame),
      frameFreshness: c.frameFreshness,
      freshnessMessages: c.freshnessMessages,
      ambience: c.ambience,
      musicCue: c.musicCue,
      segments: c.segments.map((s) => ({
        kind: s.kind,
        label: s.label,
        startMs: s.startMs,
        endMs: s.endMs,
      })),
      cues: c.cues.map((cue) => ({
        lineId: cue.lineId,
        speaker: cue.speaker,
        text: cue.text,
        takeNumber: cue.takeNumber,
        startMs: cue.startMs,
        durationMs: cue.durationMs,
        audioUrl: cue.audioAssetId ? assetUrl(assets.get(cue.audioAssetId)) : null,
        waveform: cue.waveform,
      })),
    };
  });

  const unapproved = clips.filter((c) => !c.frameApproved).length;
  const stale = clips.filter((c) => c.frameFreshness === "stale").length;
  return (
    <div>
      <PageHeader
        title={`Animatic — ${episode.title}`}
        subtitle="Approved frames + planned durations + selected performances. Audio drives timing wherever a take is attached."
        actions={
          <>
            <Badge tone="info">Runtime {formatDuration(timeline.totalMs)}</Badge>
            <Badge tone={unapproved ? "warn" : "pass"}>{unapproved} unapproved</Badge>
            {stale ? <Badge tone="warn">{stale} stale storyboard</Badge> : null}
          </>
        }
      />
      <div className="p-6">
        {clips.length === 0 ? (
          <div className="border border-dashed border-line2 p-6 text-center text-muted">
            No shots in this episode yet.
          </div>
        ) : (
          <AnimaticPlayer
            clips={clips}
            scenes={timeline.scenes}
            totalMs={timeline.totalMs}
            projectSlug={data.project.slug}
          />
        )}
      </div>
    </div>
  );
}

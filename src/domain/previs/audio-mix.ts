import { layoutPerformance } from "../duration";
import { fingerprint } from "../hash";

/**
 * The performance audio of a local previs, as a deterministic plan on the SAME Shot timeline as the camera path.
 *
 *   Shot timing (layoutPerformance, the arithmetic behind computeShotDuration)
 *     → timeline cues (every selected take, including takes without audio)
 *       → interactive scheduler   (cues with audio, untrimmed)
 *       → offline previs mix      (PerformanceAudioPlan: cues with audio, trimmed to the rendered duration)
 *
 * Nothing here knows about browsers, files or URLs. A cue names a private Asset by id and checksum only.
 */

export const AUDIO_MIX_SCHEMA = "prism.previs-audio-mix.v1" as const;
/** Canonical previs audio format: browsers resample on decode, and every encoder we use accepts it. */
export const PREVIS_AUDIO_SAMPLE_RATE = 48_000;
export const PREVIS_AUDIO_CHANNELS = 2;

export interface TimelineTake {
  /** null = a selected take with no audio file: silent, but it still occupies its time */
  assetId: string | null;
  assetChecksum: string | null;
  durationMs: number;
}

export interface TimelineCue extends TimelineTake {
  startMs: number;
}

/** Places every selected take on the Shot timeline. `null` takes (lines with no selected take) take no time. */
export function layoutTimelineCues(
  preRollMs: number,
  interLineGapMs: number,
  takes: ReadonlyArray<TimelineTake | null>,
): TimelineCue[] {
  const layout = layoutPerformance(
    preRollMs,
    interLineGapMs,
    takes.map((t) => (t ? t.durationMs : null)),
  );
  const cues: TimelineCue[] = [];
  takes.forEach((t, i) => {
    const seg = layout.segments[i];
    if (t && seg) cues.push({ ...t, startMs: seg.startMs });
  });
  return cues;
}

export interface AudioMixCue {
  assetId: string;
  assetChecksum: string | null;
  /** where on the Shot/camera timeline this audio begins */
  timelineStartMs: number;
  /** where in the source audio it begins (0 today; trimming is representable) */
  sourceStartMs: number;
  /** how much of the source is placed (a longer file is trimmed to this; a shorter one is not stretched) */
  durationMs: number;
}

export interface PerformanceAudioPlan {
  schema: typeof AUDIO_MIX_SCHEMA;
  sampleRate: number;
  channels: number;
  /** the rendered previs duration (= the camera path duration); the mix is exactly this long */
  durationMs: number;
  /** the Shot's own duration (computeShotDuration): changes when pre-roll, takes, gaps or post-roll change */
  shotDurationMs: number;
  cues: AudioMixCue[];
}

export interface PlanInput {
  renderDurationMs: number;
  shotDurationMs: number;
  cues: ReadonlyArray<TimelineCue>;
}

/** Cues without audio produce silence and are not in the plan; cues are clipped to the rendered duration. */
export function buildPerformanceAudioPlan(input: PlanInput): PerformanceAudioPlan | null {
  const cues: AudioMixCue[] = [];
  for (const c of input.cues) {
    if (!c.assetId) continue;
    const available = input.renderDurationMs - c.startMs;
    if (available <= 0) continue;
    cues.push({
      assetId: c.assetId,
      assetChecksum: c.assetChecksum,
      timelineStartMs: c.startMs,
      sourceStartMs: 0,
      durationMs: Math.min(c.durationMs, available),
    });
  }
  if (cues.length === 0) return null;
  return {
    schema: AUDIO_MIX_SCHEMA,
    sampleRate: PREVIS_AUDIO_SAMPLE_RATE,
    channels: PREVIS_AUDIO_CHANNELS,
    durationMs: input.renderDurationMs,
    shotDurationMs: input.shotDurationMs,
    cues,
  };
}

/**
 * Identity of what the mix CONTAINS: format, rendered and Shot duration, and every cue (order, asset, checksum,
 * timeline offset, source offset, length). Playhead, volume UI, panel state and object URLs are not inputs.
 */
export function audioMixFingerprint(plan: PerformanceAudioPlan): string {
  return fingerprint({
    schema: plan.schema,
    sampleRate: plan.sampleRate,
    channels: plan.channels,
    durationMs: plan.durationMs,
    shotDurationMs: plan.shotDurationMs,
    cues: plan.cues.map((c) => ({
      assetId: c.assetId,
      assetChecksum: c.assetChecksum,
      timelineStartMs: c.timelineStartMs,
      sourceStartMs: c.sourceStartMs,
      durationMs: c.durationMs,
    })),
  });
}

/** What a stored clip says about its audio (null for a silent clip). */
export interface StoredAudioMix extends PerformanceAudioPlan {
  codec: string;
  mixFingerprint: string;
}

/**
 * The latest clip that is exactly current for a path: same camera path, and (for a clip rendered with audio) the
 * same audio mix. A silent clip stays current when only the dialogue changed.
 */
export function pickCurrentClip<
  T extends {
    pathFingerprint: string;
    audioMixFingerprint: string | null;
    /** what the clip's picture shows of the Shot's blocking (absent/null = no character proxies) */
    blockingFingerprint?: string | null;
    renderedAt: string;
  },
>(
  clips: readonly T[],
  pathFingerprint: string,
  currentAudioMixFingerprint: string | null,
  currentBlockingFingerprint: string | null = null,
): T | null {
  return (
    [...clips]
      .filter(
        (c) =>
          c.pathFingerprint === pathFingerprint &&
          (c.audioMixFingerprint === null || c.audioMixFingerprint === currentAudioMixFingerprint) &&
          (c.blockingFingerprint ?? null) === currentBlockingFingerprint,
      )
      .sort((a, b) => (a.renderedAt < b.renderedAt ? 1 : a.renderedAt > b.renderedAt ? -1 : 0))[0] ?? null
  );
}

export type PrevisStaleReason = "scene" | "camera" | "audio" | "blocking";

export interface PrevisFreshnessInput {
  clip: {
    sceneFingerprint: string;
    pathFingerprint: string;
    audioMixFingerprint: string | null;
    /** absent/null = the clip shows no character proxies */
    blockingFingerprint?: string | null;
  };
  /** null = nothing saved / unknown: the corresponding check cannot pass */
  currentSceneFingerprint: string | null;
  currentPathFingerprint: string | null;
  /** null = the Shot currently has no selected performance audio */
  currentAudioMixFingerprint: string | null;
  /** the Shot's rendered blocking layer now (null = no visible character proxies) */
  currentBlockingFingerprint?: string | null;
}

/**
 * A previs is valid for what it actually contains. A silent previs depends on the scene and the camera path only,
 * so changing dialogue never invalidates a camera test. A previs rendered WITH audio also depends on the audio mix.
 */
export function previsStaleReasons(i: PrevisFreshnessInput): PrevisStaleReason[] {
  const reasons: PrevisStaleReason[] = [];
  if (!i.currentSceneFingerprint || i.clip.sceneFingerprint !== i.currentSceneFingerprint)
    reasons.push("scene");
  if (!i.currentPathFingerprint || i.clip.pathFingerprint !== i.currentPathFingerprint)
    reasons.push("camera");
  if (i.clip.audioMixFingerprint !== null && i.clip.audioMixFingerprint !== i.currentAudioMixFingerprint)
    reasons.push("audio");
  // blocking is part of what the picture shows, silent or not
  if ((i.clip.blockingFingerprint ?? null) !== (i.currentBlockingFingerprint ?? null))
    reasons.push("blocking");
  return reasons;
}

export const STALE_REASON_LABEL: Record<PrevisStaleReason, string> = {
  scene: "STALE SCENE",
  camera: "STALE CAMERA",
  audio: "STALE AUDIO",
  blocking: "STALE BLOCKING",
};

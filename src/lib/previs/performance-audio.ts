/**
 * Interactive performance-audio scheduling for camera previs playback.
 *
 * There is ONE playback clock: the camera timeline playhead (ms from the start of the Shot). Camera motion and
 * performance audio are both consumers of it; this module owns no timer of its own that advances time. It only
 * answers "given the playhead is at T, which takes should be sounding and from which source offset", and arms a
 * one-shot start for takes that begin later. Cue offsets mirror `computeShotDuration` (pre-roll, then each selected
 * take followed by the inter-line gap) so the audio lines up with the Shot's duration.
 *
 * The encoded previs file is silent; muxing this audio is a separate, later increment.
 */

export interface AudioCue {
  assetId: string;
  startMs: number;
  durationMs: number;
}

export interface CueSource {
  preRollMs: number;
  interLineGapMs: number;
  /** One entry per dialogue line of the Shot, in order; `null` when the line has no selected take. */
  takes: ReadonlyArray<{ audioAssetId?: string | null; durationMs: number } | null>;
}

/**
 * Cue positions follow the Shot duration: every selected take advances the cursor by its duration plus the gap,
 * whether or not it has an audio asset (a take without audio is silent but still occupies its time).
 */
export function buildAudioCues(source: CueSource): AudioCue[] {
  const cues: AudioCue[] = [];
  let cursor = source.preRollMs;
  for (const take of source.takes) {
    if (!take) continue;
    if (take.audioAssetId)
      cues.push({ assetId: take.audioAssetId, startMs: cursor, durationMs: take.durationMs });
    cursor += take.durationMs + source.interLineGapMs;
  }
  return cues;
}

/** The part of HTMLAudioElement the scheduler uses, so tests can inject a fake. */
export interface AudioLike {
  currentTime: number;
  preload?: string;
  play(): Promise<void> | void;
  pause(): void;
  release?(): void;
}

export interface SchedulerEnv {
  createAudio(assetId: string): AudioLike;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export class PerformanceAudioScheduler {
  private active: AudioLike[] = [];
  private timers: unknown[] = [];
  private disposed = false;

  constructor(
    private readonly env: SchedulerEnv,
    private cues: readonly AudioCue[],
  ) {}

  setCues(cues: readonly AudioCue[]): void {
    this.cues = cues;
  }

  get activeCount(): number {
    return this.active.length;
  }

  /** (Re)start from the playhead. Always stops whatever was sounding first, so seeks never overlap. */
  start(fromMs: number): void {
    this.stop();
    if (this.disposed) return;
    const from = Math.max(0, fromMs);
    for (const cue of this.cues) {
      if (from >= cue.startMs + cue.durationMs) continue; // already past (or in the gap after) this take
      const el = this.env.createAudio(cue.assetId);
      el.preload = "auto";
      this.active.push(el);
      const play = () => void Promise.resolve(el.play()).catch(() => undefined);
      if (from >= cue.startMs) {
        el.currentTime = (from - cue.startMs) / 1000;
        play();
      } else {
        this.timers.push(this.env.setTimer(play, cue.startMs - from));
      }
    }
  }

  /** Pause/seek/end: nothing keeps sounding and no pending start can fire. */
  stop(): void {
    for (const t of this.timers) this.env.clearTimer(t);
    this.timers = [];
    for (const a of this.active) {
      a.pause();
      a.release?.();
    }
    this.active = [];
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
  }
}

/** Browser environment: real Audio elements served by the authenticated asset route. */
export function browserSchedulerEnv(): SchedulerEnv {
  return {
    createAudio: (assetId) => {
      const el = new Audio(`/api/assets/${assetId}`);
      return {
        get currentTime() {
          return el.currentTime;
        },
        set currentTime(v: number) {
          el.currentTime = v;
        },
        set preload(v: string | undefined) {
          if (v) el.preload = v as HTMLMediaElement["preload"];
        },
        play: () => el.play(),
        pause: () => el.pause(),
        release: () => {
          el.removeAttribute("src");
          el.load();
        },
      };
    },
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (h) => window.clearTimeout(h as number),
  };
}

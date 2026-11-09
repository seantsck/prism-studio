import {
  clampTimeline,
  dissolveMix,
  itemAt,
  outgoingAt,
  placementSourceMs,
  placementsAt,
  titleAt,
  videoSourceMs,
  type PlaybackItem,
  type PlaybackPlan,
  type PlaybackTitle,
} from "@/domain/edit/playback";

/**
 * Phase 2I.1E rough-sequence playback controller (framework-free; the React player wraps it).
 *
 * ONE master clock: the timeline position advances with the wall clock (`deps.now()` deltas, one frame at a time) and is
 * the only authority. Media elements FOLLOW it: on every sync the active video is pointed at
 * `source in + (t − item start)` and each sounding placement at `take in + (t − placement start)`; an element is
 * re-seeked when it is newly activated, after a seek, or when it has drifted more than `DRIFT_MS` from where the clock
 * says it should be. Media never moves the clock (no element is a timeline authority), so a slow or failed file cannot
 * stall or skip the edit: its interval still plays, shown as unavailable. Nothing here writes anything.
 */

/** One media element as the controller sees it (an HTMLMediaElement in the browser, a fake in tests). */
export interface MediaPort {
  load(url: string | null): void;
  readonly url: string | null;
  currentTimeMs(): number;
  seekMs(ms: number): void;
  play(): Promise<void>;
  pause(): void;
  setMuted(muted: boolean): void;
  /** the element reports its media cannot be loaded or decoded */
  onError(cb: () => void): void;
  dispose(): void;
}

export interface ControllerDeps {
  now(): number;
  requestFrame(cb: () => void): number;
  cancelFrame(id: number): void;
  /** the picture element of the item playing (video items) */
  video: MediaPort;
  /**
   * 5B-V3: the element of the OUTGOING item under a cross dissolve (always muted). Optional: without it a dissolve
   * shows the incoming picture over the outgoing one only when the outgoing one is a still.
   */
  under?: MediaPort;
  /** one element per sounding placement */
  createAudio(): MediaPort;
}

export interface PlaybackSnapshot {
  playing: boolean;
  timeMs: number;
  /** the playhead is at the end of the edit */
  ended: boolean;
  item: PlaybackItem | null;
  /** 5B-V3: inside a dissolve, the outgoing item still visible under `item` */
  outgoing: PlaybackItem | null;
  /** 5B-V3: how much of `item` shows (0 … 1); 1 outside a dissolve */
  mix: number;
  /** 5B-V3: the title card on screen, if any */
  title: PlaybackTitle | null;
  /** video item: where its source should be now; null otherwise */
  videoSourceMs: number | null;
  /** the outgoing video item under a dissolve: where its source should be now */
  underSourceMs: number | null;
  videoMuted: boolean;
  /** the placements sounding now, with where in its take each should be */
  placements: Array<{ key: string; sourceMs: number; audible: boolean }>;
  failedPictures: ReadonlySet<string>;
  failedTakes: ReadonlySet<string>;
  /** the browser refused to start media (e.g. no user gesture); the clock still runs */
  mediaBlocked: boolean;
}

/** How far a following element may drift from the master clock before it is re-seeked. */
export const DRIFT_MS = 250;

interface AudioEntry {
  port: MediaPort;
  started: boolean;
}

export class RoughCutController {
  private t = 0;
  private playing = false;
  private last = 0;
  private frame: number | null = null;
  private layers = {
    video: { itemId: null as string | null, started: false },
    under: { itemId: null as string | null, started: false },
  };
  private audio = new Map<string, AudioEntry>();
  private failedPictures = new Set<string>();
  private failedTakes = new Set<string>();
  private mediaBlocked = false;
  private disposed = false;

  constructor(
    private readonly plan: PlaybackPlan,
    private readonly deps: ControllerDeps,
    private readonly onChange: (s: PlaybackSnapshot) => void = () => undefined,
  ) {
    deps.video.onError(() => {
      if (this.layers.video.itemId) this.failedPictures.add(this.layers.video.itemId);
      this.emit();
    });
    deps.under?.onError(() => {
      if (this.layers.under.itemId) this.failedPictures.add(this.layers.under.itemId);
      this.emit();
    });
  }

  snapshot(): PlaybackSnapshot {
    const item = itemAt(this.plan, this.t);
    const outgoing = outgoingAt(this.plan, this.t);
    return {
      playing: this.playing,
      timeMs: this.t,
      ended: this.t >= this.plan.totalMs,
      item,
      outgoing,
      mix: item ? dissolveMix(item, this.t) : 1,
      title: titleAt(this.plan, this.t),
      videoSourceMs: item ? videoSourceMs(item, this.t) : null,
      underSourceMs: outgoing ? videoSourceMs(outgoing, this.t) : null,
      videoMuted: !(item?.clipAudio ?? false),
      placements: placementsAt(this.plan, this.t).map((p) => ({
        key: p.key,
        sourceMs: placementSourceMs(p, this.t),
        audible: Boolean(p.audioUrl) && !this.failedTakes.has(p.key),
      })),
      failedPictures: this.failedPictures,
      failedTakes: this.failedTakes,
      mediaBlocked: this.mediaBlocked,
    };
  }

  /** Starts playback (from the beginning when the playhead is at the end). Call only from a user gesture. */
  play(): void {
    if (this.disposed || this.playing || this.plan.totalMs === 0) return;
    if (this.t >= this.plan.totalMs) this.t = 0;
    this.playing = true;
    this.last = this.deps.now();
    this.sync(true);
    this.schedule();
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.frame !== null) this.deps.cancelFrame(this.frame);
    this.frame = null;
    this.pauseMedia();
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Moves the playhead; media is re-pointed at once and keeps playing only if playback is playing. */
  seek(ms: number): void {
    if (this.disposed) return;
    this.t = clampTimeline(this.plan, ms);
    this.last = this.deps.now();
    if (this.t >= this.plan.totalMs) {
      this.playing = false;
      this.pauseMedia();
    }
    this.sync(true);
    this.emit();
  }

  restart(): void {
    this.seek(0);
  }

  /** Stops everything and releases the media (the edit changed, or the page goes away). */
  dispose(): void {
    if (this.disposed) return;
    this.pause();
    this.disposed = true;
    for (const e of this.audio.values()) e.port.dispose();
    this.audio.clear();
    this.deps.video.load(null);
    this.deps.under?.load(null);
  }

  private schedule() {
    this.frame = this.deps.requestFrame(() => this.tick());
  }

  private tick() {
    this.frame = null;
    if (!this.playing || this.disposed) return;
    const now = this.deps.now();
    this.t += Math.max(0, now - this.last);
    this.last = now;
    if (this.t >= this.plan.totalMs) {
      this.t = this.plan.totalMs;
      this.playing = false;
      this.pauseMedia();
      this.sync(false);
      this.emit();
      return;
    }
    this.sync(false);
    this.emit();
    this.schedule();
  }

  private pauseMedia() {
    this.deps.video.pause();
    this.deps.under?.pause();
    this.layers.video.started = false;
    this.layers.under.started = false;
    for (const e of this.audio.values()) {
      e.port.pause();
      e.started = false;
    }
  }

  private start(port: MediaPort, onFail: () => void) {
    port.play().catch((err: unknown) => {
      if ((err as { name?: string } | null)?.name === "NotAllowedError") this.mediaBlocked = true;
      else if ((err as { name?: string } | null)?.name !== "AbortError") onFail();
      this.emit();
    });
  }

  /** Points every element at where the master clock says it should be. `force` re-seeks unconditionally. */
  private sync(force: boolean) {
    const item = itemAt(this.plan, this.t);
    // picture: the item playing, and (5B-V3) the outgoing item under a dissolve
    this.syncPicture(this.deps.video, this.layers.video, item, force, !(item?.clipAudio ?? false));
    if (this.deps.under)
      this.syncPicture(this.deps.under, this.layers.under, outgoingAt(this.plan, this.t), force, true);
    // performance: each sounding placement independently
    const sounding = placementsAt(this.plan, this.t);
    const keys = new Set(sounding.map((p) => p.key));
    for (const [key, e] of this.audio)
      if (!keys.has(key)) {
        e.port.dispose();
        this.audio.delete(key);
      }
    for (const p of sounding) {
      if (!p.audioUrl || this.failedTakes.has(p.key)) continue;
      let entry = this.audio.get(p.key);
      const expected = placementSourceMs(p, this.t);
      if (!entry) {
        const port = this.deps.createAudio();
        const key = p.key;
        port.onError(() => {
          this.failedTakes.add(key);
          this.audio.get(key)?.port.dispose();
          this.audio.delete(key);
          this.emit();
        });
        port.load(p.audioUrl);
        port.seekMs(expected);
        entry = { port, started: false };
        this.audio.set(p.key, entry);
      } else if (force || Math.abs(entry.port.currentTimeMs() - expected) > DRIFT_MS)
        entry.port.seekMs(expected);
      if (this.playing && !entry.started) {
        entry.started = true;
        const key = p.key;
        this.start(entry.port, () => this.failedTakes.add(key));
      }
    }
  }

  /** Points one picture element at `item` (or releases it), exactly as the master clock says. */
  private syncPicture(
    port: MediaPort,
    layer: { itemId: string | null; started: boolean },
    item: PlaybackItem | null,
    force: boolean,
    muted: boolean,
  ) {
    if (item && item.kind === "video" && item.pictureUrl && !this.failedPictures.has(item.itemId)) {
      const expected = videoSourceMs(item, this.t)!;
      const fresh = layer.itemId !== item.itemId || port.url !== item.pictureUrl;
      if (fresh) {
        layer.itemId = item.itemId;
        layer.started = false;
        if (port.url !== item.pictureUrl) port.load(item.pictureUrl);
      }
      if (fresh || force || Math.abs(port.currentTimeMs() - expected) > DRIFT_MS) port.seekMs(expected);
      port.setMuted(muted);
      if (this.playing && !layer.started) {
        layer.started = true;
        const id = item.itemId;
        this.start(port, () => this.failedPictures.add(id));
      }
    } else if (layer.itemId !== null) {
      port.pause();
      layer.started = false;
      layer.itemId = null;
    }
  }

  private emit() {
    if (!this.disposed) this.onChange(this.snapshot());
  }
}

"use client";

import { Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { playheadLabel } from "@/domain/edit/playback";
import { RoughCutController, type PlaybackSnapshot } from "@/lib/edit-playback/controller";
import { audioPort, DomMediaPort } from "@/lib/edit-playback/dom-media";
import type { PlaybackVM } from "./episode-edit-model";

const fmt = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
};

/**
 * Phase 2I.1E rough-sequence player: "watch this edit". Plays exactly the SAVED edit (order, pinned clips and trims,
 * still holds, no-picture intervals, pinned takes, Silence, clip-audio policy) on one master clock
 * (`RoughCutController`); media elements follow it. Starts only from a click; opening, playing, pausing and seeking
 * write nothing. The parent keys this component on the edit's revision, so a saved change disposes the old player
 * (media stopped) and a new one starts paused at 0 from the new edit: a player never plays a stale structure.
 */
export function EditPlayer({ playback }: { playback: PlaybackVM }) {
  const { plan } = playback;
  const videoRef = useRef<HTMLVideoElement>(null);
  const controller = useRef<RoughCutController | null>(null);
  const [snap, setSnap] = useState<PlaybackSnapshot | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const c = new RoughCutController(
      plan,
      {
        now: () => performance.now(),
        requestFrame: (cb) => requestAnimationFrame(() => cb()),
        cancelFrame: (id) => cancelAnimationFrame(id),
        video: new DomMediaPort(el),
        createAudio: audioPort,
      },
      setSnap,
    );
    controller.current = c;
    c.seek(0);
    return () => {
      c.dispose();
      controller.current = null;
    };
  }, [plan]);

  const item = snap?.item ?? null;
  const time = snap?.timeMs ?? 0;
  const labels = item ? playback.items[item.itemId] : undefined;
  const pictureFailed = item ? item.unavailable || (snap?.failedPictures.has(item.itemId) ?? false) : false;
  const showVideo = item?.kind === "video" && Boolean(item.pictureUrl) && !pictureFailed;
  const head = playheadLabel(plan, time);

  // the edit list follows the playhead
  useEffect(() => {
    const id = item?.itemId ?? null;
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="edit-item"][data-item-id]'))
      el.dataset.playing = el.dataset.itemId === id ? "true" : "false";
  }, [item?.itemId]);

  return (
    <section
      className="border border-line bg-panel"
      data-testid="edit-player"
      data-playing={snap?.playing ? "true" : "false"}
      data-time-ms={Math.round(time)}
      data-ended={snap?.ended ? "true" : "false"}
      data-item-id={item?.itemId ?? ""}
      data-shot-code={labels?.shotCode ?? ""}
      data-kind={item?.kind ?? ""}
      data-video-src-ms={snap?.videoSourceMs != null ? Math.round(snap.videoSourceMs) : ""}
      data-video-url={showVideo ? (item?.pictureUrl ?? "") : ""}
      data-video-muted={snap?.videoMuted ? "true" : "false"}
      data-placements={(snap?.placements ?? []).map((p) => `${p.key}@${Math.round(p.sourceMs)}`).join(",")}
    >
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Watch this edit</h2>
        <span className="text-[11px] text-faint">
          Rough-sequence preview of the saved edit (no render, no transitions)
        </span>
      </header>
      <div className="relative aspect-video max-h-[360px] w-full overflow-hidden bg-black">
        <video
          ref={videoRef}
          playsInline
          preload="auto"
          className={showVideo ? "h-full w-full object-contain" : "hidden"}
          data-testid="player-video"
        />
        {!showVideo ? (
          item &&
          (item.kind === "production_frame" || item.kind === "storyboard_frame") &&
          item.pictureUrl &&
          !pictureFailed ? (
            // eslint-disable-next-line @next/next/no-img-element -- private asset route, not a static image
            <img
              src={item.pictureUrl}
              alt={labels?.kindLabel ?? ""}
              className="h-full w-full object-contain"
            />
          ) : (
            <div
              className="flex h-full w-full flex-col items-center justify-center bg-[repeating-linear-gradient(135deg,#121215,#121215_14px,#0e0e11_14px,#0e0e11_28px)]"
              data-testid="player-slate"
            >
              <div className="font-mono text-2xl text-faint">
                {labels?.shotCode ?? (snap?.ended ? "End" : "—")}
              </div>
              <div className="mt-1 text-muted">
                {snap?.ended
                  ? "End of edit"
                  : !item
                    ? ""
                    : item.kind === "none"
                      ? "No picture"
                      : pictureFailed || !item.pictureUrl
                        ? `Source unavailable (${labels?.kindLabel ?? item.kind})`
                        : ""}
              </div>
            </div>
          )
        ) : null}
        {item ? (
          <div className="absolute left-2 top-2 flex flex-wrap gap-1.5 font-mono text-[11px]">
            <span className="bg-black/70 px-1.5 py-0.5 text-muted" data-testid="player-scene">
              {labels?.run}
            </span>
            <span className="bg-black/70 px-1.5 py-0.5 text-accent">{labels?.shotCode}</span>
            <span
              className={`bg-black/70 px-1.5 py-0.5 ${item.kind === "video" ? "text-pass" : "text-warn"}`}
              data-testid="player-kind"
            >
              {labels?.kindLabel}
            </span>
          </div>
        ) : null}
        {snap && snap.placements.length > 0 ? (
          <div className="absolute inset-x-0 bottom-2 text-center">
            {snap.placements.map((p) => (
              <div key={p.key} className="inline-block max-w-[80%] bg-black/75 px-3 py-1 text-[13px]">
                {playback.placements[p.key] ?? ""}
                {!p.audible ? <span className="ml-2 text-[10.5px] text-warn">(no audio file)</span> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-3 py-2">
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-accentfg disabled:opacity-40"
          onClick={() => controller.current?.toggle()}
          disabled={plan.totalMs === 0}
          aria-label={snap?.playing ? "Pause" : "Play"}
          data-testid="player-play"
        >
          {snap?.playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <button
          type="button"
          className="text-muted hover:text-fg"
          onClick={() => controller.current?.restart()}
          aria-label="Restart"
          data-testid="player-restart"
        >
          <RotateCcw size={14} />
        </button>
        <input
          type="range"
          min={0}
          max={plan.totalMs}
          step={1}
          value={Math.round(time)}
          onChange={(e) => controller.current?.seek(Number(e.target.value))}
          aria-label="Playhead"
          className="min-w-[160px] flex-1"
          data-testid="player-seek"
        />
        <span className="font-mono text-[12px]" data-testid="player-time">
          {fmt(time)} / {fmt(plan.totalMs)}
        </span>
        <span className="font-mono text-[11px] text-faint">{head.timecode}</span>
        {snap?.mediaBlocked ? (
          <span className="text-[11px] text-warn">
            The browser blocked media playback; the timeline still runs.
          </span>
        ) : null}
        {snap && snap.failedTakes.size > 0 ? (
          <span className="text-[11px] text-warn" data-testid="player-failed-takes">
            {snap.failedTakes.size} take{snap.failedTakes.size === 1 ? "" : "s"} could not be played
          </span>
        ) : null}
      </div>
    </section>
  );
}

"use client";

import { Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-react";
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
/** 5B-V3: the editor asks the player to show an item (or any timeline position) by this window event. */
export const EDIT_SEEK_EVENT = "prism:edit-seek";

export function EditPlayer({ playback }: { playback: PlaybackVM }) {
  const { plan } = playback;
  const videoRef = useRef<HTMLVideoElement>(null);
  const underRef = useRef<HTMLVideoElement>(null);
  const controller = useRef<RoughCutController | null>(null);
  const [snap, setSnap] = useState<PlaybackSnapshot | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    const under = underRef.current;
    if (!el) return;
    const c = new RoughCutController(
      plan,
      {
        now: () => performance.now(),
        requestFrame: (cb) => requestAnimationFrame(() => cb()),
        cancelFrame: (id) => cancelAnimationFrame(id),
        video: new DomMediaPort(el),
        under: under ? new DomMediaPort(under) : undefined,
        createAudio: audioPort,
      },
      setSnap,
    );
    controller.current = c;
    c.seek(0);
    // 5B-V3: selecting an item in the editor moves the playhead to it (no playback starts without a click)
    const onSeek = (e: Event) => {
      const ms = (e as CustomEvent<number>).detail;
      if (typeof ms === "number") c.seek(ms);
    };
    window.addEventListener(EDIT_SEEK_EVENT, onSeek);
    return () => {
      window.removeEventListener(EDIT_SEEK_EVENT, onSeek);
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
  // 5B-V3: a dissolve shows the outgoing picture under the incoming one at (1 − mix)
  const outgoing = snap?.outgoing ?? null;
  const mix = snap?.mix ?? 1;
  const outgoingFailed = outgoing
    ? outgoing.unavailable || (snap?.failedPictures.has(outgoing.itemId) ?? false)
    : false;
  const showUnderVideo = outgoing?.kind === "video" && Boolean(outgoing.pictureUrl) && !outgoingFailed;
  const underStill =
    outgoing &&
    (outgoing.kind === "production_frame" || outgoing.kind === "storyboard_frame") &&
    outgoing.pictureUrl &&
    !outgoingFailed
      ? outgoing.pictureUrl
      : null;
  const title = snap?.title ?? null;

  // the edit list follows the playhead
  useEffect(() => {
    const id = item?.itemId ?? null;
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="edit-item"][data-item-id]'))
      el.dataset.playing = el.dataset.itemId === id ? "true" : "false";
  }, [item?.itemId]);

  return (
    <section
      className="border border-line bg-panel"
      id="edit-player"
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
      data-segment={title ? "title" : item ? "item" : ""}
      data-title={title?.placement ?? ""}
      data-outgoing-item-id={outgoing?.itemId ?? ""}
      data-mix={mix.toFixed(2)}
      data-total-ms={plan.totalMs}
    >
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Watch this edit</h2>
        <span className="text-[11px] text-faint">
          Preview of the saved edit: trims, holds, titles and cross dissolves (no render)
        </span>
      </header>
      <div className="relative aspect-video max-h-[360px] w-full overflow-hidden bg-black">
        {/* 5B-V3: the outgoing picture of a cross dissolve, under the incoming one */}
        <video
          ref={underRef}
          playsInline
          preload="auto"
          muted
          className={showUnderVideo ? "absolute inset-0 h-full w-full object-contain" : "hidden"}
          data-testid="player-under-video"
        />
        {!showUnderVideo && underStill ? (
          // eslint-disable-next-line @next/next/no-img-element -- private asset route, not a static image
          <img src={underStill} alt="" className="absolute inset-0 h-full w-full object-contain" />
        ) : null}
        <div
          className="absolute inset-0"
          style={outgoing ? { opacity: mix } : undefined}
          data-testid="player-incoming"
        >
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
        </div>
        {title ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center bg-black px-6 text-center"
            data-testid="player-title"
            data-placement={title.placement}
          >
            <div
              className={
                title.style === "film"
                  ? "font-serif text-[28px] leading-snug tracking-[0.04em] text-fg"
                  : "text-[22px] font-semibold text-fg"
              }
              data-testid="player-title-text"
            >
              {title.title}
            </div>
            {title.subtitle ? (
              <div
                className="mt-3 text-[13px] uppercase tracking-[0.18em] text-muted"
                data-testid="player-title-subtitle"
              >
                {title.subtitle}
              </div>
            ) : null}
          </div>
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
        {/* 5B-V2: jump to the previous / next Sequence item */}
        <button
          type="button"
          className="text-muted hover:text-fg"
          onClick={() => {
            const starts = plan.items.map((i) => i.startMs);
            // within the first 500 ms of an item, "previous" goes to the item before it
            const prev = [...starts].reverse().find((s) => s < time - 500) ?? 0;
            controller.current?.seek(prev);
          }}
          aria-label="Previous item"
          data-testid="player-prev"
        >
          <SkipBack size={14} />
        </button>
        <button
          type="button"
          className="text-muted hover:text-fg"
          onClick={() => {
            const next = plan.items.map((i) => i.startMs).find((s) => s > time + 1);
            if (next != null) controller.current?.seek(next);
          }}
          aria-label="Next item"
          data-testid="player-next"
        >
          <SkipForward size={14} />
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

/** 5B-V3: moves the player to a timeline position (an item's start); playback starts only from the player. */
export function SeekButton({ ms, label }: { ms: number; label: string }) {
  return (
    <button
      type="button"
      className="text-[11px] text-accent hover:underline"
      onClick={() => {
        window.dispatchEvent(new CustomEvent(EDIT_SEEK_EVENT, { detail: ms }));
        document.getElementById("edit-player")?.scrollIntoView({ block: "nearest" });
      }}
      aria-label={label}
      data-testid="seek-item"
    >
      ▸ Preview from here
    </button>
  );
}

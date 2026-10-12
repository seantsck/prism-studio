"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Pause, Play } from "lucide-react";
import { downsamplePeaks } from "@/domain/waveform";
import type { Waveform } from "@/domain/schemas";
import { cn } from "@/lib/utils";

const fmt = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

/** Static bar rendering of stored peaks (no audio needed). */
export function WaveformBars({
  waveform,
  progress = 0,
  bars = 96,
  height = 36,
  className,
  tone = "accent",
}: {
  waveform: Waveform | null;
  /** 0..1 playhead position; bars before it are drawn in the active colour. */
  progress?: number;
  bars?: number;
  height?: number;
  className?: string;
  tone?: "accent" | "muted";
}) {
  const peaks = useMemo(() => (waveform ? downsamplePeaks(waveform.peaks, bars) : []), [waveform, bars]);
  if (peaks.length === 0) {
    return (
      <div
        className={cn("flex items-center justify-center text-[10.5px] text-faint", className)}
        style={{ height }}
      >
        No waveform
      </div>
    );
  }
  const w = peaks.length * 3;
  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className={cn("block w-full", className)}
      style={{ height }}
      role="img"
      aria-label="Audio waveform"
    >
      {peaks.map((p, i) => {
        const h = Math.max(1.5, p * (height - 2));
        const active = i / peaks.length < progress;
        return (
          <rect
            key={i}
            x={i * 3 + 0.5}
            y={(height - h) / 2}
            width={2}
            height={h}
            rx={0.6}
            className={cn(
              active
                ? tone === "accent"
                  ? "fill-accent"
                  : "fill-fg"
                : tone === "accent"
                  ? "fill-accent/35"
                  : "fill-faint",
            )}
          />
        );
      })}
    </svg>
  );
}

/**
 * Take player: waveform + scrubber + play/pause + time. The stored durationMs is the canonical length;
 * the <audio> element only drives playback. If the audio file fails to load, the waveform stays and a clear
 * degraded-state notice is shown (nothing else on the page depends on playback working).
 */
export function AudioPlayer({
  src,
  waveform,
  durationMs,
  label,
  selected = false,
  compact = false,
}: {
  src: string | null;
  waveform: Waveform | null;
  durationMs: number;
  label?: string;
  selected?: boolean;
  compact?: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setPositionMs(a.currentTime * 1000);
    const onEnd = () => {
      setPlaying(false);
      setPositionMs(0);
    };
    const onErr = () => {
      setFailed(true);
      setPlaying(false);
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("ended", onEnd);
    a.addEventListener("error", onErr);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("error", onErr);
    };
  }, [src]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a || failed) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      void a.play().then(
        () => setPlaying(true),
        () => setFailed(true),
      );
    }
  };

  const seek = (ratio: number) => {
    const a = audioRef.current;
    const clamped = Math.min(1, Math.max(0, ratio));
    setPositionMs(clamped * durationMs);
    if (a && !failed) a.currentTime = (clamped * durationMs) / 1000;
  };

  return (
    <div className={cn("flex items-center gap-2", selected && "text-accent")}>
      <button
        type="button"
        onClick={toggle}
        disabled={!src || failed}
        aria-label={playing ? "Pause" : `Play${label ? ` ${label}` : ""}`}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line2 text-fg hover:border-accent disabled:opacity-40"
      >
        {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3 translate-x-px" />}
      </button>
      <div
        className="min-w-0 flex-1 cursor-pointer"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          seek((e.clientX - r.left) / r.width);
        }}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={durationMs}
        aria-valuenow={Math.round(positionMs)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") seek((positionMs + 500) / durationMs);
          if (e.key === "ArrowLeft") seek((positionMs - 500) / durationMs);
        }}
      >
        <WaveformBars
          waveform={waveform}
          progress={durationMs ? positionMs / durationMs : 0}
          height={compact ? 24 : 36}
        />
      </div>
      <span className="w-[104px] shrink-0 whitespace-nowrap text-right font-mono text-[10.5px] text-muted">
        {fmt(positionMs)} / {fmt(durationMs)}
      </span>
      {failed ? (
        <span
          className="inline-flex items-center gap-1 text-[10.5px] text-warn"
          title="The audio file could not be loaded"
        >
          <AlertTriangle className="h-3 w-3" /> unavailable
        </span>
      ) : null}
      {src ? <audio ref={audioRef} src={src} preload="none" /> : null}
    </div>
  );
}

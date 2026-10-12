"use client";

import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { setShotDuration } from "@/server/actions";

export interface CueVM {
  lineId: string;
  speaker: string;
  text: string;
  startMs: number;
  durationMs: number;
  audioUrl: string | null;
}

export interface ClipVM {
  shotId: string;
  shotCode: string;
  title: string;
  sceneNumber: string;
  startMs: number;
  durationMs: number;
  durationSource: string;
  durationMode: "manual" | "derived_from_performance";
  hasDialogue: boolean;
  frameUrl: string | null;
  frameLabel: string;
  frameApproved: boolean;
  hasFrame: boolean;
  cues: CueVM[];
  ambience: string;
  musicCue: string;
}

const fmt = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};

export function AnimaticPlayer({
  clips,
  totalMs,
  projectSlug,
}: {
  clips: ClipVM[];
  totalMs: number;
  projectSlug: string;
}) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timeRef = useRef(0);
  const firedRef = useRef<Set<string>>(new Set());
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const clipAt = useMemo(
    () => (ms: number) =>
      clips.find((c) => ms >= c.startMs && ms < c.startMs + c.durationMs) ?? clips[clips.length - 1] ?? null,
    [clips],
  );
  const current = clipAt(time);
  const activeCue = current?.cues.find((c) => time >= c.startMs && time < c.startMs + c.durationMs) ?? null;

  const seek = useCallback(
    (ms: number) => {
      const t = Math.max(0, Math.min(totalMs, ms));
      timeRef.current = t;
      setTime(t);
      firedRef.current = new Set(
        clips
          .flatMap((c) => c.cues)
          .filter((cue) => cue.startMs < t)
          .map((cue) => cue.lineId),
      );
      audioRef.current?.pause();
    },
    [clips, totalMs],
  );

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      const t = timeRef.current + delta;
      if (t >= totalMs) {
        timeRef.current = totalMs;
        setTime(totalMs);
        setPlaying(false);
        return;
      }
      timeRef.current = t;
      for (const cue of clips.flatMap((c) => c.cues)) {
        if (!firedRef.current.has(cue.lineId) && t >= cue.startMs && t < cue.startMs + cue.durationMs) {
          firedRef.current.add(cue.lineId);
          if (cue.audioUrl) {
            audioRef.current?.pause();
            const a = new Audio(cue.audioUrl);
            audioRef.current = a;
            void a.play().catch(() => undefined);
          }
        }
      }
      setTime(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, clips, totalMs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const jump = (dir: -1 | 1) => {
    if (!current) return;
    const i = clips.findIndex((c) => c.shotId === current.shotId);
    const target = clips[Math.max(0, Math.min(clips.length - 1, i + dir))];
    if (target) seek(target.startMs);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="border border-line bg-black">
          <div className="relative aspect-[2.39/1] w-full overflow-hidden">
            {current?.frameUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={current.frameUrl} alt={current.title} className="h-full w-full object-contain" />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center bg-[repeating-linear-gradient(135deg,#121215,#121215_14px,#0e0e11_14px,#0e0e11_28px)]">
                <div className="font-mono text-3xl text-faint">{current?.shotCode ?? "—"}</div>
                <div className="mt-1 text-muted">{current?.frameLabel ?? ""}</div>
                {current && !current.hasFrame ? (
                  <div className="mt-1 text-[11px] text-fail">no storyboard frame</div>
                ) : null}
              </div>
            )}
            <div className="absolute left-2 top-2 flex items-center gap-2 font-mono text-[11px]">
              <span className="bg-black/70 px-1.5 py-0.5 text-accent">{current?.shotCode}</span>
              <span className="bg-black/70 px-1.5 py-0.5 text-muted">{current?.title}</span>
            </div>
            {activeCue ? (
              <div className="absolute inset-x-0 bottom-3 text-center">
                <span className="inline-block max-w-[80%] bg-black/75 px-3 py-1 text-[15px]">
                  <span className="mr-2 font-mono text-[10.5px] uppercase text-accent">
                    {activeCue.speaker}
                  </span>
                  {activeCue.text}
                </span>
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-3 border-t border-line bg-panel px-3 py-2">
            <button className="text-muted hover:text-fg" onClick={() => jump(-1)} aria-label="Previous shot">
              <SkipBack size={15} />
            </button>
            <button
              className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-accentfg"
              onClick={() => {
                if (!playing && timeRef.current >= totalMs) seek(0);
                setPlaying((p) => !p);
              }}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button className="text-muted hover:text-fg" onClick={() => jump(1)} aria-label="Next shot">
              <SkipForward size={15} />
            </button>
            <span className="font-mono text-[12px]">
              {fmt(time)} <span className="text-faint">/ {fmt(totalMs)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(1, totalMs)}
              value={time}
              onChange={(e) => seek(Number(e.target.value))}
              className="flex-1"
              aria-label="Scrub"
            />
          </div>
        </div>

        <div className="space-y-3 border border-line bg-panel p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Now playing</div>
          {current ? (
            <dl className="space-y-1.5 text-[12px]">
              <Row k="Shot" v={`${current.shotCode} — ${current.title}`} />
              <Row k="Scene" v={current.sceneNumber} />
              <Row k="Clip" v={`${fmt(current.startMs)} – ${fmt(current.startMs + current.durationMs)}`} />
              <Row
                k="Duration"
                v={`${(current.durationMs / 1000).toFixed(1)}s · ${
                  current.durationSource === "performance"
                    ? "from performance"
                    : current.durationSource === "manual_fallback"
                      ? "manual (no canonical take)"
                      : "manual"
                }`}
              />
              <Row k="Ambience" v={current.ambience || "—"} />
              <Row k="Music" v={current.musicCue || "—"} />
              <Row
                k="Dialogue"
                v={
                  current.cues.length
                    ? current.cues.map((c) => `${c.speaker} ${(c.durationMs / 1000).toFixed(1)}s`).join(", ")
                    : "—"
                }
              />
            </dl>
          ) : (
            <p className="text-muted">No shots.</p>
          )}
          <p className="border-t border-line pt-2 text-[11px] text-faint">
            Space toggles play. Dialogue plays from each line&apos;s selected take; takes without an audio
            file show as timed subtitles.
          </p>
        </div>
      </div>

      <div className="border border-line bg-panel p-3">
        <div className="mb-2 flex items-center justify-between text-[11px] text-muted">
          <span className="font-semibold uppercase tracking-wide">Timeline</span>
          <span className="font-mono">Runtime {fmt(totalMs)}</span>
        </div>
        <div className="scroll-thin relative overflow-x-auto pb-2">
          <div
            className="relative flex h-16 min-w-[900px]"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              seek(((e.clientX - rect.left) / rect.width) * totalMs);
            }}
          >
            {clips.map((c) => (
              <div
                key={c.shotId}
                title={`${c.shotCode} ${c.title}`}
                style={{ width: `${(c.durationMs / Math.max(totalMs, 1)) * 100}%` }}
                className={cn(
                  "relative overflow-hidden border-r border-bg px-1.5 py-1",
                  c.hasFrame ? (c.frameApproved ? "bg-[#1d2a24]" : "bg-[#2a2619]") : "bg-[#2a1b1b]",
                  current?.shotId === c.shotId && "outline outline-1 -outline-offset-1 outline-accent",
                )}
              >
                <div className="truncate font-mono text-[10.5px] text-fg">{c.shotCode}</div>
                <div className="truncate text-[10px] text-muted">{c.title}</div>
                {c.cues.map((cue) => (
                  <div
                    key={cue.lineId}
                    className="absolute bottom-0 h-2 bg-info/60"
                    style={{
                      left: `${((cue.startMs - c.startMs) / c.durationMs) * 100}%`,
                      width: `${(cue.durationMs / c.durationMs) * 100}%`,
                    }}
                    title={`${cue.speaker}: ${cue.text}`}
                  />
                ))}
              </div>
            ))}
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-accent"
              style={{ left: `${(time / Math.max(totalMs, 1)) * 100}%` }}
            />
          </div>
        </div>
        <div className="mt-1 flex gap-4 text-[10.5px] text-faint">
          <span>■ approved frame</span>
          <span className="text-warn">■ unapproved frame</span>
          <span className="text-fail">■ no frame</span>
          <span className="text-info">▬ dialogue</span>
        </div>
      </div>

      <div className="border border-line bg-panel">
        <div className="border-b border-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
          Timing
        </div>
        <table className="w-full text-left text-[12px]">
          <thead className="text-[10.5px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-1.5 font-medium">Shot</th>
              <th className="font-medium">Start</th>
              <th className="font-medium">Duration</th>
              <th className="font-medium">Mode / manual seconds</th>
            </tr>
          </thead>
          <tbody>
            {clips.map((c) => (
              <tr key={c.shotId} className="border-t border-line">
                <td className="px-3 py-1">
                  <button className="font-mono text-accent hover:underline" onClick={() => seek(c.startMs)}>
                    {c.shotCode}
                  </button>{" "}
                  <span className="text-muted">{c.title}</span>
                </td>
                <td className="font-mono text-muted">{fmt(c.startMs)}</td>
                <td className="font-mono">{(c.durationMs / 1000).toFixed(1)}s</td>
                <td>
                  <form action={setShotDuration} className="flex items-center gap-1.5 py-0.5">
                    <input type="hidden" name="projectSlug" value={projectSlug} />
                    <input type="hidden" name="shotId" value={c.shotId} />
                    <select name="durationMode" defaultValue={c.durationMode} className="!w-44 !py-0.5">
                      <option value="manual">manual</option>
                      <option value="derived_from_performance" disabled={!c.hasDialogue}>
                        derived from performance
                      </option>
                    </select>
                    <input
                      name="seconds"
                      type="number"
                      step="0.1"
                      min="0"
                      defaultValue={
                        c.durationSource === "performance" ? "" : (c.durationMs / 1000).toFixed(1)
                      }
                      placeholder="s"
                      className="!w-16 !py-0.5"
                    />
                    <button
                      type="submit"
                      className="rounded-[3px] border border-line2 px-2 py-0.5 text-[11px] hover:bg-panel2"
                    >
                      Apply
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-muted">{k}</dt>
      <dd className="min-w-0 break-words">{v}</dd>
    </div>
  );
}

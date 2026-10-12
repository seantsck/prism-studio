"use client";

import { AlertTriangle, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionForm } from "@/components/action-form";
import { WaveformBars } from "@/components/audio-player";
import type { Waveform } from "@/domain/schemas";
import { cn } from "@/lib/utils";
import { setShotDuration } from "@/server/actions";

export interface CueVM {
  lineId: string;
  speaker: string;
  text: string;
  takeNumber: number;
  startMs: number;
  durationMs: number;
  audioUrl: string | null;
  waveform: Waveform | null;
}

export interface SegmentVM {
  kind: string;
  label: string;
  startMs: number;
  endMs: number;
}

export interface ClipVM {
  shotId: string;
  shotCode: string;
  title: string;
  sceneId: string;
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
  frameFreshness: "none" | "fresh" | "stale" | "unknown";
  freshnessMessages: string[];
  cues: CueVM[];
  segments: SegmentVM[];
  ambience: string;
  musicCue: string;
}

export interface SceneVM {
  sceneId: string;
  sceneNumber: string;
  slugline: string;
  startMs: number;
  endMs: number;
}

const fmt = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};
const fmt2 = (ms: number) => (ms / 1000).toFixed(2);

/** If playback has not actually started after this long, treat the audio as unavailable and keep going. */
const AUDIO_START_TIMEOUT_MS = 1500;

export function AnimaticPlayer({
  clips,
  scenes,
  totalMs,
  projectSlug,
}: {
  clips: ClipVM[];
  scenes: SceneVM[];
  totalMs: number;
  projectSlug: string;
}) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [failedCues, setFailedCues] = useState<ReadonlySet<string>>(new Set());

  const timeRef = useRef(0);
  const mutedRef = useRef(false);
  const firedRef = useRef<Set<string>>(new Set());
  const active = useRef<{ cue: CueVM; audio: HTMLAudioElement; startedAt: number; started: boolean } | null>(
    null,
  );

  const allCues = useMemo(() => clips.flatMap((c) => c.cues), [clips]);
  const clipAt = useCallback(
    (ms: number) =>
      clips.find((c) => ms >= c.startMs && ms < c.startMs + c.durationMs) ?? clips[clips.length - 1] ?? null,
    [clips],
  );
  const current = clipAt(time);
  const currentIndex = current ? clips.findIndex((c) => c.shotId === current.shotId) : -1;
  const currentScene = current ? scenes.find((s) => s.sceneId === current.sceneId) : null;
  const activeCue = current?.cues.find((c) => time >= c.startMs && time < c.startMs + c.durationMs) ?? null;
  const clipFailures = current?.cues.filter((c) => failedCues.has(c.lineId)) ?? [];

  const stopAudio = useCallback(() => {
    const a = active.current;
    if (a) {
      a.audio.pause();
      a.audio.removeAttribute("src");
      a.audio.load();
    }
    active.current = null;
  }, []);

  const markFailed = useCallback((lineId: string) => {
    setFailedCues((prev) => new Set(prev).add(lineId));
  }, []);

  const startCue = useCallback(
    (cue: CueVM, offsetMs: number) => {
      firedRef.current.add(cue.lineId);
      if (!cue.audioUrl || failedCues.has(cue.lineId)) return; // plays as a timed subtitle
      stopAudio();
      const audio = new Audio(cue.audioUrl);
      audio.muted = mutedRef.current;
      audio.preload = "auto";
      const entry = { cue, audio, startedAt: performance.now(), started: false };
      active.current = entry;
      audio.addEventListener("playing", () => {
        entry.started = true;
      });
      audio.addEventListener("error", () => {
        markFailed(cue.lineId);
        if (active.current === entry) active.current = null;
      });
      audio.addEventListener("ended", () => {
        if (active.current === entry) active.current = null;
      });
      if (offsetMs > 0) audio.currentTime = offsetMs / 1000;
      audio.play().catch(() => {
        markFailed(cue.lineId);
        if (active.current === entry) active.current = null;
      });
    },
    [failedCues, markFailed, stopAudio],
  );

  const seek = useCallback(
    (ms: number) => {
      const t = Math.max(0, Math.min(totalMs, ms));
      timeRef.current = t;
      setTime(t);
      stopAudio();
      firedRef.current = new Set(allCues.filter((c) => c.startMs + c.durationMs <= t).map((c) => c.lineId));
      // Seeking into the middle of a line while playing resumes that take from the right offset.
      const inside = allCues.find((c) => t >= c.startMs && t < c.startMs + c.durationMs);
      if (inside && playing) startCue(inside, t - inside.startMs);
      else if (inside) firedRef.current.add(inside.lineId);
    },
    [allCues, playing, startCue, stopAudio, totalMs],
  );

  // Playback clock. Wall time advances the playhead; while a selected take's audio is actually playing,
  // the audio element's clock drives it instead, so picture stays locked to the performance.
  useEffect(() => {
    if (!playing) {
      active.current?.audio.pause();
      return;
    }
    if (active.current && !active.current.audio.ended) void active.current.audio.play().catch(() => undefined);
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      let t = timeRef.current;
      const a = active.current;
      if (a && a.started && !a.audio.ended && !a.audio.paused) {
        t = a.cue.startMs + a.audio.currentTime * 1000; // audio drives timing
      } else if (a && !a.started && now - a.startedAt < AUDIO_START_TIMEOUT_MS) {
        // audio is buffering: hold the playhead rather than drifting ahead of the performance
      } else {
        if (a && !a.started) {
          markFailed(a.cue.lineId);
          active.current = null;
        }
        t += delta;
      }
      if (t >= totalMs) {
        stopAudio();
        timeRef.current = totalMs;
        setTime(totalMs);
        setPlaying(false);
        return;
      }
      timeRef.current = t;
      for (const cue of allCues) {
        if (!firedRef.current.has(cue.lineId) && t >= cue.startMs && t < cue.startMs + cue.durationMs) {
          startCue(cue, 0);
        }
      }
      setTime(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, allCues, totalMs, startCue, stopAudio, markFailed]);

  useEffect(() => {
    mutedRef.current = muted;
    if (active.current) active.current.audio.muted = muted;
  }, [muted]);
  useEffect(() => stopAudio, [stopAudio]);

  const jump = useCallback(
    (dir: -1 | 1) => {
      if (clips.length === 0) return;
      const i = currentIndex < 0 ? 0 : currentIndex;
      // "Previous" inside a clip first returns to that clip's start.
      const atStart = current ? Math.abs(time - current.startMs) < 400 : true;
      const target = dir === -1 && !atStart ? clips[i] : clips[Math.max(0, Math.min(clips.length - 1, i + dir))];
      if (target) seek(target.startMs);
    },
    [clips, current, currentIndex, seek, time],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const step = e.shiftKey ? 5000 : 1000;
      switch (e.key) {
        case " ":
          e.preventDefault();
          if (!playing && timeRef.current >= totalMs) seek(0);
          setPlaying((p) => !p);
          break;
        case "ArrowLeft":
          e.preventDefault();
          seek(timeRef.current - step);
          break;
        case "ArrowRight":
          e.preventDefault();
          seek(timeRef.current + step);
          break;
        case "[":
        case ",":
          jump(-1);
          break;
        case "]":
        case ".":
          jump(1);
          break;
        case "m":
        case "M":
          setMuted((m) => !m);
          break;
        case "Home":
          e.preventDefault();
          seek(0);
          break;
        case "End":
          e.preventDefault();
          seek(totalMs);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jump, playing, seek, totalMs]);

  const widthPct = (ms: number) => `${(ms / Math.max(totalMs, 1)) * 100}%`;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="border border-line bg-black">
          <div className="relative aspect-[2.39/1] w-full overflow-hidden" data-testid="animatic-stage">
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
            <div className="absolute left-2 top-2 flex flex-wrap items-center gap-2 font-mono text-[11px]">
              <span className="bg-black/70 px-1.5 py-0.5 text-muted">
                Scene {current?.sceneNumber ?? "—"}
              </span>
              <span className="bg-black/70 px-1.5 py-0.5 text-accent">{current?.shotCode}</span>
              <span className="bg-black/70 px-1.5 py-0.5 text-muted">{current?.title}</span>
              {current?.frameFreshness === "stale" ? (
                <span className="bg-black/70 px-1.5 py-0.5 text-warn">storyboard may be stale</span>
              ) : null}
            </div>
            {activeCue ? (
              <div className="absolute inset-x-0 bottom-3 text-center">
                <span className="inline-block max-w-[80%] bg-black/75 px-3 py-1 text-[15px]">
                  <span className="mr-2 font-mono text-[10.5px] uppercase text-accent">{activeCue.speaker}</span>
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
            <button
              className={cn("hover:text-fg", muted ? "text-warn" : "text-muted")}
              onClick={() => setMuted((m) => !m)}
              aria-label={muted ? "Unmute" : "Mute"}
              aria-pressed={muted}
            >
              {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
            <span className="font-mono text-[12px]" data-testid="animatic-time">
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
            <span className="hidden text-[10.5px] text-faint sm:inline">
              {currentIndex >= 0 ? `shot ${currentIndex + 1}/${clips.length}` : ""}
            </span>
          </div>
          {clipFailures.length > 0 ? (
            <div className="flex items-center gap-2 border-t border-warn/30 bg-warn/10 px-3 py-1.5 text-[11.5px] text-warn">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Audio could not be loaded for {clipFailures.map((c) => c.speaker).join(", ")}. Playback continues on
              the planned timing with subtitles.
            </div>
          ) : null}
        </div>

        <div className="space-y-3 border border-line bg-panel p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Now playing</div>
          {current ? (
            <>
              <dl className="space-y-1.5 text-[12px]">
                <Row
                  k="Scene"
                  v={`${current.sceneNumber}${currentScene ? ` — ${currentScene.slugline}` : ""}`}
                />
                <Row k="Shot" v={`${current.shotCode} — ${current.title}`} />
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
              </dl>
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Timing</div>
                <ol className="space-y-0.5 font-mono text-[11px]">
                  {current.segments.length === 0 ? (
                    <li className="text-faint">No timing set</li>
                  ) : (
                    current.segments.map((s, i) => {
                      const nowIn =
                        time - current.startMs >= s.startMs && time - current.startMs < s.endMs;
                      return (
                        <li key={i} className={cn("flex gap-2", nowIn ? "text-accent" : "text-muted")}>
                          <span className="w-[88px] shrink-0">
                            {fmt2(s.startMs)}–{fmt2(s.endMs)}
                          </span>
                          <span className="font-sans text-[11.5px]">{s.label}</span>
                        </li>
                      );
                    })
                  )}
                  <li className="flex gap-2 border-t border-line pt-0.5 text-fg">
                    <span className="w-[88px] shrink-0">Total</span>
                    <span>{(current.durationMs / 1000).toFixed(2)}s</span>
                  </li>
                </ol>
              </div>
              {current.freshnessMessages.length > 0 ? (
                <ul className="space-y-1 border-t border-line pt-2 text-[11.5px] text-warn">
                  {current.freshnessMessages.map((m) => (
                    <li key={m}>⚠ {m}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="text-muted">No shots.</p>
          )}
          <p className="border-t border-line pt-2 text-[10.5px] leading-relaxed text-faint">
            <b className="font-medium text-muted">Keys:</b> Space play · ←/→ ±1s (Shift ±5s) · [ ] shot · M mute ·
            Home/End. Dialogue plays from each line&apos;s selected take and drives the clock; takes without a
            file show as timed subtitles.
          </p>
        </div>
      </div>

      <div className="border border-line bg-panel p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
          <span className="font-semibold uppercase tracking-wide">Timeline</span>
          <span className="flex items-center gap-3">
            <label className="flex items-center gap-1.5">
              Zoom
              <input
                type="range"
                min={1}
                max={6}
                step={0.5}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="!w-24"
                aria-label="Timeline zoom"
              />
            </label>
            <span className="font-mono">Runtime {fmt(totalMs)}</span>
          </span>
        </div>
        <div className="scroll-thin overflow-x-auto pb-2">
          <div
            className="relative"
            style={{ width: `${zoom * 100}%`, minWidth: 900 }}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              seek(((e.clientX - rect.left) / rect.width) * totalMs);
            }}
          >
            {/* scene lane */}
            <div className="relative h-5 border-b border-line">
              {scenes.map((s) => (
                <div
                  key={s.sceneId}
                  className={cn(
                    "absolute inset-y-0 truncate border-l border-line2 px-1 text-[10px]",
                    current?.sceneId === s.sceneId ? "text-accent" : "text-faint",
                  )}
                  style={{ left: widthPct(s.startMs), width: widthPct(s.endMs - s.startMs) }}
                  title={s.slugline}
                >
                  Sc {s.sceneNumber}
                </div>
              ))}
            </div>
            {/* shot lane */}
            <div className="relative flex h-14">
              {clips.map((c) => (
                <div
                  key={c.shotId}
                  title={`${c.shotCode} ${c.title}`}
                  style={{ width: widthPct(c.durationMs) }}
                  className={cn(
                    "relative overflow-hidden border-r border-bg px-1.5 py-1",
                    c.hasFrame
                      ? c.frameFreshness === "stale"
                        ? "bg-[#2e2418]"
                        : c.frameApproved
                          ? "bg-[#1d2a24]"
                          : "bg-[#2a2619]"
                      : "bg-[#2a1b1b]",
                    current?.shotId === c.shotId && "outline outline-1 -outline-offset-1 outline-accent",
                  )}
                >
                  <div className="truncate font-mono text-[10.5px] text-fg">{c.shotCode}</div>
                  <div className="truncate text-[10px] text-muted">{c.title}</div>
                </div>
              ))}
            </div>
            {/* audio lane: selected takes with their waveforms, on the global time axis */}
            <div className="relative mt-1 h-10 border-t border-line bg-bg/40">
              {allCues.map((cue) => (
                <div
                  key={cue.lineId}
                  className={cn(
                    "absolute inset-y-0.5 overflow-hidden rounded-[2px] border",
                    failedCues.has(cue.lineId) ? "border-warn/60 bg-warn/10" : "border-info/40 bg-info/10",
                  )}
                  style={{ left: widthPct(cue.startMs), width: widthPct(cue.durationMs) }}
                  title={`${cue.speaker} · take ${cue.takeNumber}: ${cue.text}`}
                >
                  <WaveformBars waveform={cue.waveform} height={32} tone="muted" className="opacity-80" />
                </div>
              ))}
            </div>
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-accent"
              style={{ left: widthPct(time) }}
            />
          </div>
        </div>
        <div className="mt-1 flex flex-wrap gap-4 text-[10.5px] text-faint">
          <span>■ approved frame</span>
          <span className="text-warn">■ unapproved / stale frame</span>
          <span className="text-fail">■ no frame</span>
          <span className="text-info">▬ selected performance audio</span>
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
                  <ActionForm action={setShotDuration} className="flex items-center gap-1.5 py-0.5" quiet>
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
                      defaultValue={c.durationSource === "performance" ? "" : (c.durationMs / 1000).toFixed(1)}
                      placeholder="s"
                      className="!w-16 !py-0.5"
                    />
                    <button
                      type="submit"
                      className="rounded-[3px] border border-line2 px-2 py-0.5 text-[11px] hover:bg-panel2"
                    >
                      Apply
                    </button>
                  </ActionForm>
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

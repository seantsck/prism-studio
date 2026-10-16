"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { focalLengthToFovDegrees } from "@/domain/previs/camera";
import {
  CAMERA_EASINGS,
  CAMERA_INTERPOLATIONS,
  cameraPathFingerprint,
  emptyCameraPath,
  evaluateCameraPath,
  eulerToQuaternion,
  keyframeFromCamera,
  quaternionToEuler,
  removeKeyframe,
  sortedKeyframes,
  upsertKeyframe,
  validateCameraPath,
  type CameraEasing,
  type CameraInterpolation,
  type CameraKeyframe,
  type CameraPath,
} from "@/domain/previs/camera-path";
import { buildHotelCanopyCameraPath } from "@/domain/previs/hotel-canopy";
import type { PrevisCamera } from "@/domain/previs/types";
import { detectPrevisEncoding, MediaBunnyEncoder } from "@/lib/previs/mediabunny-encoder";
import {
  PREVIS_RENDER_SIZE,
  PrevisCancelled,
  poseOf,
  renderPrevis,
  type PrevisProgress,
} from "@/lib/previs/previs-render";
import type { PathOverlay, SpatialSceneAdapter } from "@/lib/previs/scene-adapter";
import { recordPrevisClip, saveShotCameraPath } from "@/server/previs-actions";

export interface ShotTimingInfo {
  durationMs: number;
  source: string;
  frameRate: number;
  audioCues: Array<{ assetId: string; startMs: number; durationMs: number }>;
}

export interface CameraPathInfo {
  id: string;
  revision: number;
  sceneRevision: number;
  sceneFingerprint: string;
  pathFingerprint: string;
  path: CameraPath;
}

export interface PrevisClipInfo {
  id: string;
  assetId: string;
  pathRevision: number;
  pathFingerprint: string;
  sceneRevision: number;
  sceneFingerprint: string;
  frameRate: number;
  durationMs: number;
  renderWidth: number;
  renderHeight: number;
  container: string;
  codec: string;
  renderedAt: string;
}

type Status = { tone: "idle" | "ok" | "error" | "busy"; text: string };

const RAD = Math.PI / 180;
const DEFAULT_DURATION_MS = 4000;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const short = (fp: string | null) => (fp ? fp.slice(0, 10) : "—");

export function formatTimecode(ms: number, fps: number): string {
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const milli = Math.floor(total % 1000);
  const frame = Math.round((total / 1000) * fps);
  return `${m}:${String(s).padStart(2, "0")}.${String(milli).padStart(3, "0")} · f${frame}`;
}

function newKeyId() {
  return `kf-${Math.random().toString(36).slice(2, 10)}`;
}

function NumField(props: {
  label: string;
  testId: string;
  value: number;
  step?: number;
  disabled?: boolean;
  onCommit: (n: number) => void;
}) {
  return (
    <label className="block text-xs text-muted">
      {props.label}
      <input
        key={`${props.testId}:${props.value}`}
        type="number"
        step={props.step ?? 0.1}
        defaultValue={r3(props.value)}
        disabled={props.disabled}
        aria-label={props.label}
        data-testid={props.testId}
        className="mt-0.5 w-full"
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n !== props.value) props.onCommit(n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

export interface CameraMotionPanelProps {
  adapter: () => SpatialSceneAdapter;
  ready: boolean;
  projectSlug: string;
  locationId: string;
  shotId: string | null;
  /** the LIVE production camera (never the navigation camera) */
  camera: PrevisCamera | null;
  looking: boolean;
  timing: ShotTimingInfo | null;
  initialPath: CameraPathInfo | null;
  initialClips: PrevisClipInfo[];
  /** the saved set's fingerprint (null = not saved yet) and whether the live set differs from it */
  savedSceneFingerprint: string | null;
  sceneDirty: boolean;
  ensureSceneSaved: () => Promise<{ revision: number; fingerprint: string } | null>;
}

export function CameraMotionPanel(props: CameraMotionPanelProps) {
  const router = useRouter();
  const fps = props.timing?.frameRate ?? 24;
  const timingDuration = props.timing && props.timing.durationMs > 0 ? props.timing.durationMs : null;

  const [path, setPath] = useState<CameraPath | null>(props.initialPath?.path ?? null);
  const [saved, setSaved] = useState<CameraPathInfo | null>(props.initialPath);
  const [clips, setClips] = useState<PrevisClipInfo[]>(props.initialClips);
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ tone: "idle", text: "" });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<PrevisProgress | null>(null);
  const [overlayOn, setOverlayOn] = useState(true);

  const pathRef = useRef<CameraPath | null>(path);
  useEffect(() => {
    pathRef.current = path;
  }, [path]);
  // the production-camera pose the path last wrote (or a keyframe last captured): anything else is an unkeyed edit
  const committedRef = useRef<{ position: number[]; rotation: number[]; focal: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioRef = useRef<{ els: HTMLAudioElement[]; timers: number[] }>({ els: [], timers: [] });

  const dirty = useMemo(() => {
    if (!path) return false;
    if (!saved) return true;
    return cameraPathFingerprint(path) !== saved.pathFingerprint;
  }, [path, saved]);
  const sceneStale =
    !!saved && !!props.savedSceneFingerprint && saved.sceneFingerprint !== props.savedSceneFingerprint;
  const keys = useMemo(() => (path ? sortedKeyframes(path) : []), [path]);
  const selected = keys.find((k) => k.id === selectedId) ?? null;
  const durationMs = path?.durationMs ?? timingDuration ?? DEFAULT_DURATION_MS;
  const durationDrift = !!path && !!timingDuration && path.durationMs !== timingDuration;

  const snapshotOf = (c: PrevisCamera) => ({
    position: [c.position.x, c.position.y, c.position.z],
    rotation: [c.rotation.x, c.rotation.y, c.rotation.z],
    focal: c.focalLengthMm,
  });
  const commitLiveCamera = () => {
    try {
      const c = props.adapter().getProductionCamera();
      if (c) committedRef.current = snapshotOf(c);
    } catch {
      /* adapter not ready */
    }
  };
  /** True when the operator moved the production camera and has not keyed or discarded that edit. */
  const hasUnkeyedEdit = () => {
    const committed = committedRef.current;
    if (!committed) return false;
    const c = props.adapter().getProductionCamera();
    if (!c) return false;
    const now = snapshotOf(c);
    const eps = 1e-3;
    return (
      Math.abs(now.focal - committed.focal) > eps ||
      now.position.some((v, i) => Math.abs(v - committed.position[i]) > eps) ||
      now.rotation.some((v, i) => Math.abs(v - committed.rotation[i]) > eps)
    );
  };

  // the baseline is whatever the camera is when the panel becomes usable
  useEffect(() => {
    if (props.ready && !committedRef.current) commitLiveCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.ready]);

  // ── playback: the ONE evaluator drives the production camera (never the navigation camera) ──
  const applyAt = useCallback(
    (t: number) => {
      const p = pathRef.current;
      if (!p || p.keyframes.length === 0) return;
      const state = evaluateCameraPath(p, t);
      if (!state) return;
      props.adapter().applyCameraState(poseOf(state));
      const pose = poseOf(state);
      committedRef.current = {
        position: [pose.position.x, pose.position.y, pose.position.z],
        rotation: [pose.rotation.x, pose.rotation.y, pose.rotation.z],
        focal: pose.focalLengthMm,
      };
    },
    [props],
  );

  const stopAudio = useCallback(() => {
    for (const t of audioRef.current.timers) window.clearTimeout(t);
    for (const a of audioRef.current.els) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    audioRef.current = { els: [], timers: [] };
  }, []);

  const startAudio = useCallback(
    (fromMs: number) => {
      stopAudio();
      for (const cue of props.timing?.audioCues ?? []) {
        const end = cue.startMs + cue.durationMs;
        if (fromMs >= end) continue;
        const el = new Audio(`/api/assets/${cue.assetId}`);
        el.preload = "auto";
        audioRef.current.els.push(el);
        const begin = () => {
          el.currentTime = Math.max(0, (fromMs - cue.startMs) / 1000);
          void el.play().catch(() => undefined);
        };
        if (fromMs >= cue.startMs) begin();
        else {
          audioRef.current.timers.push(
            window.setTimeout(() => void el.play().catch(() => undefined), cue.startMs - fromMs),
          );
        }
      }
    },
    [props.timing, stopAudio],
  );

  const stopPlayback = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    stopAudio();
    setPlaying(false);
  }, [stopAudio]);

  const play = () => {
    if (!path || path.keyframes.length < 1 || !props.ready) return;
    if (hasUnkeyedEdit()) {
      return setStatus({
        tone: "error",
        text: "The production camera has an unkeyed edit. Add or update a keyframe, or return the camera to its set pose, before playing.",
      });
    }
    let t0 = timeMs >= path.durationMs ? 0 : timeMs;
    let wall0: number | null = null;
    setPlaying(true);
    startAudio(t0);
    const tick = (now: number) => {
      const p = pathRef.current;
      if (!p) return stopPlayback();
      if (wall0 === null) wall0 = now;
      let t = t0 + (now - wall0);
      if (t >= p.durationMs) {
        if (loop) {
          wall0 = now;
          t0 = 0;
          t = 0;
          startAudio(0);
        } else {
          setTimeMs(p.durationMs);
          applyAt(p.durationMs);
          return stopPlayback();
        }
      }
      t = Math.max(0, t);
      setTimeMs(t);
      applyAt(t);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const scrubTo = (t: number) => {
    stopPlayback();
    const clamped = Math.min(durationMs, Math.max(0, Math.round(t)));
    setTimeMs(clamped);
    if (!props.ready) return;
    if (hasUnkeyedEdit()) {
      // never throw the operator's camera move away just because the playhead moved
      setStatus({
        tone: "idle",
        text: "The camera has an unkeyed edit — Add keyframe at playhead to commit it here.",
      });
      return;
    }
    applyAt(clamped);
  };

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      stopAudio();
      abortRef.current?.abort();
    },
    [stopAudio],
  );

  // ── editor-only overlay of the path ──
  useEffect(() => {
    if (!props.ready) return;
    const a = props.adapter();
    if (!overlayOn || !path || path.keyframes.length === 0) {
      a.setPathOverlay(null);
      return;
    }
    const line: PathOverlay["line"] = [];
    if (path.keyframes.length >= 2) {
      const steps = 48;
      for (let i = 0; i <= steps; i++) {
        const st = evaluateCameraPath(path, (path.durationMs * i) / steps);
        if (st) line.push(st.position);
      }
    }
    const ordered = sortedKeyframes(path);
    const current = evaluateCameraPath(path, timeMs)?.position ?? null;
    a.setPathOverlay({
      line,
      keys: ordered.map((k, i) => ({
        position: k.position,
        selected: k.id === selectedId,
        role: i === 0 ? "start" : i === ordered.length - 1 ? "end" : "mid",
      })),
      current,
    });
  }, [path, selectedId, timeMs, overlayOn, props]);

  useEffect(
    () => () => {
      try {
        props.adapter().setPathOverlay(null);
      } catch {
        /* adapter already disposed */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── editing ──
  const camNow = () => {
    // the live production camera pose (a scrubbed pose counts: it is the production camera right now)
    const c = props.adapter().getProductionCamera();
    return c ?? props.camera;
  };

  const createPath = () => {
    const c = camNow();
    if (!c) return setStatus({ tone: "error", text: "This set has no production camera." });
    const dur = timingDuration ?? DEFAULT_DURATION_MS;
    let p = emptyCameraPath(dur, fps);
    p = upsertKeyframe(p, keyframeFromCamera(newKeyId(), 0, c));
    setPath(p);
    committedRef.current = snapshotOf(c);
    setSelectedId(p.keyframes[0].id);
    setTimeMs(0);
    setStatus({
      tone: "ok",
      text: timingDuration
        ? `New camera path: ${(dur / 1000).toFixed(2)} s (the Shot's duration), ${fps} fps.`
        : `The Shot has no duration yet, so the path starts at ${(dur / 1000).toFixed(0)} s. Change it below.`,
    });
  };

  const loadSamplePath = () => {
    const p = { ...buildHotelCanopyCameraPath(), frameRate: fps };
    setPath(p);
    setSelectedId(p.keyframes[0].id);
    setTimeMs(0);
    setStatus({ tone: "ok", text: "Loaded the Hotel Canopy sample path (4 s, 35 → 50 → 70 mm)." });
  };

  const mutate = (fn: (p: CameraPath) => CameraPath) => {
    const p = pathRef.current;
    if (!p) return;
    try {
      setPath(fn(p));
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : "That change is not valid." });
    }
  };

  const addKeyframe = () => {
    const c = camNow();
    if (!c || !path) return;
    const t = Math.round(timeMs);
    const existing = path.keyframes.find((k) => k.timeMs === t);
    const key = keyframeFromCamera(existing?.id ?? newKeyId(), t, c, existing?.easing ?? "ease_in_out");
    mutate((p) => upsertKeyframe(p, key));
    committedRef.current = snapshotOf(c);
    setSelectedId(key.id);
    setStatus({ tone: "ok", text: `Keyframe at ${formatTimecode(t, fps)}` });
  };

  const updateFromCamera = () => {
    const c = camNow();
    if (!c || !selected) return;
    mutate((p) =>
      upsertKeyframe(p, {
        ...keyframeFromCamera(selected.id, selected.timeMs, c, selected.easing),
      }),
    );
    committedRef.current = snapshotOf(c);
  };

  const patchSelected = (patch: Partial<CameraKeyframe>) => {
    if (!selected) return;
    mutate((p) => upsertKeyframe(p, { ...selected, ...patch }));
    if (patch.timeMs !== undefined) setTimeMs(patch.timeMs);
  };

  const deleteSelected = () => {
    if (!selected) return;
    mutate((p) => removeKeyframe(p, selected.id));
    setSelectedId(null);
  };

  const setDuration = (seconds: number) => {
    const ms = Math.round(seconds * 1000);
    if (!(ms > 0)) return;
    mutate((p) => ({ ...p, durationMs: ms }));
  };

  const savePath = async (): Promise<CameraPathInfo | null> => {
    if (!path || !props.shotId) return null;
    const problems = validateCameraPath(path);
    if (problems.length > 0) {
      setStatus({ tone: "error", text: problems[0] });
      return null;
    }
    setBusy(true);
    setStatus({ tone: "busy", text: "Saving camera path…" });
    try {
      const scene = await props.ensureSceneSaved();
      if (!scene) return null;
      const fd = new FormData();
      fd.set("projectSlug", props.projectSlug);
      fd.set("shotId", props.shotId);
      fd.set("locationId", props.locationId);
      fd.set("expectedRevision", saved ? String(saved.revision) : "");
      fd.set("pathJson", JSON.stringify(path));
      const r = await saveShotCameraPath(fd);
      if (!r.ok) {
        setStatus({ tone: "error", text: r.error });
        return null;
      }
      const info: CameraPathInfo = {
        id: r.pathId,
        revision: r.revision,
        sceneRevision: scene.revision,
        sceneFingerprint: scene.fingerprint,
        pathFingerprint: r.fingerprint,
        path,
      };
      setSaved(info);
      setStatus({ tone: "ok", text: `Camera path saved — revision ${r.revision}` });
      router.refresh();
      return info;
    } finally {
      setBusy(false);
    }
  };

  // ── local previs render ──
  const latestClip = clips[0] ?? null;
  const clipStale = (c: PrevisClipInfo) =>
    !saved ||
    c.pathFingerprint !== saved.pathFingerprint ||
    (!!props.savedSceneFingerprint && c.sceneFingerprint !== props.savedSceneFingerprint);

  const renderPreviewVideo = async () => {
    const reasons: string[] = [];
    if (!props.shotId) reasons.push("Choose a shot first.");
    if (!path || path.keyframes.length < 2) reasons.push("Add at least two keyframes.");
    if (props.sceneDirty || !props.savedSceneFingerprint) reasons.push("Save the 3D set first.");
    if (dirty || !saved) reasons.push("Save the camera path first.");
    if (sceneStale) reasons.push("The set changed since this path was saved — re-save the path.");
    if (reasons.length > 0 || !path || !saved || !props.shotId)
      return setStatus({ tone: "error", text: reasons.join(" ") });

    setBusy(true);
    stopPlayback();
    setProgress({ frame: 0, total: 1, phase: "rendering" });
    setStatus({ tone: "busy", text: "Checking video encoding support…" });
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const support = await detectPrevisEncoding(PREVIS_RENDER_SIZE);
      if (!support) {
        setStatus({
          tone: "error",
          text: "This browser cannot encode video locally (WebCodecs H.264/VP9/VP8 unavailable). Use a current Chrome or Edge.",
        });
        return;
      }
      setStatus({ tone: "busy", text: `Rendering previs (${support.container} / ${support.codec})…` });
      const a = props.adapter();
      const out = await renderPrevis({
        path,
        size: PREVIS_RENDER_SIZE,
        renderer: { renderFrame: (pose, size) => a.renderPrevisFrame(pose, size) },
        encoder: new MediaBunnyEncoder(support),
        signal: ac.signal,
        onProgress: setProgress,
      });
      setStatus({ tone: "busy", text: "Storing previs privately…" });
      const fd = new FormData();
      fd.set("projectSlug", props.projectSlug);
      fd.set("shotId", props.shotId);
      fd.set("locationId", props.locationId);
      fd.set("pathRevision", String(saved.revision));
      fd.set("container", out.container);
      fd.set("codec", out.codec);
      fd.set("renderWidth", String(out.width));
      fd.set("renderHeight", String(out.height));
      const mime = out.container === "mp4" ? "video/mp4" : "video/webm";
      fd.set("file", new File([out.bytes as BlobPart], `previs.${out.container}`, { type: mime }));
      const r = await recordPrevisClip(fd);
      if (!r.ok) {
        setStatus({ tone: "error", text: r.error });
        return;
      }
      setClips((c) => [
        {
          id: r.clipId,
          assetId: r.assetId,
          pathRevision: saved.revision,
          pathFingerprint: saved.pathFingerprint,
          sceneRevision: saved.sceneRevision,
          sceneFingerprint: saved.sceneFingerprint,
          frameRate: out.frameRate,
          durationMs: out.durationMs,
          renderWidth: out.width,
          renderHeight: out.height,
          container: out.container,
          codec: out.codec,
          renderedAt: new Date().toISOString(),
        },
        ...c,
      ]);
      setStatus({
        tone: "ok",
        text: `Previs saved privately (${out.width}×${out.height}, ${out.frameCount} frames, ${out.container}/${out.codec})`,
      });
      router.refresh();
    } catch (err) {
      if (err instanceof PrevisCancelled) setStatus({ tone: "idle", text: "Previs render cancelled." });
      else
        setStatus({ tone: "error", text: err instanceof Error ? err.message : "The previs render failed." });
    } finally {
      abortRef.current = null;
      setProgress(null);
      setBusy(false);
    }
  };

  const lens = useMemo(() => {
    const st = path && path.keyframes.length ? evaluateCameraPath(path, timeMs) : null;
    const f = st?.focalLengthMm ?? props.camera?.focalLengthMm ?? null;
    return f ? { f, fov: focalLengthToFovDegrees(f) } : null;
  }, [path, timeMs, props.camera]);

  const noShot = !props.shotId;

  return (
    <section data-testid="camera-motion" data-playing={playing ? "true" : "false"} className="mt-4">
      <h2 className="mb-1 text-xs uppercase tracking-wide text-muted">Camera motion</h2>
      {noShot ? (
        <p className="text-xs text-muted">Choose a shot to author its camera path.</p>
      ) : !path ? (
        <div>
          <p className="mb-2 text-xs text-muted">
            This shot has no camera path. The path starts at the current production camera
            {timingDuration ? ` and runs the Shot's ${(timingDuration / 1000).toFixed(2)} s` : ""}.
          </p>
          <button
            className="btn w-full"
            disabled={!props.ready || !props.camera}
            onClick={createPath}
            data-testid="create-camera-path"
          >
            Create camera path
          </button>
          <button
            className="btn mt-1.5 w-full"
            disabled={!props.ready}
            onClick={loadSamplePath}
            data-testid="load-sample-path"
          >
            Load Hotel Canopy sample path
          </button>
        </div>
      ) : (
        <div>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span data-testid="timecode" className="font-mono">
              {formatTimecode(timeMs, fps)}
            </span>
            <span data-testid="lens-display" className="text-muted">
              {lens ? `${r3(lens.f)} mm · ${r3(lens.fov)}° vFOV` : "—"}
            </span>
          </div>

          <div
            data-testid="timeline-track"
            data-duration-ms={durationMs}
            className="relative mb-2 h-8 cursor-pointer rounded border border-line bg-panel"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              scrubTo(((e.clientX - rect.left) / rect.width) * durationMs);
            }}
          >
            <div
              data-testid="timeline-playhead"
              className="absolute top-0 h-full w-px bg-accent"
              style={{ left: `${(Math.min(timeMs, durationMs) / durationMs) * 100}%` }}
            />
            {keys.map((k) => (
              <button
                key={k.id}
                data-testid="kf-marker"
                data-time-ms={k.timeMs}
                data-selected={k.id === selectedId ? "true" : "false"}
                title={`${formatTimecode(k.timeMs, fps)} · ${r3(k.focalLengthMm)} mm`}
                className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border ${
                  k.id === selectedId ? "border-white bg-white" : "border-accent bg-accent"
                }`}
                style={{ left: `${(k.timeMs / durationMs) * 100}%` }}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedId(k.id);
                  scrubTo(k.timeMs);
                }}
              />
            ))}
          </div>

          <div className="mb-2 flex gap-1.5">
            <button className="btn" onClick={() => scrubTo(0)} data-testid="to-start" title="Jump to start">
              |◀
            </button>
            {playing ? (
              <button className="btn flex-1" onClick={stopPlayback} data-testid="pause-path">
                Pause
              </button>
            ) : (
              <button
                className="btn flex-1"
                onClick={play}
                disabled={!props.ready || path.keyframes.length < 1 || busy}
                data-testid="play-path"
              >
                Play
              </button>
            )}
            <button
              className="btn"
              onClick={() => scrubTo(durationMs)}
              data-testid="to-end"
              title="Jump to end"
            >
              ▶|
            </button>
          </div>
          <label className="mb-2 flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop
            <input
              type="checkbox"
              className="ml-3"
              checked={overlayOn}
              onChange={(e) => setOverlayOn(e.target.checked)}
              data-testid="path-overlay-toggle"
            />{" "}
            Show path in the set
          </label>
          <p className="mb-2 text-xs text-muted" data-testid="playback-mode">
            {props.looking
              ? "Looking through the production camera: the viewport follows the path."
              : "The production camera moves; your navigation camera stays where you put it."}
          </p>

          <div className="mb-2 grid grid-cols-2 gap-2">
            <NumField
              label="Duration (s)"
              testId="path-duration"
              value={path.durationMs / 1000}
              step={0.5}
              disabled={busy}
              onCommit={setDuration}
            />
            <label className="block text-xs text-muted">
              Position path
              <select
                className="mt-0.5 w-full"
                value={path.interpolation}
                data-testid="path-interpolation"
                disabled={busy}
                onChange={(e) =>
                  mutate((p) => ({ ...p, interpolation: e.target.value as CameraInterpolation }))
                }
              >
                {CAMERA_INTERPOLATIONS.map((i) => (
                  <option key={i} value={i}>
                    {i === "smooth" ? "Smooth (Catmull-Rom)" : "Linear"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="mb-2 text-xs text-muted" data-testid="timing-authority">
            {timingDuration
              ? `Shot duration ${(timingDuration / 1000).toFixed(2)} s (${props.timing?.source.replace("_", " ")}) · ${fps} fps`
              : `The Shot has no duration yet · ${fps} fps`}
            {durationDrift ? (
              <span className="ml-1 text-warn" data-testid="duration-drift">
                The path is {(path.durationMs / 1000).toFixed(2)} s — not the Shot&apos;s duration.
              </span>
            ) : null}
          </p>

          <div className="mb-2 flex gap-1.5">
            <button className="btn flex-1" onClick={addKeyframe} disabled={busy} data-testid="kf-add">
              Add keyframe at playhead
            </button>
          </div>

          {selected ? (
            <div className="mb-2 rounded border border-line p-2" data-testid="kf-editor">
              <div className="mb-1 text-xs">
                Keyframe at <strong>{formatTimecode(selected.timeMs, fps)}</strong>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <NumField
                  label="Time (ms)"
                  testId="kf-time"
                  value={selected.timeMs}
                  step={10}
                  disabled={busy}
                  onCommit={(n) => patchSelected({ timeMs: Math.max(0, Math.round(n)) })}
                />
                <label className="block text-xs text-muted">
                  Easing to next
                  <select
                    className="mt-0.5 w-full"
                    value={selected.easing}
                    data-testid="kf-easing"
                    disabled={busy}
                    onChange={(e) => patchSelected({ easing: e.target.value as CameraEasing })}
                  >
                    {CAMERA_EASINGS.map((e) => (
                      <option key={e} value={e}>
                        {e.replace("_", " ")}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-1.5">
                {(["x", "y", "z"] as const).map((axis) => (
                  <NumField
                    key={`p${axis}`}
                    label={`Pos ${axis.toUpperCase()}`}
                    testId={`kf-pos-${axis}`}
                    value={selected.position[axis]}
                    disabled={busy}
                    onCommit={(n) => patchSelected({ position: { ...selected.position, [axis]: n } })}
                  />
                ))}
                {(["x", "y", "z"] as const).map((axis) => {
                  const e = quaternionToEuler(selected.orientation.quaternion);
                  return (
                    <NumField
                      key={`r${axis}`}
                      label={`Rot ${axis.toUpperCase()}°`}
                      testId={`kf-rot-${axis}`}
                      value={e[axis] / RAD}
                      step={1}
                      disabled={busy}
                      onCommit={(n) =>
                        patchSelected({
                          orientation: {
                            quaternion: eulerToQuaternion({ ...e, [axis]: n * RAD }),
                          },
                        })
                      }
                    />
                  );
                })}
              </div>
              <div className="mt-2">
                <NumField
                  label="Focal length (mm)"
                  testId="kf-focal"
                  value={selected.focalLengthMm}
                  step={1}
                  disabled={busy}
                  onCommit={(n) => n >= 1 && patchSelected({ focalLengthMm: n })}
                />
              </div>
              <div className="mt-2 flex gap-1.5">
                <button
                  className="btn flex-1"
                  onClick={updateFromCamera}
                  disabled={busy}
                  data-testid="kf-update"
                >
                  Update from production camera
                </button>
                <button className="btn" onClick={deleteSelected} disabled={busy} data-testid="kf-delete">
                  Delete
                </button>
              </div>
            </div>
          ) : (
            <p className="mb-2 text-xs text-muted">Select a keyframe diamond to edit it.</p>
          )}

          <button
            className="btn mb-2 w-full"
            onClick={() => {
              props.adapter().restoreAuthoredCamera();
              commitLiveCamera();
            }}
            data-testid="reset-camera"
          >
            Return camera to its set pose
          </button>

          <div className="mb-1 text-xs" data-testid="path-state">
            {saved ? (
              <>
                Saved revision <strong>{saved.revision}</strong> · {short(saved.pathFingerprint)}
                {dirty ? <span className="ml-1 text-warn">· unsaved changes</span> : null}
              </>
            ) : (
              <span className="text-warn">Not saved yet</span>
            )}
            {sceneStale ? (
              <div className="text-warn" data-testid="path-stale">
                STALE — the set changed after this path was saved.
              </div>
            ) : null}
          </div>
          <button
            className="btn btn-primary mb-2 w-full"
            onClick={() => void savePath()}
            disabled={busy || !props.ready || (!dirty && !sceneStale && !!saved)}
            data-testid="save-path"
          >
            {sceneStale && !dirty ? "Re-save against the current set" : "Save camera path"}
          </button>

          <h3 className="mb-1 mt-3 text-xs uppercase tracking-wide text-muted">Local previs</h3>
          <div className="flex gap-1.5">
            <button
              className="btn flex-1"
              onClick={() => void renderPreviewVideo()}
              disabled={busy || !props.ready}
              data-testid="render-previs"
            >
              Render previs
            </button>
            {progress ? (
              <button className="btn" onClick={() => abortRef.current?.abort()} data-testid="cancel-previs">
                Cancel
              </button>
            ) : null}
          </div>
          {progress ? (
            <div className="mt-1" data-testid="previs-progress" data-frame={progress.frame}>
              <progress className="w-full" max={progress.total} value={progress.frame} />
              <div className="text-xs text-muted">
                {progress.phase === "finalizing"
                  ? "Finalizing…"
                  : `Frame ${progress.frame} / ${progress.total}`}
              </div>
            </div>
          ) : null}
          <p className="mt-1 text-xs text-muted">
            Rendered in this browser from an isolated production camera, encoded locally and stored privately.
            Silent: no audio is synthesised.
          </p>
        </div>
      )}

      <div
        role="status"
        aria-live="polite"
        data-testid="path-status"
        data-tone={status.tone}
        className="mt-1 text-xs text-muted"
      >
        {status.text}
      </div>

      {latestClip ? (
        <div className="mt-3" data-testid="previs-player">
          <h3 className="mb-1 text-xs uppercase tracking-wide text-muted">Latest previs</h3>
          {clipStale(latestClip) ? (
            <div
              className="mb-1 rounded border border-warn px-1.5 py-0.5 text-xs text-warn"
              data-testid="previs-stale"
            >
              STALE PREVIS — the camera path or the set changed after this render.
            </div>
          ) : (
            <div className="mb-1 text-xs text-pass" data-testid="previs-current">
              Current
            </div>
          )}
          <video
            key={latestClip.assetId}
            src={`/api/assets/${latestClip.assetId}`}
            controls
            preload="metadata"
            className="w-full border border-line"
            data-testid="previs-video"
          />
          <div className="mt-0.5 text-xs text-muted">
            path r{latestClip.pathRevision} · set r{latestClip.sceneRevision} · {latestClip.renderWidth}×
            {latestClip.renderHeight} · {(latestClip.durationMs / 1000).toFixed(2)} s · {latestClip.container}
            /{latestClip.codec}
          </div>
        </div>
      ) : null}
      {clips.length > 1 ? (
        <ul className="mt-2 space-y-1 text-xs text-muted" data-testid="previs-history">
          {clips.slice(1).map((c) => (
            <li
              key={c.id}
              data-testid="previs-history-item"
              className="rounded border border-line px-1.5 py-1"
            >
              {new Date(c.renderedAt).toLocaleString()} · path r{c.pathRevision} · set r{c.sceneRevision}
              {clipStale(c) ? " · stale" : ""}{" "}
              <a className="underline" href={`/api/assets/${c.assetId}`} target="_blank" rel="noreferrer">
                open
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

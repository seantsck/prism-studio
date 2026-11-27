"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BlockingFigureData } from "@/domain/previs/blocking";
import { buildPrevisDocument, sceneFingerprint } from "@/domain/previs/document";
import { bookmarkFromCamera, cameraFromBookmark } from "@/domain/previs/camera";
import { buildHotelCanopyEngineScene } from "@/domain/previs/hotel-canopy";
import { bookmarkCameraFingerprint } from "@/domain/previs/spatial-passes";
import {
  SPATIAL_STALE_LABEL,
  SPATIAL_UNKNOWN_LABEL,
  masterFrameSpatialStatus,
} from "@/domain/previs/spatial-status";
import {
  SHARED_SET_SAVE_WARNING,
  SHOT_SWITCH_DIRTY_MESSAGE,
  locationSetHref,
  sharedSetMessage,
  shotSwitchDecisionNow,
  workingSetChanges,
  type SharedSetShot,
} from "@/domain/previs/spatial-workspace";
import { MasterFramePromoteForm } from "@/components/views/master-frame-promote-form";
import { SpatialAxisBadges } from "./spatial-axis-badges";
import {
  baseEnvironmentFingerprint,
  baseEnvironmentOf,
  type BaseEnvironment,
  type RenderLighting,
} from "@/domain/previs/lighting";
import { PREVIS_PRODUCTION_FRAME, type CameraBookmarkValue, type PrevisCamera } from "@/domain/previs/types";
import {
  ArtCraftSceneAdapter,
  type PrimitiveKind,
  type SceneObjectView,
  type SpatialSceneAdapter,
} from "@/lib/previs/scene-adapter";
import { installPrevisTestHook } from "@/lib/previs/test-hook";
import type { SpatialPassBundleRecord } from "@/data/previs-repository";
import { CharacterBlockingPanel, type BlockingState } from "./character-blocking-panel";
import { ShotLightingPanel, type LightingState } from "./shot-lighting-panel";
import type { ShotLightingData } from "@/server/previs-actions";
import {
  SplatAddPanel,
  SplatInspector,
  type ReferenceImageOption,
  type SplatEnvironmentInfo,
} from "./splat-environment-panel";
import { ReconstructionJobsPanel } from "./reconstruction-jobs-panel";
import { EnvironmentStatusPanel } from "./environment-status-panel";
import { environmentSaveIssues } from "@/domain/previs/environment-capability";
import { SpatialPassesPanel } from "./spatial-passes-panel";
import {
  CameraMotionPanel,
  type CameraMotionState,
  type CameraPathInfo,
  type PrevisClipInfo,
  type ShotTimingInfo,
} from "./camera-motion-panel";
import { useFreeCam } from "@/vendor/artcraft-scene-engine/hooks/useFreeCam";
import { useViewportPointer } from "@/vendor/artcraft-scene-engine/hooks/useViewportPointer";
import type Editor from "@/vendor/artcraft-scene-engine/engine/editor";
import {
  adoptMasterFrame,
  captureMasterFrame,
  linkShotCamera,
  saveLocationScene,
} from "@/server/previs-actions";

/**
 * Phase 4C-I2: where the ONE editor is opened from. The editor internals are shared; only the Shot affordances differ.
 *   location  Location-first set management: a Shot selector that NAVIGATES (`?shot=`), never switches in place
 *   shot      the Shot Spatial Workspace: the route owns the Shot (no selector) and opens its current Location only
 */
export type VirtualSetMode =
  | { kind: "location"; shots: Array<{ id: string; label: string }> }
  | {
      kind: "shot";
      shot: { id: string; label: string; code: string };
      shotPrepHref: string;
    };

export interface VirtualSetProps {
  projectSlug: string;
  locationId: string;
  locationName: string;
  scene: {
    sceneDocumentId: string | null;
    revision: number | null;
    fingerprint: string | null;
    /** the SAVED set's base environment identity (skybox + engine); `sceneFingerprint` does not cover it */
    baseEnvironmentFingerprint: string | null;
    engineScene: Record<string, unknown> | null;
  };
  mode: VirtualSetMode;
  /** the OTHER Shots currently assigned to this Location (server-derived; never the active Shot) */
  sharedWith: SharedSetShot[];
  characters: Array<{ id: string; name: string }>;
  glbAssets: Array<{ id: string; name: string; checksum: string | null }>;
  /** the Shot this editor is mounted for (constant for the mount: a Shot change remounts the editor) */
  activeShotId: string | null;
  bookmark: {
    id: string;
    cameraLabel: string;
    sceneRevision: number;
    sceneFingerprint: string;
    value: CameraBookmarkValue;
  } | null;
  masterFrames: Array<{
    id: string;
    assetId: string;
    sceneRevision: number;
    sceneFingerprint: string;
    capturedAt: string;
    adopted: boolean;
    /** the character blocking the frame showed (null = no visible character proxies) */
    blockingFingerprint: string | null;
    /** the rig the frame was lit by (null = no Shot Lighting Rig was recorded) */
    lightingFingerprint: string | null;
    lighting: Pick<RenderLighting, "baseEnvironment"> | null;
    /** the server-verified camera the frame was rendered with (null = not recorded: UNKNOWN camera provenance) */
    cameraFingerprint: string | null;
    /** the base environment (skybox) the frame was rendered on (null = not recorded) */
    baseEnvironmentFingerprint: string | null;
    /** the Location set (scene document) it was captured on */
    sceneDocumentId?: string;
    /** captured on another Location's set (history after a reassignment); compared with this set like any other */
    otherSet?: boolean;
  }>;
  /** the active shot's stored lighting rig and authored lighting text; null when no shot is active */
  shotLighting: ShotLightingData | null;
  /** stored character blocking of the active shot (plain data; the server derived every fingerprint) */
  blocking: BlockingFigureData[];
  shotTiming: ShotTimingInfo | null;
  cameraPath: CameraPathInfo | null;
  previsClips: PrevisClipInfo[];
  /** stored spatial control-pass bundles of the active shot (newest first) */
  spatialBundles: SpatialPassBundleRecord[];
  /** the imported Gaussian-splat environments of this location (immutable reconstruction records + result Assets) */
  splatEnvironments: SplatEnvironmentInfo[];
  /** images that can be named as reconstruction sources */
  referenceImages: ReferenceImageOption[];
}

const RAD = Math.PI / 180;
const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();
const short = (fp: string | null) => (fp ? fp.slice(0, 10) : "—");

type Status = { tone: "idle" | "ok" | "error" | "busy"; text: string };

export function VirtualSetEditor(props: VirtualSetProps) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const editorCanvasRef = useRef<HTMLCanvasElement>(null);
  const camViewCanvasRef = useRef<HTMLCanvasElement>(null);
  const adapterRef = useRef<SpatialSceneAdapter | null>(null);
  // Gaussian-splat Assets the scene loader may resolve (props, plus anything imported in this session)
  const splatInfoRef = useRef(
    new Map<string, SplatEnvironmentInfo>(props.splatEnvironments.map((e) => [e.assetId, e])),
  );
  const [splatFailures, setSplatFailures] = useState<Array<{ assetId: string; message: string }>>([]);
  const [splatEnvs, setSplatEnvs] = useState<SplatEnvironmentInfo[]>(props.splatEnvironments);

  const [editor, setEditor] = useState<Editor | null>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);
  const [mountError, setMountError] = useState<string | null>(null);
  const [objects, setObjects] = useState<SceneObjectView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [camera, setCamera] = useState<PrevisCamera | null>(null);
  const [looking, setLooking] = useState(false);
  // bumped on every adapter notification, so a change outside objects / camera (e.g. the skybox) re-checks dirty
  const [sceneTick, setSceneTick] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [revision, setRevision] = useState<number | null>(props.scene.revision);
  const [sceneDocumentId, setSceneDocumentId] = useState<string | null>(props.scene.sceneDocumentId);
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(props.scene.fingerprint);
  // the clean baseline of the dirty rule: the saved fingerprint, or the saved set WITH the restored Shot camera
  const [cleanFingerprint, setCleanFingerprint] = useState<string | null>(props.scene.fingerprint);
  const [savedBaseEnvironmentFp, setSavedBaseEnvironmentFp] = useState<string | null>(
    props.scene.baseEnvironmentFingerprint,
  );
  const [liveFingerprint, setLiveFingerprint] = useState<string | null>(null);
  const [liveBaseEnvironment, setLiveBaseEnvironment] = useState<BaseEnvironment | null>(null);
  const [status, setStatus] = useState<Status>({ tone: "idle", text: "" });
  // the Shot is the identity of this mount: switching Shots NAVIGATES and the page remounts the editor (4C-I2, P6)
  const shotId = props.activeShotId;
  const [pendingShot, setPendingShot] = useState<{ id: string | null } | null>(null);
  const [cameraRestored, setCameraRestored] = useState(false);
  const [bookmark, setBookmark] = useState(props.bookmark);
  const [frames, setFrames] = useState(props.masterFrames);
  const [characterId, setCharacterId] = useState<string>(props.characters[0]?.id ?? "");
  const [glbId, setGlbId] = useState<string>(props.glbAssets[0]?.id ?? "");
  const [transformMode, setTransformMode] = useState<"move" | "rotate" | "scale">("move");
  const savingRef = useRef(false);
  const [blockingState, setBlockingState] = useState<BlockingState | null>(null);
  const blockingRef = useRef<BlockingState | null>(null);
  const onBlockingState = useCallback((b: BlockingState) => {
    blockingRef.current = b;
    setBlockingState(b);
  }, []);
  const [lightingState, setLightingState] = useState<LightingState | null>(null);
  const lightingRef = useRef<LightingState | null>(null);
  const onLightingState = useCallback((l: LightingState) => {
    lightingRef.current = l;
    setLightingState(l);
  }, []);
  // the camera timeline's saved path + playhead, read by the spatial control-pass panel
  const [motionState, setMotionState] = useState<CameraMotionState | null>(null);
  const onMotionState = useCallback((m: CameraMotionState) => setMotionState(m), []);

  // ── lifecycle: one adapter per mount, disposed on unmount (React strict-mode safe) ──
  useEffect(() => {
    const container = containerRef.current;
    const editorCanvas = editorCanvasRef.current;
    const camViewCanvas = camViewCanvasRef.current;
    if (!container || !editorCanvas || !camViewCanvas) return;
    const adapter = new ArtCraftSceneAdapter({
      resolveAssetUrl: (id) => `/api/assets/${id}`,
      splatAssets: () =>
        new Map([...splatInfoRef.current].map(([id, e]) => [id, { format: e.format, name: e.name }])),
    });
    adapterRef.current = adapter;
    let cancelled = false;
    let removeTestHook = () => {};

    const sync = () => {
      if (cancelled) return;
      setObjects(adapter.listObjects());
      setSelectedId(adapter.selectedId());
      setCamera(adapter.getProductionCamera());
      setLooking(adapter.isLookingThroughProductionCamera());
      setCanUndo(adapter.canUndo());
      setCanRedo(adapter.canRedo());
      setSplatFailures(adapter.splatFailures().map((f) => ({ assetId: f.assetId, message: f.message })));
    };
    const unsubscribe = adapter.subscribe(() => {
      sync();
      if (!cancelled) setSceneTick((n) => n + 1);
    });

    adapter
      .mount({ container, editorCanvas, camViewCanvas }, props.scene.engineScene)
      .then(async () => {
        if (cancelled) return;
        // Shot workspace: the Shot's bookmark is the Shot's camera authority, so it becomes the working production
        // camera of the viewport. That is NOT a Set edit: nothing is saved, the revision does not move, and the clean
        // baseline is taken AFTER the restore, so the Set is not dirty merely because the Shot camera was restored.
        // The saved scene (its own camera included) is applied asynchronously after `mount`: restore only after it.
        const bm = props.mode.kind === "shot" && props.scene.engineScene ? props.bookmark : null;
        if (bm) {
          const loaded = await Promise.race([
            adapter.sceneLoaded(),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000)),
          ]);
          if (cancelled) return;
          const cam = adapter.getProductionCamera();
          if (loaded && cam) {
            adapter.setProductionCamera(cameraFromBookmark(cam.id, bm.cameraLabel, bm.value));
            try {
              const restored = sceneFingerprint(
                buildPrevisDocument({ engineScene: adapter.serializeScene() }),
              );
              setCleanFingerprint(restored);
              setCameraRestored(restored !== props.scene.fingerprint);
            } catch {
              /* an unserialisable scene keeps the saved baseline (it shows as unsaved) */
            }
          }
        }
        setEditor(adapter.getEditor());
        setCanvasEl(editorCanvas);
        removeTestHook = installPrevisTestHook(adapter, editorCanvas);
        setReady(true);
        sync();
      })
      .catch((err: unknown) => {
        if (!cancelled) setMountError(err instanceof Error ? err.message : "The 3D set could not start.");
      });

    return () => {
      cancelled = true;
      removeTestHook();
      unsubscribe();
      adapter.dispose();
      adapterRef.current = null;
      setEditor(null);
      setCanvasEl(null);
      setReady(false);
    };
    // mount once per page load: the scene prop is the initial scene only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useViewportPointer(canvasEl, editor);
  useFreeCam(canvasEl, editor);

  // ── frame overlay: map the exact production framing into a fitted 2.39:1 rect while looking through ──
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const frameRect = useMemo(() => {
    if (box.w <= 0 || box.h <= 0) return null;
    const ratio = PREVIS_PRODUCTION_FRAME.width / PREVIS_PRODUCTION_FRAME.height;
    const margin = 24;
    const w = Math.min(box.w - margin * 2, (box.h - margin * 2) * ratio);
    const h = w / ratio;
    return { x: (box.w - w) / 2, y: (box.h - h) / 2, width: w, height: h };
  }, [box]);
  useEffect(() => {
    if (!editor || !frameRect) return;
    editor.cameraController.setCameraFrameRect(
      looking ? { ...frameRect, canvasWidth: box.w, canvasHeight: box.h } : null,
    );
  }, [editor, looking, frameRect, box]);

  // ── dirty tracking: fingerprint of the production-relevant state (never selection or navigation) ──
  useEffect(() => {
    if (!ready || !adapterRef.current) return;
    const t = setTimeout(() => {
      try {
        const doc = buildPrevisDocument({ engineScene: adapterRef.current!.serializeScene() });
        setLiveFingerprint(sceneFingerprint(doc));
        setLiveBaseEnvironment(baseEnvironmentOf(doc));
      } catch {
        setLiveFingerprint(null);
        setLiveBaseEnvironment(null);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [ready, objects, camera, sceneTick]);
  const liveBaseEnvironmentFp = useMemo(
    () => (liveBaseEnvironment ? baseEnvironmentFingerprint(liveBaseEnvironment) : null),
    [liveBaseEnvironment],
  );
  // Location-owned truth only (scene + base environment); a restored Shot camera is part of the clean baseline
  const { dirty } = workingSetChanges({
    liveFingerprint,
    cleanFingerprint,
    liveBaseEnvironmentFingerprint: liveBaseEnvironmentFp,
    savedBaseEnvironmentFingerprint: savedBaseEnvironmentFp,
  });
  // what the SERVER's saved set does not have yet (a restored Shot camera included): linking freezes the saved camera
  const unsaved = dirty || (liveFingerprint !== null && liveFingerprint !== savedFingerprint);

  // ── keyboard shortcuts (movement keys belong to the free camera) ──
  useEffect(() => {
    if (!ready) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      const a = adapterRef.current;
      if (!a) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void (e.shiftKey ? a.redo() : a.undo());
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void a.redo();
      } else if (e.key === "1" || e.key === "2" || e.key === "3") {
        const mode = e.key === "1" ? "move" : e.key === "2" ? "rotate" : "scale";
        a.setTransformMode(mode);
        setTransformMode(mode);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        // a selected character proxy is removed from the SHOT (undoable), never through the set's object delete
        const proxy = a.blocking.selectedCharacter();
        if (proxy) a.blocking.remove(proxy);
        else if (a.selectedId()) a.removeObject(a.selectedId()!);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ready]);

  // ── actions ──
  const adapter = () => adapterRef.current!;

  const save = useCallback(async (): Promise<{
    id: string;
    revision: number;
    fingerprint: string;
  } | null> => {
    if (savingRef.current) return null;
    savingRef.current = true;
    setStatus({ tone: "busy", text: "Saving…" });
    try {
      const fd = new FormData();
      fd.set("projectSlug", props.projectSlug);
      fd.set("locationId", props.locationId);
      fd.set("expectedRevision", revision === null ? "" : String(revision));
      const engineScene = adapter().serializeScene();
      fd.set("sceneJson", JSON.stringify(engineScene));
      // 4E: the same environment limits the server enforces, explained before a round trip (the server still decides)
      try {
        const [limit] = environmentSaveIssues(engineScene, buildPrevisDocument({ engineScene }).objects);
        if (limit) {
          setStatus({ tone: "error", text: limit.message });
          return null;
        }
      } catch {
        // an unbuildable scene is refused by the server with its own message
      }
      let savedEnv: string | null = null;
      try {
        savedEnv = baseEnvironmentFingerprint(baseEnvironmentOf(buildPrevisDocument({ engineScene })));
      } catch {
        savedEnv = null; // the server refuses an unbuildable scene anyway
      }
      const r = await saveLocationScene(fd);
      if (!r.ok) {
        setStatus({
          tone: "error",
          text: r.conflict ? "This set changed elsewhere. Reload the page to continue." : r.error,
        });
        return null;
      }
      setRevision(r.revision);
      setSceneDocumentId(r.sceneDocumentId);
      setSavedFingerprint(r.fingerprint);
      setCleanFingerprint(r.fingerprint);
      setSavedBaseEnvironmentFp(savedEnv);
      setCameraRestored(false);
      setStatus({
        tone: "ok",
        text:
          revision === null
            ? `Saved — revision ${r.revision} (3D Set created)`
            : `Saved — revision ${r.revision}`,
      });
      return { id: r.sceneDocumentId, revision: r.revision, fingerprint: r.fingerprint };
    } finally {
      savingRef.current = false;
    }
  }, [props.projectSlug, props.locationId, revision]);

  // "save first?" is decided from the adapter NOW: the debounced live fingerprint can lag an edit made just before a
  // click (link / capture), and a stale "clean" would freeze the OLD saved camera while the client claims the new one
  const pendingSetChanges = () => {
    try {
      const doc = buildPrevisDocument({ engineScene: adapter().serializeScene() });
      const fp = sceneFingerprint(doc);
      const { dirty: changed } = workingSetChanges({
        liveFingerprint: fp,
        cleanFingerprint,
        liveBaseEnvironmentFingerprint: baseEnvironmentFingerprint(baseEnvironmentOf(doc)),
        savedBaseEnvironmentFingerprint: savedBaseEnvironmentFp,
      });
      return { dirty: changed, unsaved: changed || fp !== savedFingerprint };
    } catch {
      return { dirty, unsaved };
    }
  };

  const ensureSaved = async () => {
    if (!pendingSetChanges().dirty && revision !== null && sceneDocumentId)
      return { revision, fingerprint: savedFingerprint! };
    const r = await save();
    return r ? { revision: r.revision, fingerprint: r.fingerprint } : null;
  };

  const linkCamera = async () => {
    if (!shotId) return setStatus({ tone: "error", text: "Choose a shot first." });
    if (!camera) return setStatus({ tone: "error", text: "This set has no production camera." });
    // the server freezes the SAVED set's camera: the working camera must be saved first (as before 4C-I2)
    const saved = pendingSetChanges().unsaved ? await save() : await ensureSaved();
    if (!saved) return;
    setStatus({ tone: "busy", text: "Linking camera…" });
    const fd = new FormData();
    fd.set("projectSlug", props.projectSlug);
    fd.set("shotId", shotId);
    fd.set("locationId", props.locationId);
    const r = await linkShotCamera(fd);
    if (!r.ok) return setStatus({ tone: "error", text: r.error });
    setBookmark({
      id: r.bookmarkId,
      cameraLabel: camera.label,
      sceneRevision: r.sceneRevision,
      sceneFingerprint: r.sceneFingerprint,
      value: bookmarkFromCamera(camera),
    });
    setStatus({
      tone: "ok",
      text: `Production camera linked to the shot (scene revision ${r.sceneRevision})`,
    });
    router.refresh();
  };

  const restoreCamera = () => {
    if (!bookmark || !camera) return;
    adapter().setProductionCamera(cameraFromBookmark(camera.id, bookmark.cameraLabel, bookmark.value));
    setStatus({ tone: "ok", text: "Production camera restored from the shot bookmark" });
  };

  const capture = async () => {
    if (!shotId) return setStatus({ tone: "error", text: "Choose a shot first." });
    const saved = await ensureSaved();
    if (!saved) return;
    if (!bookmark)
      return setStatus({ tone: "error", text: "Use the production camera for this shot first." });
    // the frame shows the Shot's character proxies, so the blocking it shows must be the saved blocking
    if (blockingRef.current?.dirty) {
      const b = await blockingRef.current.ensureSaved();
      if (!b) return;
    }
    const renderedBlocking = blockingRef.current?.liveFingerprint() ?? null;
    // unsaved lighting is never captured as if it were the Shot's lighting
    const lighting = lightingRef.current;
    if (!lighting?.loaded || lighting.shotId !== shotId)
      return setStatus({ tone: "error", text: "This Shot's lighting is still loading." });
    if (lighting.dirty)
      return setStatus({ tone: "error", text: "Save or discard the Shot lighting before capturing." });
    const renderedLighting = adapter().lighting.appliedFingerprint();
    setStatus({ tone: "busy", text: "Rendering master frame…" });
    try {
      // the claim names the EXACT bookmark camera the render used; the server compares it with THIS Shot's bookmark
      const renderedBookmark = bookmark.value;
      const frame = await adapter().captureMasterFrame(renderedBookmark);
      const fd = new FormData();
      fd.set("cameraFingerprint", bookmarkCameraFingerprint(renderedBookmark));
      fd.set("projectSlug", props.projectSlug);
      fd.set("shotId", shotId);
      fd.set("locationId", props.locationId);
      fd.set("sceneRevision", String(saved.revision));
      if (renderedBlocking) fd.set("blockingFingerprint", renderedBlocking);
      if (renderedLighting) fd.set("lightingFingerprint", renderedLighting);
      fd.set("file", new File([frame.blob], "master-frame.png", { type: "image/png" }));
      const r = await captureMasterFrame(fd);
      if (!r.ok) return setStatus({ tone: "error", text: r.error });
      setFrames((f) => [
        {
          id: r.masterFrameId,
          assetId: r.assetId,
          sceneRevision: saved.revision,
          sceneFingerprint: saved.fingerprint,
          sceneDocumentId: sceneDocumentId ?? undefined,
          capturedAt: new Date().toISOString(),
          adopted: false,
          blockingFingerprint: renderedBlocking,
          lightingFingerprint: renderedLighting,
          lighting: lighting.current.baseEnvironment
            ? { baseEnvironment: lighting.current.baseEnvironment }
            : null,
          cameraFingerprint: bookmarkCameraFingerprint(renderedBookmark),
          baseEnvironmentFingerprint: lighting.current.baseEnvironment
            ? baseEnvironmentFingerprint(lighting.current.baseEnvironment)
            : null,
        },
        ...f,
      ]);
      setStatus({ tone: "ok", text: `Master frame saved privately (${frame.width}×${frame.height})` });
      router.refresh();
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : "Capture failed." });
    }
  };

  const adopt = async (id: string) => {
    const fd = new FormData();
    fd.set("projectSlug", props.projectSlug);
    fd.set("masterFrameId", id);
    const r = await adoptMasterFrame(fd);
    if (!r.ok) return setStatus({ tone: "error", text: r.error });
    setFrames((f) => f.map((x) => (x.id === id ? { ...x, adopted: true } : x)));
    setStatus({ tone: "ok", text: "Added as a new storyboard frame and set as this shot's master frame" });
    router.refresh();
  };

  const loadTestSet = async () => {
    await adapter().loadScene(buildHotelCanopyEngineScene({ characterId: characterId || undefined }));
    setStatus({ tone: "ok", text: "Hotel Canopy Test Set loaded — save to keep it" });
  };

  // ── Location page Shot selector: a NAVIGATION to ?shot=, asked first while the Set has unsaved changes ──
  const switchShot = (to: string | null) => {
    // P6: decided from the Set at the click (the adapter, serialized now), never the debounced dirty badge: an edit
    // made just before choosing a Shot must ask first. Location-owned truth only (the clean baseline includes a
    // restored Shot camera, so opening a Shot does not look dirty).
    const decision = shotSwitchDecisionNow({
      from: shotId,
      to,
      readSetDirty: () => pendingSetChanges().dirty,
    });
    if (decision === "none") return setPendingShot(null);
    if (decision === "confirm") return setPendingShot({ id: to });
    setPendingShot(null);
    router.push(locationSetHref(props.projectSlug, props.locationId, to));
  };
  const discardAndSwitch = () => {
    if (!pendingShot) return;
    const to = pendingShot.id;
    setPendingShot(null);
    // nothing is saved: leaving remounts the editor from the server's saved set
    router.push(locationSetHref(props.projectSlug, props.locationId, to));
  };

  const selected = objects.find((o) => o.id === selectedId) ?? null;
  const shotLabel =
    props.mode.kind === "shot"
      ? props.mode.shot.label
      : (props.mode.shots.find((s) => s.id === shotId)?.label ?? null);
  const shared = props.sharedWith.length > 0;
  const sharedMessage = sharedSetMessage(props.sharedWith);
  const bookmarkStale = !!bookmark && !!savedFingerprint && bookmark.sceneFingerprint !== savedFingerprint;
  // the ACTIVE Shot's production camera (the page loaded it for that Shot), for the Master Frame camera axis
  const activeBookmarkCamera = useMemo(
    () => (props.bookmark ? bookmarkCameraFingerprint(props.bookmark.value) : null),
    [props.bookmark],
  );

  return (
    <div
      className="flex h-[calc(100vh-7.5rem)] min-h-[560px] flex-col"
      data-testid="virtual-set"
      data-ready={ready ? "true" : "false"}
      data-object-count={objects.length}
      data-revision={revision ?? ""}
      data-dirty={dirty ? "true" : "false"}
      data-looking={looking ? "true" : "false"}
      data-saved-fingerprint={savedFingerprint ?? ""}
      data-live-fingerprint={liveFingerprint ?? ""}
      data-mode={props.mode.kind}
      data-shot-id={shotId ?? ""}
      data-scene-document-id={sceneDocumentId ?? ""}
      data-camera-restored={cameraRestored ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-sm">
        <span className="font-medium">{props.locationName}</span>
        <span className="text-muted">
          · 3D Set · {PREVIS_PRODUCTION_FRAME.ratio} production frame · revision {revision ?? "unsaved"} ·
          fingerprint <span data-testid="set-fingerprint">{short(savedFingerprint)}</span>
        </span>
        {dirty ? (
          <span className="rounded border border-warn px-1.5 text-xs text-warn" data-testid="dirty-badge">
            unsaved changes
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <button
            className="btn"
            disabled={!canUndo}
            onClick={() => void adapter().undo()}
            data-testid="undo"
          >
            Undo
          </button>
          <button
            className="btn"
            disabled={!canRedo}
            onClick={() => void adapter().redo()}
            data-testid="redo"
          >
            Redo
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void save()}
            // saving while a splat failed to load would silently drop it from the set
            disabled={!ready || status.tone === "busy" || splatFailures.length > 0}
            data-testid="save-set"
          >
            {revision === null ? "Create 3D Set" : "Save 3D Set"}
          </button>
        </span>
      </div>
      {shared && dirty ? (
        <div className="border-b border-warn/40 px-4 py-1 text-xs text-warn" data-testid="shared-set-warning">
          {SHARED_SET_SAVE_WARNING}
        </div>
      ) : null}
      {revision === null ? (
        <div className="border-b border-line px-4 py-1 text-xs text-muted" data-testid="new-set-state">
          {props.locationName} has no 3D Set yet. Build one here, then Create 3D Set: it becomes this
          Location&apos;s set for every Shot assigned to it.
        </div>
      ) : null}
      <div
        role="status"
        aria-live="polite"
        data-testid="set-status"
        data-tone={status.tone}
        className={`px-4 py-1 text-xs ${status.tone === "error" ? "text-fail" : status.tone === "ok" ? "text-pass" : "text-muted"}`}
      >
        {status.text || " "}
      </div>

      {splatFailures.length > 0 ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-fail px-4 py-1.5 text-xs text-fail"
          data-testid="splat-failure"
        >
          <span>
            {splatFailures.map((f) => f.message).join(" ")} Saving is disabled so it is not dropped from this
            set.
          </span>
          <button
            className="btn"
            data-testid="splat-discard-failed"
            onClick={() => adapter().discardSplatFailures()}
          >
            Remove it from this set
          </button>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)_300px]">
        {/* ── left: add + outliner ── */}
        <aside className="overflow-auto border-r border-line p-3 text-sm" aria-label="Scene objects">
          <h2 className="mb-1 text-xs uppercase tracking-wide text-muted">Add</h2>
          <div className="mb-3 grid grid-cols-2 gap-1.5">
            {(["Box", "Plane", "Cylinder"] as PrimitiveKind[]).map((k) => (
              <button
                key={k}
                className="btn"
                disabled={!ready}
                data-testid={`add-${k.toLowerCase()}`}
                onClick={() => void adapter().addPrimitive(k)}
              >
                {k === "Box" ? "Cube" : k}
              </button>
            ))}
            <button
              className="btn"
              disabled={!ready}
              data-testid="add-mannequin"
              onClick={() =>
                void adapter().addMannequin(
                  characterId || null,
                  props.characters.find((c) => c.id === characterId)?.name ?? "Mannequin",
                )
              }
            >
              Mannequin
            </button>
          </div>
          {props.characters.length > 0 ? (
            <label className="mb-3 block text-xs text-muted">
              Mannequin blocks
              <select
                className="mt-1 w-full"
                value={characterId}
                onChange={(e) => setCharacterId(e.target.value)}
                data-testid="mannequin-character"
              >
                <option value="">(no character)</option>
                {props.characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {props.glbAssets.length > 0 ? (
            <div className="mb-3 text-xs text-muted">
              <label className="block">
                3D model (GLB)
                <select className="mt-1 w-full" value={glbId} onChange={(e) => setGlbId(e.target.value)}>
                  {props.glbAssets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn mt-1.5 w-full"
                disabled={!ready || !glbId}
                data-testid="add-glb"
                onClick={() => {
                  const a = props.glbAssets.find((x) => x.id === glbId);
                  if (a) void adapter().addGlb(a.id, a.name, a.checksum);
                }}
              >
                Add model
              </button>
            </div>
          ) : null}
          <SplatAddPanel
            projectSlug={props.projectSlug}
            locationId={props.locationId}
            ready={ready}
            adapter={adapter}
            objects={objects}
            environments={splatEnvs}
            referenceImages={props.referenceImages}
            onImported={(info) => {
              splatInfoRef.current.set(info.assetId, info);
              setSplatEnvs((list) => [info, ...list.filter((x) => x.assetId !== info.assetId)]);
            }}
            onStatus={(tone, text) => setStatus({ tone, text })}
          />
          <ReconstructionJobsPanel
            projectSlug={props.projectSlug}
            locationId={props.locationId}
            ready={ready}
            adapter={adapter}
            objects={objects}
            referenceImages={props.referenceImages}
            onResult={(info) => {
              // registered BEFORE the splat is added, so the scene loader can resolve its Asset
              splatInfoRef.current.set(info.assetId, info);
              setSplatEnvs((list) => [info, ...list.filter((x) => x.assetId !== info.assetId)]);
            }}
            onStatus={(tone, text) => setStatus({ tone, text })}
          />
          <button
            className="btn mb-4 w-full"
            disabled={!ready}
            onClick={() => void loadTestSet()}
            data-testid="load-test-set"
          >
            Load Hotel Canopy Test Set
          </button>

          <h2 className="mb-1 text-xs uppercase tracking-wide text-muted">Outliner</h2>
          <ul data-testid="outliner" className="space-y-0.5">
            {objects.length === 0 ? <li className="text-muted">Empty set</li> : null}
            {objects.map((o) => (
              <li key={o.id}>
                <button
                  data-testid="outliner-item"
                  data-object-id={o.id}
                  data-selected={o.id === selectedId ? "true" : "false"}
                  className={`w-full truncate rounded px-2 py-1 text-left ${o.id === selectedId ? "bg-accent/20" : "hover:bg-panel"}`}
                  onClick={() => adapter().select(o.id)}
                >
                  {o.name || o.shape || "object"}
                  <span className="ml-1 text-xs text-muted">
                    {o.kind === "splat" ? "gaussian splat" : o.kind}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* ── centre: viewport ── */}
        <div className="relative min-h-0 bg-black" data-testid="viewport">
          <div ref={containerRef} id="video-scene-container" className="absolute inset-0">
            <canvas
              ref={editorCanvasRef}
              id="video-scene"
              data-testid="set-canvas"
              className="absolute inset-0 h-full w-full"
              tabIndex={0}
            />
            <canvas ref={camViewCanvasRef} id="camera-view" className="hidden" />
            {looking && frameRect ? (
              <div className="pointer-events-none absolute inset-0" data-testid="frame-overlay">
                <div
                  className="absolute border border-white/80"
                  style={{
                    left: frameRect.x,
                    top: frameRect.y,
                    width: frameRect.width,
                    height: frameRect.height,
                    boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
                  }}
                >
                  <span className="absolute left-1 top-1 text-[10px] text-white/80">
                    {camera?.label ?? "CAM"} · {camera ? `${fmt(camera.focalLengthMm)} mm` : ""} ·{" "}
                    {PREVIS_PRODUCTION_FRAME.ratio}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
          {mountError ? (
            <div
              role="alert"
              className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center text-sm text-fail"
            >
              The 3D set could not start: {mountError}
            </div>
          ) : null}
          <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-[11px] text-white/80">
            Right-drag pan · wheel zoom · W A S D Q E fly · 1 move · 2 rotate · 3 scale · Del remove
          </div>
        </div>

        {/* ── right: inspector, camera, shot ── */}
        <aside className="overflow-auto border-l border-line p-3 text-sm" aria-label="Inspector">
          <EnvironmentStatusPanel objects={objects} />
          <h2 className="mb-1 text-xs uppercase tracking-wide text-muted">Tool</h2>
          <div className="mb-3 flex gap-1.5">
            {(["move", "rotate", "scale"] as const).map((m, i) => (
              <button
                key={m}
                className={`btn flex-1 ${transformMode === m ? "btn-primary" : ""}`}
                data-testid={`mode-${m}`}
                disabled={!ready}
                onClick={() => {
                  adapter().setTransformMode(m);
                  setTransformMode(m);
                }}
              >
                {["Move", "Rotate", "Scale"][i]}
              </button>
            ))}
          </div>

          <h2 className="mb-1 text-xs uppercase tracking-wide text-muted">Selected object</h2>
          {selected?.kind === "splat" ? (
            <SplatInspector
              adapter={adapter}
              object={selected}
              environment={splatEnvs.find((e) => e.assetId === selected.assetId) ?? null}
            />
          ) : null}
          {selected ? (
            <TransformFields
              key={`${selected.id}:${[selected.position, selected.rotation, selected.scale].map((v) => `${fmt(v.x)},${fmt(v.y)},${fmt(v.z)}`).join("|")}`}
              testId="inspector"
              name={selected.name}
              position={selected.position}
              rotationDeg={{
                x: selected.rotation.x / RAD,
                y: selected.rotation.y / RAD,
                z: selected.rotation.z / RAD,
              }}
              scale={selected.scale}
              onChange={(c) =>
                adapter().updateTransform(selected.id, {
                  position: c.position,
                  rotation: c.rotationDeg
                    ? { x: c.rotationDeg.x * RAD, y: c.rotationDeg.y * RAD, z: c.rotationDeg.z * RAD }
                    : undefined,
                  scale: c.scale,
                })
              }
              extra={
                selected.kind === "mannequin" ? (
                  <label className="mt-2 block text-xs text-muted">
                    Blocks character
                    <select
                      className="mt-1 w-full"
                      value={selected.characterId ?? ""}
                      data-testid="object-character"
                      onChange={(e) => adapter().setObjectCharacter(selected.id, e.target.value || null)}
                    >
                      <option value="">(none)</option>
                      {props.characters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <span className="mt-1 block">The mannequin shows position and scale, not identity.</span>
                  </label>
                ) : null
              }
            />
          ) : (
            <p className="mb-3 text-muted">Select an object in the viewport or outliner.</p>
          )}

          <h2 className="mb-1 mt-4 text-xs uppercase tracking-wide text-muted">Production camera</h2>
          {camera ? (
            <div data-testid="production-camera">
              <TransformFields
                key={`cam:${[camera.position, camera.rotation].map((v) => `${fmt(v.x)},${fmt(v.y)},${fmt(v.z)}`).join("|")}:${fmt(camera.focalLengthMm)}`}
                testId="camera"
                name={`${camera.label}`}
                position={camera.position}
                rotationDeg={{
                  x: camera.rotation.x / RAD,
                  y: camera.rotation.y / RAD,
                  z: camera.rotation.z / RAD,
                }}
                scale={null}
                focalLengthMm={camera.focalLengthMm}
                onChange={(c) =>
                  adapter().setProductionCamera({
                    ...camera,
                    position: c.position ?? camera.position,
                    rotation: c.rotationDeg
                      ? { x: c.rotationDeg.x * RAD, y: c.rotationDeg.y * RAD, z: c.rotationDeg.z * RAD }
                      : camera.rotation,
                    focalLengthMm: c.focalLengthMm ?? camera.focalLengthMm,
                  })
                }
              />
              <button
                className="btn mt-2 w-full"
                onClick={() => adapter().lookThroughProductionCamera(!looking)}
                data-testid="toggle-camera-view"
              >
                {looking ? "Exit camera view" : "Look through production camera"}
              </button>
              <p className="mt-1 text-xs text-muted">
                This is the shot camera. The navigation camera you fly with is separate and is never saved as
                a shot camera.
              </p>
            </div>
          ) : (
            <p className="text-muted">This set has no production camera.</p>
          )}

          <h2 className="mb-1 mt-4 text-xs uppercase tracking-wide text-muted">Shot</h2>
          {props.mode.kind === "location" ? (
            <label className="block text-xs text-muted">
              Shot
              <select
                className="mt-1 w-full"
                value={pendingShot ? (pendingShot.id ?? "") : (shotId ?? "")}
                onChange={(e) => switchShot(e.target.value || null)}
                data-testid="shot-select"
              >
                <option value="">(choose a shot)</option>
                {props.mode.shots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="text-xs" data-testid="workspace-shot">
              <div className="font-medium text-fg">{props.mode.shot.label}</div>
              {sharedMessage ? (
                <div className="mt-1 text-muted" data-testid="shared-set-context">
                  {sharedMessage}
                </div>
              ) : null}
            </div>
          )}
          {pendingShot ? (
            <div
              role="alert"
              className="mt-2 rounded border border-warn p-2 text-xs"
              data-testid="shot-switch-confirm"
            >
              <div className="text-warn">{SHOT_SWITCH_DIRTY_MESSAGE}</div>
              <div className="mt-1.5 flex gap-1.5">
                <button
                  className="btn flex-1"
                  onClick={() => setPendingShot(null)}
                  data-testid="shot-switch-stay"
                >
                  Stay
                </button>
                <button className="btn flex-1" onClick={discardAndSwitch} data-testid="shot-switch-discard">
                  Discard and switch
                </button>
              </div>
            </div>
          ) : null}
          <button
            className="btn btn-primary mt-2 w-full"
            disabled={!ready || !shotId}
            onClick={() => void linkCamera()}
            data-testid="link-shot-camera"
          >
            Use Production Camera for Shot
          </button>
          {bookmark ? (
            <div className="mt-2 rounded border border-line p-2 text-xs" data-testid="bookmark-info">
              <div>
                Linked: <strong>{bookmark.cameraLabel}</strong> · revision {bookmark.sceneRevision} ·{" "}
                {short(bookmark.sceneFingerprint)}
              </div>
              {bookmarkStale ? (
                <div className="text-warn" data-testid="bookmark-stale">
                  The set has changed since this camera was linked.
                </div>
              ) : null}
              <button className="btn mt-1.5 w-full" onClick={restoreCamera} data-testid="restore-camera">
                Restore Shot camera{shotLabel ? ` for ${shotLabel}` : ""}
              </button>
              {cameraRestored ? (
                <div className="mt-1 text-muted" data-testid="camera-restored-note">
                  Viewing this Shot&apos;s camera. The Set&apos;s saved working camera differs; it changes
                  only when you save the Set or use the production camera for this Shot.
                </div>
              ) : null}
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted">No production camera is linked to this shot yet.</p>
          )}

          {shotId ? (
            <CameraMotionPanel
              key={shotId}
              adapter={adapter}
              ready={ready}
              projectSlug={props.projectSlug}
              locationId={props.locationId}
              shotId={shotId}
              camera={camera}
              looking={looking}
              timing={props.shotTiming}
              initialPath={props.cameraPath}
              initialClips={props.previsClips}
              savedSceneFingerprint={savedFingerprint}
              sceneDirty={dirty}
              ensureSceneSaved={ensureSaved}
              lighting={{
                loaded: lightingState?.loaded === true && lightingState.shotId === shotId,
                dirty: lightingState?.dirty ?? false,
                current: lightingState?.current ?? { lightingFingerprint: null, baseEnvironment: null },
                appliedFingerprint: () => adapterRef.current?.lighting.appliedFingerprint() ?? null,
              }}
              blocking={{
                savedFingerprint: blockingState?.savedFingerprint ?? null,
                dirty: blockingState?.dirty ?? false,
                liveFingerprint: () => blockingRef.current?.liveFingerprint() ?? null,
              }}
              onMotionState={onMotionState}
            />
          ) : null}

          {shotId ? (
            <CharacterBlockingPanel
              key={`blocking:${shotId}`}
              adapter={adapter}
              ready={ready}
              projectSlug={props.projectSlug}
              locationId={props.locationId}
              shotId={shotId}
              characters={props.characters}
              initial={props.blocking}
              savedSceneFingerprint={savedFingerprint}
              sceneDirty={dirty}
              ensureSceneSaved={ensureSaved}
              onState={onBlockingState}
            />
          ) : null}

          {shotId ? (
            <ShotLightingPanel
              key={`lighting:${shotId}`}
              adapter={adapter}
              ready={ready}
              projectSlug={props.projectSlug}
              locationId={props.locationId}
              shotId={shotId}
              initial={props.shotLighting}
              savedSceneFingerprint={savedFingerprint}
              sceneDocumentId={sceneDocumentId}
              sceneDirty={dirty}
              baseEnvironment={dirty ? null : liveBaseEnvironment}
              ensureSceneSaved={ensureSaved}
              hasVisibleSplat={objects.some((o) => o.kind === "splat" && o.visible)}
              onState={onLightingState}
            />
          ) : null}

          {shotId ? (
            <SpatialPassesPanel
              key={`spatial:${shotId}`}
              adapter={adapter}
              ready={ready}
              projectSlug={props.projectSlug}
              locationId={props.locationId}
              shotId={shotId}
              characters={props.characters}
              initialBundles={props.spatialBundles}
              scene={{ documentId: sceneDocumentId, revision, fingerprint: savedFingerprint, dirty }}
              bookmark={
                bookmark
                  ? { id: bookmark.id, sceneFingerprint: bookmark.sceneFingerprint, value: bookmark.value }
                  : null
              }
              motion={motionState}
              blocking={blockingState}
              hasVisibleSplat={objects.some((o) => o.kind === "splat" && o.visible)}
            />
          ) : null}

          <h2 className="mb-1 mt-4 text-xs uppercase tracking-wide text-muted">Master frame</h2>
          <button
            className="btn w-full"
            disabled={!ready || !shotId}
            onClick={() => void capture()}
            data-testid="capture-master-frame"
          >
            Capture Master Frame
          </button>
          <ul className="mt-2 space-y-1.5" data-testid="master-frames">
            {frames.map((f) => (
              <li key={f.id} className="rounded border border-line p-1.5 text-xs" data-testid="master-frame">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/assets/${f.assetId}`}
                  alt="Master frame"
                  className="mb-1 w-full border border-line"
                  data-testid="master-frame-image"
                />
                <div className="text-muted">
                  revision {f.sceneRevision} ·{" "}
                  <time dateTime={f.capturedAt} data-testid="master-frame-captured">
                    {new Date(f.capturedAt).toLocaleString()}
                  </time>
                  {f.otherSet ? (
                    <span className="ml-1 text-warn" data-testid="master-frame-other-set">
                      · captured on another Location
                    </span>
                  ) : null}
                </div>
                {blockingState && lightingState?.loaded
                  ? (() => {
                      const status = masterFrameSpatialStatus(f, {
                        sceneFingerprint: savedFingerprint,
                        sceneDocumentId,
                        cameraFingerprint: activeBookmarkCamera,
                        blockingFingerprint: blockingState.savedFingerprint,
                        lighting: lightingState.current,
                      });
                      return [
                        <SpatialAxisBadges key="axes" status={status} testIdPrefix={`mf-axis-${f.id}`} />,
                        ...status.stale.map((reason) => (
                          <div
                            key={reason}
                            className="text-warn"
                            data-testid={
                              reason === "blocking" ? "master-frame-stale" : `master-frame-stale-${reason}`
                            }
                          >
                            {SPATIAL_STALE_LABEL[reason]}
                          </div>
                        )),
                        ...status.unknown.map((axis) => (
                          <div
                            key={`u:${axis}`}
                            className="text-muted"
                            data-testid={`master-frame-unknown-${axis}`}
                          >
                            {SPATIAL_UNKNOWN_LABEL[axis]}
                          </div>
                        )),
                      ];
                    })()
                  : null}
                {f.adopted ? (
                  <span className="text-pass" data-testid="master-frame-adopted">
                    Master frame for this shot
                  </span>
                ) : (
                  <button
                    className="btn mt-1 w-full"
                    onClick={() => void adopt(f.id)}
                    data-testid="adopt-master-frame"
                  >
                    Use as Master Frame
                  </button>
                )}
                {shotId ? (
                  // the SAME server action and confirmation flow as Shot Prep (the server recomputes the state)
                  <div className="mt-1" data-testid={`workspace-promote-${f.id}`}>
                    <MasterFramePromoteForm
                      slug={props.projectSlug}
                      shotId={shotId}
                      masterFrameId={f.id}
                      disabled={!ready}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}

function TransformFields(props: {
  testId: string;
  name: string;
  position: { x: number; y: number; z: number } | null;
  rotationDeg: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number } | null;
  focalLengthMm?: number;
  extra?: React.ReactNode;
  onChange: (c: {
    position?: { x: number; y: number; z: number };
    rotationDeg?: { x: number; y: number; z: number };
    scale?: { x: number; y: number; z: number };
    focalLengthMm?: number;
  }) => void;
}) {
  const { testId } = props;
  const row = (
    label: string,
    key: "position" | "rotationDeg" | "scale",
    value: { x: number; y: number; z: number } | null,
  ) =>
    value ? (
      <div className="mb-1.5">
        <div className="text-xs text-muted">{label}</div>
        <div className="grid grid-cols-3 gap-1">
          {(["x", "y", "z"] as const).map((axis) => (
            <input
              key={axis}
              type="number"
              step="0.1"
              aria-label={`${label} ${axis.toUpperCase()}`}
              data-testid={`${testId}-${key === "rotationDeg" ? "rot" : key === "position" ? "pos" : "scale"}-${axis}`}
              defaultValue={fmt(value[axis])}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (!Number.isFinite(n) || n === value[axis]) return;
                props.onChange({ [key]: { ...value, [axis]: n } });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          ))}
        </div>
      </div>
    ) : null;
  return (
    <div className="mb-2">
      <div className="mb-1 truncate font-medium" data-testid={`${testId}-name`}>
        {props.name}
      </div>
      {row("Position", "position", props.position)}
      {row("Rotation (°)", "rotationDeg", props.rotationDeg)}
      {row("Scale", "scale", props.scale)}
      {props.focalLengthMm !== undefined ? (
        <label className="block text-xs text-muted">
          Focal length (mm)
          <input
            type="number"
            min={8}
            max={200}
            step="1"
            className="mt-1 w-full"
            data-testid={`${testId}-focal`}
            defaultValue={fmt(props.focalLengthMm)}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n > 0 && n !== props.focalLengthMm)
                props.onChange({ focalLengthMm: n });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </label>
      ) : null}
      {props.extra}
    </div>
  );
}

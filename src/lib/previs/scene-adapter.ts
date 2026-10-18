import * as THREE from "three";
import { assetIdFromToken, assetTokenFor, PRISM_USER_DATA } from "@/domain/previs/document";
import { focalLengthToFovDegrees, productionRenderSpec } from "@/domain/previs/camera";
import type { CameraBookmarkValue, PrevisCamera, Vec3 } from "@/domain/previs/types";
import { addObject } from "@/vendor/artcraft-scene-engine/actions/addObject";
import { addShape } from "@/vendor/artcraft-scene-engine/actions/addShape";
import { deleteObject } from "@/vendor/artcraft-scene-engine/actions/deleteObject";
import { selectObject, deselectObject } from "@/vendor/artcraft-scene-engine/actions/selectObject";
import { setCameraAspect } from "@/vendor/artcraft-scene-engine/actions/setCameraAspect";
import { setTransformMode } from "@/vendor/artcraft-scene-engine/actions/setTransformMode";
import { beginTransformSession } from "@/vendor/artcraft-scene-engine/actions/transformObject";
import { CameraAspectRatio } from "@/vendor/artcraft-scene-engine/enums";
import Editor from "@/vendor/artcraft-scene-engine/engine/editor";
import {
  OutlinerRefreshedEvent,
  SelectionChangedEvent,
} from "@/vendor/artcraft-scene-engine/engine/events/EngineEvent";
import { usePageSceneStore, type TransformMode } from "@/vendor/artcraft-scene-engine/PageSceneStore";
import type { PageSceneAdapter } from "@/vendor/artcraft-scene-engine/adapter";
import { BlockingOverlay } from "./blocking-overlay";
import { registerPrevisShapes } from "./shapes";

/**
 * The ONLY module that talks to the vendored ArtCraft-derived engine. Routes and components depend on the
 * `SpatialSceneAdapter` interface, never on engine internals, so the engine can be replaced or upgraded behind it.
 */

export type PrimitiveKind = "Box" | "Plane" | "Cylinder" | "Cone" | "Sphere";

export interface SceneObjectView {
  id: string;
  name: string;
  kind: "primitive" | "mannequin" | "glb" | "light";
  shape: string | null;
  assetId: string | null;
  characterId: string | null;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  visible: boolean;
  locked: boolean;
}

export interface CapturedFrame {
  blob: Blob;
  width: number;
  height: number;
}

export interface SpatialSceneAdapter {
  mount(targets: MountTargets, engineScene: object | null): Promise<void>;
  /** Replace the live scene with a serialised engine scene (clears undo). */
  loadScene(engineScene: object): Promise<void>;
  serializeScene(): Record<string, unknown>;
  listObjects(): SceneObjectView[];
  selectedId(): string | null;
  addPrimitive(kind: PrimitiveKind): Promise<string | undefined>;
  addMannequin(characterId: string | null, label?: string): Promise<string | undefined>;
  addGlb(assetId: string, name: string, checksum: string | null): Promise<string | undefined>;
  removeObject(id: string): void;
  select(id: string | null): void;
  updateTransform(id: string, change: Partial<{ position: Vec3; rotation: Vec3; scale: Vec3 }>): void;
  setObjectCharacter(id: string, characterId: string | null): void;
  setTransformMode(mode: TransformMode): void;
  /** The production (render) camera, NOT the editor navigation camera. */
  getProductionCamera(): PrevisCamera | null;
  setProductionCamera(camera: PrevisCamera): void;
  lookThroughProductionCamera(on: boolean): void;
  isLookingThroughProductionCamera(): boolean;
  /**
   * Renders the Production Frame through an isolated camera built from the frozen bookmark. The editor/navigation
   * camera, its pose and the look-through state are not read and not changed.
   */
  captureMasterFrame(bookmark: CameraBookmarkValue): Promise<CapturedFrame>;
  /**
   * Plays one evaluated camera-path state onto the PRODUCTION camera (and, only while looking through it, the
   * viewport). The navigation camera is otherwise untouched. The authored camera pose is remembered so that
   * serialising the scene never records a playback pose; `restoreAuthoredCamera` puts it back.
   */
  applyCameraState(state: { position: Vec3; rotation: Vec3; focalLengthMm: number }): void;
  restoreAuthoredCamera(): void;
  /** Editor-only path line + keyframe markers on a non-production layer; null removes them. */
  setPathOverlay(overlay: PathOverlay | null): void;
  /**
   * Renders one frame through an isolated production camera built from a camera-path state. Used by the previs
   * renderer; never reads or mutates the editor/navigation camera.
   */
  renderPrevisFrame(
    state: { position: Vec3; rotation: Vec3; focalLengthMm: number },
    size: { width: number; height: number },
  ): Promise<HTMLCanvasElement | OffscreenCanvas>;
  /**
   * The selected Shot's character-blocking layer (rigged proxies + FK posing). A runtime overlay: it is never part of
   * the serialised set. It shares the editor's undo/redo, selection and gizmos.
   */
  readonly blocking: BlockingOverlay;
  undo(): Promise<void>;
  redo(): Promise<void>;
  canUndo(): boolean;
  canRedo(): boolean;
  subscribe(listener: () => void): () => void;
  getEditor(): Editor | null;
  dispose(): void;
}

export interface MountTargets {
  container: HTMLDivElement;
  editorCanvas: HTMLCanvasElement;
  camViewCanvas: HTMLCanvasElement;
}

export interface AdapterOptions {
  /** `/api/assets/<id>`-style resolver; the URL is used for the load only and is never persisted. */
  resolveAssetUrl: (assetId: string) => string;
  fetchImpl?: typeof fetch;
}

const PRODUCTION_ASPECT = CameraAspectRatio.HORIZONTAL_2_39_1;
const SCENE_META = { positivePrompt: "", cameraAspectRatio: PRODUCTION_ASPECT };
const toVec = (v: { x: number; y: number; z: number }): Vec3 => ({ x: v.x, y: v.y, z: v.z });

/** Editor-only visualisation of a camera path (never rendered into master frames or previs). */
export interface PathOverlay {
  line: Vec3[];
  keys: Array<{ position: Vec3; selected: boolean; role: "start" | "end" | "mid" }>;
  current: Vec3 | null;
}

/** Overlay objects live on layer 1 only: the viewport sees layers 0 and 1, the production render camera only 0. */
const EDITOR_ONLY_LAYER = 1;
const OVERLAY_NAME = "::PRISM_PATH_OVERLAY::";

export class ArtCraftSceneAdapter implements SpatialSceneAdapter {
  private editor: Editor | null = null;
  private listeners = new Set<() => void>();
  private unsubscribers: Array<() => void> = [];
  private disposed = false;
  private authoredCamera: { position: Vec3; rotation: Vec3; focalLengthMm: number } | null = null;
  private overlay: THREE.Group | null = null;
  private notifyQueued = false;
  readonly blocking: BlockingOverlay;

  constructor(private readonly options: AdapterOptions) {
    this.blocking = new BlockingOverlay(
      () => this.editor,
      () => this.notify(),
    );
  }

  private engineAdapter(): PageSceneAdapter {
    const doFetch = this.options.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    return {
      fetchAsset: (url, init) => doFetch(url, { signal: init?.signal, credentials: "same-origin" }),
      getMediaUrlByToken: async (token) => {
        const assetId = assetIdFromToken(token);
        if (!assetId) throw new Error("Unsupported asset token");
        return this.options.resolveAssetUrl(assetId);
      },
      // Persistence is owned by Prism (server actions); the engine never saves on its own.
      saveScene: async () => {
        throw new Error("The engine does not persist scenes; Prism does.");
      },
      loadScene: async () => {
        throw new Error("The engine does not load scenes by token; Prism passes the scene JSON.");
      },
    };
  }

  private notify = () => {
    for (const l of this.listeners) l();
  };

  /**
   * Store updates caused by camera playback arrive on every frame; those are coalesced to one notification per
   * animation frame. Everything else (inspector edits, selection) notifies synchronously, as in M1.
   */
  private notifyFromStore = () => {
    if (!this.authoredCamera) return this.notify();
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    const run = () => {
      this.notifyQueued = false;
      this.notify();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else queueMicrotask(run);
  };

  async mount(targets: MountTargets, engineScene: object | null): Promise<void> {
    registerPrevisShapes();
    const store = usePageSceneStore.getState();
    // The engine store is a module singleton; start every mount from a clean scene state.
    store.resetScene();
    store.set3DPageMounted(true);
    store.setCameraAspectRatio(PRODUCTION_ASPECT);

    const editor = new Editor(this.engineAdapter());
    editor.initialize({
      sceneToken: "",
      sceneContainerEl: targets.container,
      editorCanvasEl: targets.editorCanvas,
      camViewCanvasEl: targets.camViewCanvas,
      cacheJsonString: engineScene ? JSON.stringify(engineScene) : "",
    });
    this.editor = editor;
    setCameraAspect(editor, PRODUCTION_ASPECT);
    if (!engineScene) this.applyDefaultProductionCamera();

    this.unsubscribers.push(
      editor.bus.subscribe(OutlinerRefreshedEvent, this.notify),
      editor.bus.subscribe(SelectionChangedEvent, this.notify),
      usePageSceneStore.subscribe(this.notifyFromStore),
    );
    if (this.disposed) this.dispose();
  }

  getEditor() {
    return this.editor;
  }

  private requireEditor(): Editor {
    if (!this.editor) throw new Error("The 3D set is not mounted.");
    return this.editor;
  }

  /** A fresh set starts with CAM-A on a 35 mm lens, framed on the origin, instead of the engine demo camera. */
  private applyDefaultProductionCamera() {
    this.setProductionCamera({
      id: usePageSceneStore.getState().cameras.find((c) => c.id !== "main")?.id ?? "cam-a",
      label: "CAM-A",
      position: { x: 0, y: 1.6, z: 6 },
      rotation: { x: 0, y: 0, z: 0 },
      focalLengthMm: 35,
    });
  }

  async loadScene(engineScene: object) {
    const editor = this.requireEditor();
    await editor.applyJson(JSON.stringify(engineScene));
    setCameraAspect(editor, PRODUCTION_ASPECT);
    // loading replaces every scene child; the Shot's blocking overlay is not part of the loaded set
    this.blocking.reattachAll();
    this.notify();
  }

  serializeScene() {
    const editor = this.requireEditor();
    // while a path is being played the live production camera is a playback pose, not authored truth
    const live = this.authoredCamera ? this.readCamera() : null;
    if (this.authoredCamera) this.writeCamera(this.authoredCamera);
    try {
      return JSON.parse(
        JSON.stringify(editor.save_manager.getSceneJson({ sceneGenerationMetadata: SCENE_META })),
      ) as Record<string, unknown>;
    } finally {
      if (live) this.writeCamera(live);
    }
  }

  private readCamera(): { position: Vec3; rotation: Vec3; focalLengthMm: number } | null {
    const cc = this.editor?.cameraController;
    const cfg = usePageSceneStore.getState().cameras.find((c) => c.id !== "main");
    if (!cc || !cc.cam_obj || !cfg) return null;
    const pose = cc.camera_person_mode && cc.camera ? cc.camera : cc.cam_obj;
    return {
      position: toVec(pose.position),
      rotation: { x: pose.rotation.x, y: pose.rotation.y, z: pose.rotation.z },
      focalLengthMm: cfg.focalLength,
    };
  }

  private writeCamera(c: { position: Vec3; rotation: Vec3; focalLengthMm: number }) {
    const cc = this.editor?.cameraController;
    const store = usePageSceneStore.getState();
    const cfg = store.cameras.find((x) => x.id !== "main");
    if (!cc || !cc.cam_obj || !cfg) return;
    // while looking through the camera the viewport camera IS the production pose (the tick mirrors it back)
    const targets = [cc.cam_obj, ...(cc.camera_person_mode && cc.camera ? [cc.camera] : [])];
    for (const t of targets) {
      t.position.set(c.position.x, c.position.y, c.position.z);
      t.rotation.set(c.rotation.x, c.rotation.y, c.rotation.z);
      t.updateMatrixWorld(true);
    }
    store.updateCamera(cfg.id, {
      focalLength: c.focalLengthMm,
      position: toVec(c.position),
      rotation: toVec(c.rotation),
    });
  }

  applyCameraState(state: { position: Vec3; rotation: Vec3; focalLengthMm: number }) {
    this.requireEditor();
    if (!this.authoredCamera) this.authoredCamera = this.readCamera();
    this.writeCamera(state);
  }

  restoreAuthoredCamera() {
    if (!this.authoredCamera || !this.editor) return;
    const base = this.authoredCamera;
    this.authoredCamera = null;
    this.writeCamera(base);
    this.notify();
  }

  setPathOverlay(overlay: PathOverlay | null) {
    const editor = this.editor;
    if (!editor) return;
    const scene = editor.activeScene.scene;
    if (this.overlay) {
      scene.remove(this.overlay);
      this.overlay.traverse((o) => {
        const m = o as THREE.Mesh | THREE.Line;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
      this.overlay = null;
    }
    if (!overlay) return;
    const group = new THREE.Group();
    group.name = OVERLAY_NAME;
    group.userData.prismEditorOnly = true; // no media_id: never serialised, listed or fingerprinted
    const mark = (o: THREE.Object3D) => {
      o.layers.set(EDITOR_ONLY_LAYER);
      o.raycast = () => undefined; // not pickable
    };
    if (overlay.line.length >= 2) {
      const geo = new THREE.BufferGeometry().setFromPoints(
        overlay.line.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
      );
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xf2b84b }));
      mark(line);
      group.add(line);
    }
    const colour = { start: 0x4ade80, end: 0xf87171, mid: 0xf2b84b } as const;
    for (const k of overlay.keys) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(k.selected ? 0.12 : 0.08, 12, 8),
        new THREE.MeshBasicMaterial({ color: k.selected ? 0xffffff : colour[k.role] }),
      );
      m.position.set(k.position.x, k.position.y, k.position.z);
      mark(m);
      group.add(m);
    }
    if (overlay.current) {
      const c = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0x60a5fa }),
      );
      c.position.set(overlay.current.x, overlay.current.y, overlay.current.z);
      mark(c);
      group.add(c);
    }
    mark(group);
    scene.add(group);
    this.overlay = group;
  }

  async renderPrevisFrame(
    state: { position: Vec3; rotation: Vec3; focalLengthMm: number },
    size: { width: number; height: number },
  ) {
    const editor = this.requireEditor();
    const renderer = editor.renderer;
    if (!renderer) throw new Error("The 3D set is not ready to render.");
    // an isolated camera at the previs resolution, rendered straight to a canvas copy (the viewport is untouched)
    const cam = new THREE.PerspectiveCamera(
      focalLengthToFovDegrees(state.focalLengthMm),
      size.width / size.height,
      0.05,
      2000,
    );
    cam.position.set(state.position.x, state.position.y, state.position.z);
    cam.rotation.set(state.rotation.x, state.rotation.y, state.rotation.z, "XYZ");
    cam.layers.disable(EDITOR_ONLY_LAYER);
    cam.updateMatrixWorld(true);
    const snap = await this.blocking.cleanRender(() => editor.snapShotOfCurrentFrame(false, cam, size));
    if (!snap) throw new Error("The 3D set could not render a frame.");
    const bitmap = await createImageBitmap(snap.file);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("A 2D canvas is not available.");
    g.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    return canvas;
  }

  private sceneObjects(): THREE.Object3D[] {
    const editor = this.editor;
    if (!editor) return [];
    return editor.activeScene.scene.children.filter(
      (c) =>
        c.userData?.media_id !== undefined &&
        c.name !== "::CAM::" &&
        c.userData.media_id !== "DirectionalLight",
    );
  }

  listObjects(): SceneObjectView[] {
    return this.sceneObjects().flatMap((o) => {
      const token = String(o.userData.media_id ?? "");
      if (token.startsWith("Point::") || token.startsWith("Image::")) return [];
      const assetId = assetIdFromToken(token);
      const shape = token === "Parim" ? String(o.userData.shapeKey ?? o.userData.shapeType ?? o.name) : null;
      const kind: SceneObjectView["kind"] = assetId
        ? "glb"
        : shape === "Mannequin"
          ? "mannequin"
          : shape === "PointLight"
            ? "light"
            : "primitive";
      return [
        {
          id: o.uuid,
          name: o.name,
          kind,
          shape,
          assetId,
          characterId: (o.userData[PRISM_USER_DATA.characterId] as string | undefined) ?? null,
          position: toVec(o.position),
          rotation: toVec({ x: o.rotation.x, y: o.rotation.y, z: o.rotation.z }),
          scale: toVec(o.scale),
          visible: o.visible,
          locked: o.userData.locked === true,
        },
      ];
    });
  }

  selectedId() {
    return this.editor?.sceneManager?.selected_objects?.[0]?.uuid ?? null;
  }

  async addPrimitive(kind: PrimitiveKind) {
    const editor = this.requireEditor();
    const id = await addShape(editor, { media_id: kind, name: kind === "Box" ? "Cube" : kind });
    if (id) selectObject(editor, id);
    this.notify();
    return id;
  }

  async addMannequin(characterId: string | null, label = "Mannequin") {
    const editor = this.requireEditor();
    const id = await addShape(editor, { media_id: "Mannequin", name: label });
    if (id && characterId) this.setObjectCharacter(id, characterId);
    if (id) selectObject(editor, id);
    this.notify();
    return id;
  }

  async addGlb(assetId: string, name: string, checksum: string | null) {
    const editor = this.requireEditor();
    const id = await addObject(editor, { media_id: assetTokenFor(assetId), name });
    if (id) {
      const obj = editor.activeScene.scene.getObjectByProperty("uuid", id);
      if (obj) obj.userData[PRISM_USER_DATA.assetChecksum] = checksum;
      selectObject(editor, id);
    }
    this.notify();
    return id;
  }

  removeObject(id: string) {
    deleteObject(this.requireEditor(), id);
    this.notify();
  }

  select(id: string | null) {
    const editor = this.requireEditor();
    if (id) selectObject(editor, id);
    else deselectObject(editor);
    this.notify();
  }

  updateTransform(id: string, change: Partial<{ position: Vec3; rotation: Vec3; scale: Vec3 }>) {
    const editor = this.requireEditor();
    const obj = editor.activeScene.scene.getObjectByProperty("uuid", id);
    if (!obj) return;
    // one undoable edit per call (same mechanism as the engine's own object panel)
    const session = beginTransformSession(editor, id);
    if (change.position) obj.position.set(change.position.x, change.position.y, change.position.z);
    if (change.rotation) obj.rotation.set(change.rotation.x, change.rotation.y, change.rotation.z);
    if (change.scale) obj.scale.set(change.scale.x, change.scale.y, change.scale.z);
    obj.updateMatrixWorld(true);
    session.commit();
    this.notify();
  }

  setObjectCharacter(id: string, characterId: string | null) {
    const obj = this.requireEditor().activeScene.scene.getObjectByProperty("uuid", id);
    if (!obj) return;
    if (characterId) obj.userData[PRISM_USER_DATA.characterId] = characterId;
    else delete obj.userData[PRISM_USER_DATA.characterId];
    this.notify();
  }

  setTransformMode(mode: TransformMode) {
    setTransformMode(this.requireEditor(), mode);
    this.notify();
  }

  getProductionCamera(): PrevisCamera | null {
    const editor = this.editor;
    if (!editor) return null;
    const cam = editor.cameraController.cam_obj;
    const cfg = usePageSceneStore.getState().cameras.find((c) => c.id !== "main");
    if (!cam || !cfg) return null;
    // while looking through the camera the viewport camera IS the production pose
    const pose =
      editor.cameraController.camera_person_mode && editor.cameraController.camera
        ? editor.cameraController.camera
        : cam;
    return {
      id: cfg.id,
      label: cfg.label,
      position: toVec(pose.position),
      rotation: { x: pose.rotation.x, y: pose.rotation.y, z: pose.rotation.z },
      focalLengthMm: cfg.focalLength,
    };
  }

  setProductionCamera(camera: PrevisCamera) {
    // an explicit edit adopts the new pose as the authored camera and ends any playback override
    this.authoredCamera = null;
    const editor = this.requireEditor();
    const cc = editor.cameraController;
    const wasLooking = cc.camera_person_mode;
    if (wasLooking) cc.exitCameraView();
    const cam = cc.cam_obj;
    if (cam) {
      cam.position.set(camera.position.x, camera.position.y, camera.position.z);
      cam.rotation.set(camera.rotation.x, camera.rotation.y, camera.rotation.z);
      cam.updateMatrixWorld(true);
    }
    const store = usePageSceneStore.getState();
    const cfg = store.cameras.find((c) => c.id !== "main");
    if (cfg) {
      store.updateCamera(cfg.id, {
        label: camera.label,
        focalLength: camera.focalLengthMm,
        position: toVec(camera.position),
        rotation: toVec(camera.rotation),
      });
      // the viewport lens follows the production lens only while looking through the production camera
      store.setSelectedCameraId(wasLooking ? cfg.id : "main");
    }
    if (wasLooking) cc.enterCameraView();
    this.notify();
  }

  lookThroughProductionCamera(on: boolean) {
    const cc = this.requireEditor().cameraController;
    const cfg = usePageSceneStore.getState().cameras.find((c) => c.id !== "main");
    // the viewport lens follows the production lens only while looking through it; the navigation camera keeps its own
    if (cfg) usePageSceneStore.getState().setSelectedCameraId(on ? cfg.id : "main");
    if (on) cc.enterCameraView();
    else cc.exitCameraView();
    this.notify();
  }

  isLookingThroughProductionCamera() {
    return this.editor?.cameraController.camera_person_mode === true;
  }

  async captureMasterFrame(bookmark: CameraBookmarkValue): Promise<CapturedFrame> {
    const editor = this.requireEditor();
    const spec = productionRenderSpec(bookmark);
    const dims = editor.cameraController.getRenderDimensions();
    if (dims.width !== spec.width || dims.height !== spec.height) {
      throw new Error(`The set is not framed at the Production Frame (${dims.width}×${dims.height}).`);
    }
    // a dedicated camera: the viewport/navigation camera is never the source of the capture
    const cam = new THREE.PerspectiveCamera(spec.fovVerticalDegrees, spec.aspect, spec.near, spec.far);
    cam.position.set(spec.position.x, spec.position.y, spec.position.z);
    cam.rotation.set(spec.rotation.x, spec.rotation.y, spec.rotation.z, "XYZ");
    cam.layers.disable(1); // the camera proxy lives on layer 1, as in the engine's own render camera
    cam.updateMatrixWorld(true);
    const snap = await this.blocking.cleanRender(() => editor.snapShotOfCurrentFrame(false, cam));
    if (!snap) throw new Error("The 3D set could not render a frame.");
    return { blob: snap.file, width: spec.width, height: spec.height };
  }

  async undo() {
    await this.requireEditor().history.undo();
    this.notify();
  }
  async redo() {
    await this.requireEditor().history.redo();
    this.notify();
  }
  canUndo() {
    return this.editor?.history.canUndo() ?? false;
  }
  canRedo() {
    return this.editor?.history.canRedo() ?? false;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose() {
    this.disposed = true;
    for (const u of this.unsubscribers.splice(0)) u();
    this.setPathOverlay(null);
    this.blocking.dispose();
    this.authoredCamera = null;
    this.listeners.clear();
    const editor = this.editor;
    this.editor = null;
    if (editor) editor.unmountEngine();
    usePageSceneStore.getState().set3DPageMounted(false);
  }
}

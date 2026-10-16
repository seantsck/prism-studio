import * as THREE from "three";
import { assetIdFromToken, assetTokenFor, PRISM_USER_DATA } from "@/domain/previs/document";
import { productionRenderSpec } from "@/domain/previs/camera";
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

export class ArtCraftSceneAdapter implements SpatialSceneAdapter {
  private editor: Editor | null = null;
  private listeners = new Set<() => void>();
  private unsubscribers: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly options: AdapterOptions) {}

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
      usePageSceneStore.subscribe(this.notify),
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
    this.notify();
  }

  serializeScene() {
    const editor = this.requireEditor();
    return JSON.parse(
      JSON.stringify(editor.save_manager.getSceneJson({ sceneGenerationMetadata: SCENE_META })),
    ) as Record<string, unknown>;
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
      store.setSelectedCameraId(cfg.id);
    }
    if (wasLooking) cc.enterCameraView();
    this.notify();
  }

  lookThroughProductionCamera(on: boolean) {
    const cc = this.requireEditor().cameraController;
    const cfg = usePageSceneStore.getState().cameras.find((c) => c.id !== "main");
    if (cfg) usePageSceneStore.getState().setSelectedCameraId(cfg.id); // viewport FOV follows the production lens
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
    const snap = editor.snapShotOfCurrentFrame(false, cam);
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
    this.listeners.clear();
    const editor = this.editor;
    this.editor = null;
    if (editor) editor.unmountEngine();
    usePageSceneStore.getState().set3DPageMounted(false);
  }
}

import * as THREE from "three";
import type { SpatialSceneAdapter } from "./scene-adapter";

/**
 * Read/steer helpers for browser acceptance tests only. Installed solely when the page is automated
 * (`navigator.webdriver`), so ordinary operators never get a global.
 */
export interface PrevisTestHook {
  /** Client-space (CSS px) position of a point `offsetWorld` away from the object's origin. */
  project(id: string, offsetWorld?: { x: number; y: number; z: number }): { x: number; y: number } | null;
  navigationCamera(): { position: number[]; rotation: number[]; fov: number } | null;
  /** The live production camera (position, Euler rotation, focal length), never the navigation camera. */
  productionCamera(): { position: number[]; rotation: number[]; focalLengthMm: number } | null;
  /** True when the editor-only camera-path overlay is in the scene (and visible to the editor camera only). */
  overlay(): { present: boolean; onEditorLayerOnly: boolean };
  /** Move the editor/navigation camera somewhere else (test-only). */
  setNavigationCamera(position: number[], lookAt: number[]): void;
  /** Client-space position of a character proxy's root (plus an offset in world metres), or null. */
  projectFigure(
    characterId: string,
    offset?: { x: number; y: number; z: number },
  ): { x: number; y: number } | null;
  /** Client-space position of one of a proxy's joints. */
  projectJoint(characterId: string, joint: string): { x: number; y: number } | null;
  /** World position and local quaternion of a proxy's joint. */
  jointState(characterId: string, joint: string): { world: number[]; quaternion: number[] } | null;
  /** What the blocking overlay currently holds, and whether any editor helper could leak into a render. */
  blockingInfo(): {
    proxyCount: number;
    poseMode: boolean;
    selectedCharacter: string | null;
    selectedJoint: string | null;
    helpers: Array<{ name: string; onEditorLayerOnly: boolean }>;
    geometries: number;
    sceneProxyNames: string[];
  };
}

export function installPrevisTestHook(adapter: SpatialSceneAdapter, canvas: HTMLCanvasElement) {
  if (typeof navigator === "undefined" || !navigator.webdriver) return () => {};
  const w = window as unknown as { __prismSet?: PrevisTestHook };
  const cam = () => adapter.getEditor()?.cameraController.camera ?? null;
  w.__prismSet = {
    project(id, offset = { x: 0, y: 0, z: 0 }) {
      const c = cam();
      const o = adapter.listObjects().find((x) => x.id === id);
      if (!c || !o) return null;
      c.updateMatrixWorld(true);
      const v = new THREE.Vector3(o.position.x + offset.x, o.position.y + offset.y, o.position.z + offset.z);
      v.project(c);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    },
    overlay() {
      const g = adapter.getEditor()?.activeScene.scene.getObjectByName("::PRISM_PATH_OVERLAY::");
      if (!g) return { present: false, onEditorLayerOnly: false };
      let only = true;
      g.traverse((o) => {
        if (!o.layers.isEnabled(1) || o.layers.isEnabled(0)) only = false;
      });
      return { present: true, onEditorLayerOnly: only };
    },
    productionCamera() {
      const c = adapter.getProductionCamera();
      if (!c) return null;
      return {
        position: [c.position.x, c.position.y, c.position.z],
        rotation: [c.rotation.x, c.rotation.y, c.rotation.z],
        focalLengthMm: c.focalLengthMm,
      };
    },
    navigationCamera() {
      const c = cam();
      if (!c) return null;
      return {
        position: c.position.toArray(),
        rotation: [c.rotation.x, c.rotation.y, c.rotation.z],
        fov: c.fov,
      };
    },
    projectFigure(characterId, offset = { x: 0, y: 0, z: 0 }) {
      const c = cam();
      const f = adapter.blocking.list().find((x) => x.characterId === characterId);
      if (!c || !f) return null;
      c.updateMatrixWorld(true);
      const v = new THREE.Vector3(
        f.root.position.x + offset.x,
        f.root.position.y + offset.y,
        f.root.position.z + offset.z,
      );
      v.project(c);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    },
    projectJoint(characterId, joint) {
      const c = cam();
      const w = adapter.blocking.jointWorld(characterId, joint as never);
      if (!c || !w) return null;
      c.updateMatrixWorld(true);
      const v = new THREE.Vector3(w.x, w.y, w.z).project(c);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    },
    jointState(characterId, joint) {
      const w = adapter.blocking.jointWorld(characterId, joint as never);
      const pose = adapter.blocking.list().find((f) => f.characterId === characterId)?.pose;
      if (!w || !pose) return null;
      const q = (pose.joints as Record<string, { x: number; y: number; z: number; w: number }>)[joint] ?? {
        x: 0,
        y: 0,
        z: 0,
        w: 1,
      };
      return { world: [w.x, w.y, w.z], quaternion: [q.x, q.y, q.z, q.w] };
    },
    blockingInfo() {
      const editor = adapter.getEditor();
      const scene = editor?.activeScene.scene;
      const helpers: Array<{ name: string; onEditorLayerOnly: boolean }> = [];
      const names: string[] = [];
      scene?.traverse((o) => {
        const isHelper =
          o.name === "__FKHelperSphere__" || (o as THREE.SkeletonHelper).isSkeletonHelper === true;
        if (isHelper)
          helpers.push({
            name: o.name || o.type,
            onEditorLayerOnly: o.layers.isEnabled(1) && !o.layers.isEnabled(0),
          });
      });
      scene?.children.forEach((c) => {
        if (c.userData?.prismBlocking) names.push(c.name);
      });
      return {
        proxyCount: adapter.blocking.sceneProxyCount(),
        poseMode: adapter.blocking.poseMode(),
        selectedCharacter: adapter.blocking.selectedCharacter(),
        selectedJoint: adapter.blocking.selectedJointId(),
        helpers,
        geometries: editor?.renderer?.info.memory.geometries ?? -1,
        sceneProxyNames: names,
      };
    },
    setNavigationCamera(position, lookAt) {
      const c = cam();
      if (!c) return;
      c.position.set(position[0], position[1], position[2]);
      c.lookAt(lookAt[0], lookAt[1], lookAt[2]);
      c.updateMatrixWorld(true);
    },
  };
  return () => {
    delete w.__prismSet;
  };
}

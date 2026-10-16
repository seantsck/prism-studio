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
  /** Move the editor/navigation camera somewhere else (test-only). */
  setNavigationCamera(position: number[], lookAt: number[]): void;
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

// PRISM PATCH: hand-written declarations for the three.js-derived JS fork (upstream ships no types).
import { Camera, Object3D, Raycaster } from "three";
export class TransformControls extends Object3D {
  constructor(camera: Camera, domElement?: HTMLElement | null);
  [key: string]: any;
  camera: Camera;
  object: Object3D | undefined;
  enabled: boolean;
  dragging: boolean;
  axis: string | null;
  mode: "translate" | "rotate" | "scale";
  space: "world" | "local";
  size: number;
  showX: boolean;
  showY: boolean;
  showZ: boolean;
  attach(object: Object3D): this;
  detach(): this;
  getHelper(): Object3D;
  getRaycaster(): Raycaster;
  setMode(mode: "translate" | "rotate" | "scale"): void;
  setSpace(space: "world" | "local"): void;
  setSize(size: number): void;
  setTranslationSnap(v: number | null): void;
  setRotationSnap(v: number | null): void;
  setScaleSnap(v: number | null): void;
  dispose(): void;
}
export class TransformControlsGizmo extends Object3D {
  [key: string]: any;
}
export class TransformControlsPlane extends Object3D {
  [key: string]: any;
}

// PRISM PATCH: declarations for the upstream JS outline pass.
import { Camera, Scene } from "three";
import { Pass } from "three/addons/postprocessing/Pass.js";
export class CustomOutlinePass extends Pass {
  constructor(resolution: any, scene: Scene, camera: Camera, ...rest: any[]);
  [key: string]: any;
  fsQuad: any;
  updateMaxSurfaceId(id: number): void;
}

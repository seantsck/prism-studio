// PRISM PATCH: declarations for the upstream JS surface-id helper.
import type { Material, Mesh } from "three";
export default class FindSurfaces {
  [key: string]: any;
  constructor(...args: any[]);
  surfaceId: number;
  getSurfaceIdAttribute(mesh: Mesh): any;
}
export function getSurfaceIdMaterial(): Material;
export function getDebugSurfaceIdMaterial(): Material;

// PRISM PATCH (new file): lets the host register extra procedural shapes (Plane, Mannequin) without editing the
// engine's `Scene.instantiate` switch per shape. The host registers factories before mounting an editor.
import type * as THREE from "three";

export interface ShapeFactory {
  geometry: () => THREE.BufferGeometry;
  /** vertical offset so the shape stands on the ground plane when dropped at y = 0 */
  doubleSided?: boolean;
}

const factories = new Map<string, ShapeFactory>();
export const registerShapeFactory = (key: string, factory: ShapeFactory) => void factories.set(key, factory);
export const getShapeFactory = (key: string) => factories.get(key);

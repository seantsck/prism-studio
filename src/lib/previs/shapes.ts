import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { registerShapeFactory } from "@/vendor/artcraft-scene-engine/shims/shape-factory";

/**
 * Neutral procedural mannequin: capsule torso, sphere head, cylinder limbs, ~1.75 m tall, origin at the feet so
 * it stands on y = 0. It represents position, orientation, body scale and blocking. It is NOT visual identity:
 * a Character's identity stays in its approved Prism references.
 */
export function createMannequinGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, x: number, y: number, z = 0) => {
    g.translate(x, y, z);
    parts.push(g);
  };
  add(new THREE.CapsuleGeometry(0.17, 0.5, 4, 12), 0, 1.2); // torso
  add(new THREE.SphereGeometry(0.115, 16, 12), 0, 1.68); // head
  add(new THREE.CylinderGeometry(0.075, 0.065, 0.82, 10), -0.1, 0.41); // legs
  add(new THREE.CylinderGeometry(0.075, 0.065, 0.82, 10), 0.1, 0.41);
  add(new THREE.CylinderGeometry(0.05, 0.045, 0.62, 8), -0.225, 1.2); // arms
  add(new THREE.CylinderGeometry(0.05, 0.045, 0.62, 8), 0.225, 1.2);
  const merged = mergeGeometries(parts.map((p) => (p.index ? p : p.toNonIndexed())));
  parts.forEach((p) => p.dispose());
  merged.computeBoundingBox();
  return merged;
}

let registered = false;
/** Registers the Prism shapes the vendored engine's `instantiate` should know about. Idempotent. */
export function registerPrevisShapes(): void {
  if (registered) return;
  registered = true;
  registerShapeFactory("Plane", { geometry: () => new THREE.PlaneGeometry(1, 1), doubleSided: true });
  registerShapeFactory("Mannequin", { geometry: createMannequinGeometry });
}

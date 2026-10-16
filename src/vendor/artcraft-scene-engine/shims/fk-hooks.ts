// PRISM PATCH (new file): lets the host observe and constrain the vendored FK pose helper without editing it per
// use. The engine's FKHelper calls these hooks at its interaction boundaries; Prism registers them from outside the
// vendor tree (scene-adapter) and clears them on dispose. A module singleton, like the engine's own zustand store:
// there is exactly one 3D editor mounted at a time.
import type * as THREE from "three";

export interface FKHooks {
  /** a bone sphere was clicked (bone) or the selection was cleared (null) */
  onBoneSelected?: (bone: THREE.Object3D | null) => void;
  /** the rotate gizmo started / finished a drag on a bone */
  onBoneDragStart?: (bone: THREE.Object3D) => void;
  onBoneDragEnd?: (bone: THREE.Object3D) => void;
  /** called for every change while dragging, BEFORE listeners see it, so the host can clamp the rotation */
  constrainBone?: (bone: THREE.Object3D) => void;
  /** after constrain: the bone's rotation moved */
  onBoneChange?: (bone: THREE.Object3D) => void;
}

export const fkHooks: FKHooks = {};
export const setFKHooks = (hooks: FKHooks) => {
  for (const k of Object.keys(fkHooks)) delete (fkHooks as Record<string, unknown>)[k];
  Object.assign(fkHooks, hooks);
};
export const clearFKHooks = () => setFKHooks({});

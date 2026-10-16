// @ts-nocheck PRISM PATCH: upstream was compiled against looser three typings; behaviour is unchanged.
// Owns the main EffectComposer chain.
//
// Main composer:
//   SelectionOutlinePass -> OutputPass
//
//   SelectionOutlinePass internally branches on selection state — no
//   selection takes a single forward render path, a non-splat selection
//   does a two-pass scene-minus-selected + selected-only render and
//   composites them with a silhouette outline, and a splat selection
//   falls back to the single render path with an attached BoxHelper.
//   See SelectionOutlinePass for the full pipeline notes.
//
// PRISM PATCH: upstream also built a "raw" composer
// (RenderPass -> CustomOutlinePass -> OutputPass) for its video-output look and
// gated renderScene() on it. Prism M1 never renders through it (master frames go
// through the main composer with an isolated production camera), so the raw
// composer, CustomOutlinePass.js and FindSurfaces.js are not vendored.
//
// Deliberately small surface — no `editor` reference, no circular import.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { SelectionOutlinePass } from "../SelectionOutlinePass";

export class PostProcessingPipeline {
  composer: EffectComposer | undefined;
  // Set by MouseControls / SceneUtils on every selection change.
  // The pass partitions the array into splat vs. non-splat at render time.
  selectionPass: SelectionOutlinePass | undefined;

  configureMain(
    renderer: THREE.WebGLRenderer | undefined,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera | null,
    width: number,
    height: number,
  ) {
    if (renderer == undefined || camera == undefined) return;
    this.composer = new EffectComposer(renderer);

    this.selectionPass = new SelectionOutlinePass(scene, camera, width, height);
    this.composer.addPass(this.selectionPass);

    this.composer.addPass(new OutputPass());
  }

  // Resize the composer — called from ViewportController via the
  // resizePostProcessing callback.
  resize(width: number, height: number) {
    this.composer?.setSize(width, height);
  }

  dispose() {
    this.composer?.dispose();
    this.selectionPass?.dispose();
  }

  // Bound through Editor's Scene callback; called on each asset load.
  // PRISM PATCH: the surface-id traversal belonged to the removed raw
  // composer; the callback contract is kept as a no-op.
  updateSurfaceIdAttributeToMesh(_scene: THREE.Scene) {}
}

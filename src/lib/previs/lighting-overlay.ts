import * as THREE from "three";
import { lightingFingerprint, type ShotLight, type ShotLightingDraft } from "@/domain/previs/lighting";
import type Editor from "@/vendor/artcraft-scene-engine/engine/editor";

/**
 * The selected Shot's lighting as a runtime overlay on the Set. Like the blocking overlay, its objects carry no
 * `media_id`, so the engine's save filter skips them: Shot lighting can never reach the scene document or fingerprint.
 *
 * Real lights stay on layer 0, which production cameras render. Editor markers live on layer 1, which production cameras
 * disable, so a marker can never appear in a Master Frame or previs. Control passes hide this group like any other
 * non-geometry child, and their unlit override materials ignore lights anyway.
 */

const OVERLAY_NAME = "::PRISM_SHOT_LIGHTING::";
const EDITOR_ONLY_LAYER = 1;
/** Three.js' physically based inverse-square falloff; not authored in v1. */
const DECAY = 2;
const DEG = Math.PI / 180;

type BaseLight = THREE.HemisphereLight | THREE.DirectionalLight | THREE.AmbientLight;

export class LightingOverlay {
  private group: THREE.Group | null = null;
  private rig: ShotLightingDraft | null = null;
  /** engine base light -> the visibility it had before this overlay suppressed it */
  private suppressed = new Map<BaseLight, boolean>();

  constructor(
    private readonly editorOf: () => Editor | null,
    private readonly notify: () => void,
  ) {}

  /** Applies the Shot's rig, or removes all Shot lighting and restores the engine's base lights when null. */
  setRig(rig: ShotLightingDraft | null) {
    this.rig = rig;
    this.removeGroup();
    this.restoreBase();
    if (rig) this.apply(rig);
    this.notify();
  }

  /** The fingerprint of what is applied right now; null = no Shot lighting. A capture claims exactly this. */
  appliedFingerprint(): string | null {
    return this.rig ? lightingFingerprint(this.rig) : null;
  }

  /** A scene load removes every scene child: put the Shot's lighting back, exactly once. */
  reattach() {
    const rig = this.rig;
    this.removeGroup();
    // A load only rebuilds the base lights when the saved JSON carries the engine's DirectionalLight; otherwise (or when
    // a superseded load stops early) the engine keeps and re-adds the SAME light objects, still hidden by this overlay.
    // Give back what was suppressed first: harmless on a discarded light, and on a kept one it stops `replace` from
    // recording its own suppression as the state to restore, which would leave the base dark for every other Shot.
    this.restoreBase();
    if (rig) this.apply(rig);
  }

  /**
   * Runs `fn` with the engine's base lights exactly as the engine left them. The base directional light is saved in the
   * scene JSON along with its visibility, so a save must never observe this overlay's suppression.
   */
  withBaseRestored<T>(fn: () => T): T {
    const held = this.suppressed.size > 0;
    if (held) for (const [light, visible] of this.suppressed) light.visible = visible;
    try {
      return fn();
    } finally {
      if (held) for (const light of this.suppressed.keys()) light.visible = false;
    }
  }

  dispose() {
    this.rig = null;
    this.removeGroup();
    this.restoreBase();
  }

  /** Test support: lights and markers the overlay holds, and the state of the engine's base lights. */
  inspect() {
    const lights: Array<{ type: string; layer0: boolean }> = [];
    const helpers: Array<{ onEditorLayerOnly: boolean }> = [];
    this.group?.traverse((o) => {
      if ((o as THREE.Light).isLight) lights.push({ type: o.type, layer0: o.layers.isEnabled(0) });
      else if ((o as THREE.Mesh).isMesh)
        helpers.push({ onEditorLayerOnly: o.layers.isEnabled(EDITOR_ONLY_LAYER) && !o.layers.isEnabled(0) });
    });
    return {
      lights,
      helpers,
      baseSuppressed: this.suppressed.size > 0,
      baseVisible: this.baseLights().map((l) => l.visible),
    };
  }

  private scene() {
    return this.editorOf()?.activeScene ?? null;
  }

  /**
   * The engine's base rig, identified by its own fields and by type rather than by any name. Authored Location lights
   * are PointLights parented under a `media_id` object, so they are never in this list. A scene load creates new base
   * lights, and the ambient light is only in the scene on some skybox branches, so both routes are checked.
   */
  private baseLights(): BaseLight[] {
    const active = this.scene();
    if (!active) return [];
    const out = new Set<BaseLight>();
    for (const l of [active.hemisphereLight, active.directional_light, active.ambientLight])
      if (l) out.add(l);
    for (const c of active.scene.children) {
      const l = c as THREE.Light & { isHemisphereLight?: boolean; isDirectionalLight?: boolean };
      if (l.isHemisphereLight || l.isDirectionalLight || (l as THREE.AmbientLight).isAmbientLight)
        out.add(c as BaseLight);
    }
    return [...out];
  }

  private restoreBase() {
    for (const [light, visible] of this.suppressed) light.visible = visible;
    this.suppressed.clear();
  }

  private removeGroup() {
    const g = this.group;
    if (!g) return;
    g.parent?.remove(g);
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
      (o as THREE.Light).dispose?.();
    });
    this.group = null;
  }

  private apply(rig: ShotLightingDraft) {
    const active = this.scene();
    if (!active) return;
    if (rig.base.mode === "replace")
      for (const l of this.baseLights()) {
        this.suppressed.set(l, l.visible);
        l.visible = false;
      }
    const group = new THREE.Group();
    group.name = OVERLAY_NAME;
    for (const l of rig.lights) {
      // a disabled light stays in the document but lights nothing, and shows no marker
      if (!l.enabled) continue;
      group.add(...this.build(l));
    }
    active.scene.add(group);
    group.updateMatrixWorld(true);
    this.group = group;
  }

  private build(l: ShotLight): THREE.Object3D[] {
    const colour = new THREE.Color(l.color);
    if (l.type === "ambient") return [new THREE.AmbientLight(colour, l.intensity)];
    const objects: THREE.Object3D[] = [];
    let light: THREE.Light;
    if (l.type === "point") {
      light = new THREE.PointLight(colour, l.intensity, l.range, DECAY);
    } else if (l.type === "directional") {
      const d = new THREE.DirectionalLight(colour, l.intensity);
      d.target.position.set(l.target.x, l.target.y, l.target.z);
      objects.push(d.target);
      light = d;
    } else {
      const s = new THREE.SpotLight(colour, l.intensity, l.range, l.coneAngleDeg * DEG, l.penumbra, DECAY);
      s.target.position.set(l.target.x, l.target.y, l.target.z);
      objects.push(s.target);
      light = s;
    }
    light.castShadow = false;
    light.position.set(l.position.x, l.position.y, l.position.z);
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 10, 8),
      new THREE.MeshBasicMaterial({ color: colour }),
    );
    marker.position.copy(light.position);
    marker.layers.set(EDITOR_ONLY_LAYER);
    marker.raycast = () => undefined; // not pickable
    objects.push(light, marker);
    return objects;
  }
}

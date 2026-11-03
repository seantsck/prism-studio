import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { SHOT_LIGHTING_SCHEMA, lightingFingerprint, newShotLight } from "@/domain/previs/lighting";
import type Editor from "@/vendor/artcraft-scene-engine/engine/editor";
import { LightingOverlay } from "../lighting-overlay";

/** A stand-in for the engine's scene: the same base-light fields, and a real THREE scene. */
function engine() {
  const scene = new THREE.Scene();
  const makeBase = () => {
    const hemisphereLight = new THREE.HemisphereLight();
    const directional_light = new THREE.DirectionalLight();
    directional_light.userData.media_id = "DirectionalLight";
    scene.add(hemisphereLight, directional_light);
    return { hemisphereLight, directional_light };
  };
  // the ambient light exists but is only in the scene on some skybox branches
  const active = { scene, ambientLight: new THREE.AmbientLight(), ...makeBase() };
  // an authored Location light: a PointLight under a media_id object
  const authored = new THREE.Object3D();
  authored.userData.media_id = "Parim";
  const authoredLight = new THREE.PointLight();
  authored.add(authoredLight);
  scene.add(authored);
  const overlay = new LightingOverlay(
    () => ({ activeScene: active }) as unknown as Editor,
    () => undefined,
  );
  return { scene, active, overlay, authoredLight, makeBase };
}

const rig = (mode: "engine_default" | "replace", lights = [newShotLight("spot", "s")]) => ({
  schema: SHOT_LIGHTING_SCHEMA,
  base: { mode },
  lights,
});

const baseVisibility = (a: ReturnType<typeof engine>["active"]) => [
  a.hemisphereLight.visible,
  a.directional_light.visible,
  a.ambientLight.visible,
];

describe("LightingOverlay", () => {
  it("engine_default keeps the base and adds the Shot's lights", () => {
    const e = engine();
    e.overlay.setRig(rig("engine_default"));
    expect(baseVisibility(e.active)).toEqual([true, true, true]);
    expect(e.overlay.inspect().lights).toEqual([{ type: "SpotLight", layer0: true }]);
    expect(e.overlay.appliedFingerprint()).toBe(lightingFingerprint(rig("engine_default")));
  });

  it("replace suppresses the base rig, including the detached ambient, and spares authored lights", () => {
    const e = engine();
    e.overlay.setRig(rig("replace"));
    expect(baseVisibility(e.active)).toEqual([false, false, false]);
    expect(e.authoredLight.visible).toBe(true);
  });

  it("restores the exact prior state, not a default", () => {
    const e = engine();
    e.active.directional_light.visible = false; // the engine's own state, not ours
    e.overlay.setRig(rig("replace"));
    e.overlay.setRig(null);
    expect(baseVisibility(e.active)).toEqual([true, false, true]);
    expect(e.overlay.appliedFingerprint()).toBeNull();
    expect(e.overlay.inspect().lights).toEqual([]);
  });

  it("switching rigs does not record its own suppression as the state to restore", () => {
    const e = engine();
    e.overlay.setRig(rig("replace"));
    e.overlay.setRig(rig("replace", []));
    e.overlay.setRig(null);
    expect(baseVisibility(e.active)).toEqual([true, true, true]);
  });

  it("serialising sees the engine's base, on success and when the save throws", () => {
    const e = engine();
    e.overlay.setRig(rig("replace"));
    const seen = e.overlay.withBaseRestored(() => baseVisibility(e.active));
    expect(seen).toEqual([true, true, true]);
    expect(baseVisibility(e.active)).toEqual([false, false, false]);
    const boom = vi.fn(() => {
      expect(baseVisibility(e.active)).toEqual([true, true, true]);
      throw new Error("save failed");
    });
    expect(() => e.overlay.withBaseRestored(boom)).toThrow("save failed");
    expect(baseVisibility(e.active)).toEqual([false, false, false]);
    e.overlay.setRig(null);
    expect(baseVisibility(e.active)).toEqual([true, true, true]);
  });

  it("re-applies to the new base lights after a scene load", () => {
    const e = engine();
    e.overlay.setRig(rig("replace"));
    e.scene.clear();
    Object.assign(e.active, e.makeBase());
    e.overlay.reattach();
    expect(e.active.hemisphereLight.visible).toBe(false);
    expect(e.active.directional_light.visible).toBe(false);
    expect(e.scene.getObjectByName("::PRISM_SHOT_LIGHTING::")).toBeDefined();
    e.overlay.setRig(null);
    expect(e.active.hemisphereLight.visible).toBe(true);
    expect(e.active.directional_light.visible).toBe(true);
  });

  it("a load that keeps the same base lights does not leave them dark for the next Shot", () => {
    const e = engine();
    e.overlay.setRig(rig("replace"));
    // a saved scene without the engine's DirectionalLight: the children go, the very same base objects come back
    const kept = [e.active.hemisphereLight, e.active.directional_light];
    e.scene.clear();
    e.scene.add(...kept);
    e.overlay.reattach();
    expect(baseVisibility(e.active)).toEqual([false, false, false]);
    // Shot B has no rig
    e.overlay.setRig(null);
    expect(baseVisibility(e.active)).toEqual([true, true, true]);
  });

  it("re-attaching repeatedly leaves exactly one overlay group and one copy of each light", () => {
    const e = engine();
    e.overlay.setRig(rig("replace"));
    e.overlay.reattach();
    e.overlay.reattach();
    const groups: THREE.Object3D[] = [];
    e.scene.traverse((o) => o.name === "::PRISM_SHOT_LIGHTING::" && groups.push(o));
    expect(groups).toHaveLength(1);
    expect(e.overlay.inspect().lights).toEqual([{ type: "SpotLight", layer0: true }]);
    e.overlay.setRig(null);
    expect(baseVisibility(e.active)).toEqual([true, true, true]);
  });

  it("dispose removes the group and restores the base", () => {
    const e = engine();
    e.overlay.setRig(rig("replace"));
    e.overlay.dispose();
    expect(baseVisibility(e.active)).toEqual([true, true, true]);
    expect(e.scene.getObjectByName("::PRISM_SHOT_LIGHTING::")).toBeUndefined();
  });

  it("nothing it adds is saved, helpers are editor-only, and a disabled light lights nothing", () => {
    const e = engine();
    const off = { ...newShotLight("point", "off"), enabled: false };
    e.overlay.setRig(rig("replace", [newShotLight("spot", "s"), off]));
    e.scene.getObjectByName("::PRISM_SHOT_LIGHTING::")!.traverse((o) => {
      expect(o.userData.media_id).toBeUndefined();
      expect((o as THREE.Light).castShadow ?? false).toBe(false);
    });
    const i = e.overlay.inspect();
    expect(i.lights).toEqual([{ type: "SpotLight", layer0: true }]);
    expect(i.helpers.length).toBe(1);
    expect(i.helpers[0].onEditorLayerOnly).toBe(true);
  });

  it("builds each type from its own fields", () => {
    const e = engine();
    const spot = {
      ...newShotLight("spot", "s"),
      coneAngleDeg: 30,
      penumbra: 0.25,
      intensity: 7,
      range: 12,
      color: "#ff0000",
    };
    e.overlay.setRig(rig("replace", [spot]));
    const group = e.scene.getObjectByName("::PRISM_SHOT_LIGHTING::")!;
    const light = group.children.find((c) => (c as THREE.SpotLight).isSpotLight) as THREE.SpotLight;
    expect(light.angle).toBeCloseTo(Math.PI / 6);
    expect(light.penumbra).toBe(0.25);
    expect(light.intensity).toBe(7);
    expect(light.distance).toBe(12);
    expect(light.color.getHexString()).toBe("ff0000");
    expect(light.target.parent).toBe(group);
  });
});

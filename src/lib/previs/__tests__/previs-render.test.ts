import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  emptyCameraPath,
  evaluateCameraPath,
  keyframeFromCamera,
  quaternionToEuler,
  upsertKeyframe,
  type CameraPath,
} from "@/domain/previs/camera-path";
import { ArtCraftSceneAdapter } from "../scene-adapter";
import {
  PrevisCancelled,
  renderPrevis,
  type FrameEncoder,
  type FrameRenderer,
  type RenderPose,
} from "../previs-render";

const path = (): CameraPath => {
  let p = emptyCameraPath(1000, 24);
  p = upsertKeyframe(
    p,
    keyframeFromCamera("a", 0, {
      position: { x: 0, y: 1.6, z: 8 },
      rotation: { x: 0, y: 0, z: 0 },
      focalLengthMm: 35,
    }),
  );
  p = upsertKeyframe(
    p,
    keyframeFromCamera(
      "b",
      1000,
      { position: { x: 2, y: 1.6, z: 2 }, rotation: { x: 0, y: 0.5, z: 0 }, focalLengthMm: 70 },
      "linear",
    ),
  );
  return p;
};

class FakeRenderer implements FrameRenderer {
  poses: RenderPose[] = [];
  async renderFrame(pose: RenderPose) {
    this.poses.push(pose);
    return {} as HTMLCanvasElement;
  }
}
class FakeEncoder implements FrameEncoder {
  started: unknown = null;
  frames: Array<{ i: number; ts: number; dur: number }> = [];
  finished = false;
  cancelled = 0;
  async start(o: { width: number; height: number; frameRate: number }) {
    this.started = o;
  }
  async addFrame(_f: unknown, i: number, ts: number, dur: number) {
    this.frames.push({ i, ts, dur });
  }
  async finish() {
    this.finished = true;
    return { bytes: new Uint8Array([1, 2, 3]), container: "mp4" as const, codec: "avc" };
  }
  async cancel() {
    this.cancelled++;
  }
}
const noYield = async () => undefined;

describe("renderPrevis", () => {
  it("samples n/frameRate, evaluates the shared camera evaluator per frame and encodes in order", async () => {
    const p = path();
    const r = new FakeRenderer();
    const e = new FakeEncoder();
    const progress: number[] = [];
    const out = await renderPrevis({
      path: p,
      size: { width: 956, height: 400 },
      renderer: r,
      encoder: e,
      yieldToUi: noYield,
      onProgress: (x) => x.phase === "rendering" && progress.push(x.frame),
    });
    expect(out.frameCount).toBe(24);
    expect(e.frames).toHaveLength(24);
    expect(e.frames[0]).toEqual({ i: 0, ts: 0, dur: 1 / 24 });
    expect(e.frames[23].ts).toBeCloseTo(23 / 24, 10);
    expect(progress[0]).toBe(1);
    expect(progress.at(-1)).toBe(24);
    expect(e.started).toEqual({ width: 956, height: 400, frameRate: 24 });
    // frame 12 is sampled at 500 ms: exactly what the timeline evaluator returns there
    const mid = evaluateCameraPath(p, 500)!;
    expect(r.poses[12].position.x).toBeCloseTo(mid.position.x, 10);
    expect(r.poses[12].focalLengthMm).toBeCloseTo(mid.focalLengthMm, 10);
    expect(r.poses[12].rotation.y).toBeCloseTo(quaternionToEuler(mid.quaternion).y, 10);
    expect(out).toMatchObject({ container: "mp4", codec: "avc", width: 956, height: 400, durationMs: 1000 });
    expect(e.finished).toBe(true);
    expect(e.cancelled).toBe(0);
  });

  it("is deterministic: the same path renders the same poses", async () => {
    const run = async () => {
      const r = new FakeRenderer();
      await renderPrevis({
        path: path(),
        size: { width: 956, height: 400 },
        renderer: r,
        encoder: new FakeEncoder(),
        yieldToUi: noYield,
      });
      return JSON.stringify(r.poses);
    };
    expect(await run()).toBe(await run());
  });

  it("cancels cleanly: stops rendering, cancels the encoder, never finalises", async () => {
    const ac = new AbortController();
    const r = new FakeRenderer();
    const e = new FakeEncoder();
    const spy = vi.spyOn(r, "renderFrame");
    const promise = renderPrevis({
      path: path(),
      size: { width: 956, height: 400 },
      renderer: r,
      encoder: e,
      signal: ac.signal,
      yieldToUi: noYield,
      onProgress: (p) => {
        if (p.frame === 5) ac.abort();
      },
    });
    await expect(promise).rejects.toBeInstanceOf(PrevisCancelled);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(6);
    expect(e.finished).toBe(false);
    expect(e.cancelled).toBe(1);
  });

  it("cancels the encoder when a frame fails to render", async () => {
    const e = new FakeEncoder();
    const bad: FrameRenderer = {
      renderFrame: async () => {
        throw new Error("webgl lost");
      },
    };
    await expect(
      renderPrevis({
        path: path(),
        size: { width: 956, height: 400 },
        renderer: bad,
        encoder: e,
        yieldToUi: noYield,
      }),
    ).rejects.toThrow(/webgl lost/);
    expect(e.cancelled).toBe(1);
  });

  it("refuses a path with fewer than two keyframes before touching the encoder", async () => {
    const e = new FakeEncoder();
    const one = { ...path(), keyframes: path().keyframes.slice(0, 1) };
    await expect(
      renderPrevis({
        path: one,
        size: { width: 956, height: 400 },
        renderer: new FakeRenderer(),
        encoder: e,
      }),
    ).rejects.toThrow(/at least two/);
    expect(e.started).toBeNull();
  });
});

describe("path overlay and playback pose (adapter)", () => {
  function adapterWithScene() {
    const scene = new THREE.Scene();
    const cam = new THREE.Object3D();
    cam.name = "::CAM::";
    scene.add(cam);
    const viewport = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    viewport.position.set(9, 9, 9);
    const editor = {
      activeScene: { scene },
      cameraController: { camera: viewport, cam_obj: cam, camera_person_mode: false },
    };
    const adapter = new ArtCraftSceneAdapter({ resolveAssetUrl: (id) => id });
    (adapter as unknown as { editor: unknown }).editor = editor;
    return { adapter, scene, viewport, cam };
  }

  it("draws the overlay on the editor-only layer, not pickable, and removes it", () => {
    const { adapter, scene } = adapterWithScene();
    adapter.setPathOverlay({
      line: [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 1 },
      ],
      keys: [
        { position: { x: 0, y: 0, z: 0 }, selected: false, role: "start" },
        { position: { x: 1, y: 0, z: 1 }, selected: true, role: "end" },
      ],
      current: { x: 0.5, y: 0, z: 0.5 },
    });
    const group = scene.getObjectByName("::PRISM_PATH_OVERLAY::")!;
    expect(group).toBeDefined();
    expect(group.userData.media_id).toBeUndefined(); // never serialised or listed as an object
    const meshes: THREE.Object3D[] = [];
    group.traverse((o) => meshes.push(o));
    expect(meshes.length).toBeGreaterThan(3);
    for (const o of meshes) {
      expect(o.layers.isEnabled(1)).toBe(true);
      expect(o.layers.isEnabled(0)).toBe(false); // the production render camera (layer 0) cannot see it
    }
    // a production render camera (layer 1 disabled) does not see the overlay
    const prod = new THREE.PerspectiveCamera();
    prod.layers.disable(1);
    expect(group.layers.test(prod.layers)).toBe(false);
    adapter.setPathOverlay(null);
    expect(scene.getObjectByName("::PRISM_PATH_OVERLAY::")).toBeUndefined();
  });
});

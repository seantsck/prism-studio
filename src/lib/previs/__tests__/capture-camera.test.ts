import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { bookmarkFromCamera } from "@/domain/previs/camera";
import { ArtCraftSceneAdapter } from "../scene-adapter";

function adapterWithEditor(dims = { width: 1912, height: 800 }) {
  const viewport = new THREE.PerspectiveCamera(60, 1.5, 0.1, 100);
  viewport.position.set(40, 30, -20); // the operator has navigated somewhere else entirely
  viewport.lookAt(0, 0, 0);
  const before = { p: viewport.position.toArray(), q: viewport.quaternion.toArray(), fov: viewport.fov };
  let used: THREE.PerspectiveCamera | undefined;
  const editor = {
    cameraController: { camera: viewport, getRenderDimensions: () => dims },
    snapShotOfCurrentFrame: vi.fn((_dl: boolean, c?: THREE.PerspectiveCamera) => {
      used = c;
      return { file: new Blob(["x"], { type: "image/png" }), base64Snapshot: "" };
    }),
  };
  const adapter = new ArtCraftSceneAdapter({ resolveAssetUrl: (id) => id });
  (adapter as unknown as { editor: unknown }).editor = editor;
  return { adapter, editor, viewport, before, used: () => used };
}

const bookmark = bookmarkFromCamera({
  id: "c",
  label: "CAM-A",
  position: { x: 1.2, y: 1.6, z: 7 },
  rotation: { x: -0.1, y: 0.35, z: 0 },
  focalLengthMm: 35,
});

describe("master frame capture camera", () => {
  it("renders through an isolated camera built from the bookmark, not the navigation camera", async () => {
    const t = adapterWithEditor();
    const frame = await t.adapter.captureMasterFrame(bookmark);
    expect(frame.width).toBe(1912);
    expect(frame.height).toBe(800);
    const cam = t.used()!;
    expect(cam).toBeDefined();
    expect(cam).not.toBe(t.viewport);
    expect(cam.position.toArray()).toEqual([1.2, 1.6, 7]);
    expect(cam.rotation.x).toBeCloseTo(-0.1, 6);
    expect(cam.rotation.y).toBeCloseTo(0.35, 6);
    expect(cam.fov).toBeCloseTo(bookmark.fovVerticalDegrees, 6);
    expect(cam.aspect).toBeCloseTo(1912 / 800, 6);
    // the proxy layer (1) is excluded, as for the engine's render camera
    expect(cam.layers.isEnabled(1)).toBe(false);
  });

  it("leaves the editor/navigation camera exactly as the operator left it", async () => {
    const t = adapterWithEditor();
    await t.adapter.captureMasterFrame(bookmark);
    expect(t.viewport.position.toArray()).toEqual(t.before.p);
    expect(t.viewport.quaternion.toArray()).toEqual(t.before.q);
    expect(t.viewport.fov).toBe(t.before.fov);
  });

  it("refuses to render when the set is not framed at the Production Frame", async () => {
    const t = adapterWithEditor({ width: 1280, height: 720 });
    await expect(t.adapter.captureMasterFrame(bookmark)).rejects.toThrow(/Production Frame/);
    expect(t.editor.snapShotOfCurrentFrame).not.toHaveBeenCalled();
  });
});

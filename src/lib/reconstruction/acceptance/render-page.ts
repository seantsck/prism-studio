import * as THREE from "three";
import { focalLengthToFovDegrees } from "@/domain/previs/camera";
import { PREVIS_PRODUCTION_FRAME } from "@/domain/previs/types";
import { SplatRuntime } from "@/lib/previs/splat-runtime";

/**
 * BROWSER entry of the Spark render acceptance (M2D.3D1), bundled by ./render.ts. It uses Prism's PRODUCTION splat
 * path, not a re-implementation: `SplatRuntime` (structural validation → Spark 0.1.10 `SplatMesh` on the page's own
 * `THREE.WebGLRenderer`) and `renderFromCamera` (the sorted single-viewpoint render that master frames use), framed by
 * a Production Camera (35 mm on the 24 mm sensor model, the 2.39:1 production frame).
 *
 * It reports facts (Gaussians loaded, how much of each frame is covered, GL errors). It does NOT judge visual quality:
 * the frames are saved for a human.
 */

export interface RenderFrame {
  name: "overview" | "interior";
  /** fraction of pixels that differ from the clear colour */
  coverage: number;
  dataUrl: string;
}

export interface RenderOutcome {
  gaussianCount: number | null;
  frames: RenderFrame[];
  glErrors: number[];
  loadFailures: string[];
  webgl: { renderer: string | null; version: string | null };
}

declare global {
  interface Window {
    __prismAcceptanceRender?: (url: string) => Promise<RenderOutcome>;
  }
}

const ASSET_ID = "00000000-0000-4000-8000-00000000acc1";
const W = PREVIS_PRODUCTION_FRAME.width / 2;
const H = PREVIS_PRODUCTION_FRAME.height / 2;

window.__prismAcceptanceRender = async (url: string): Promise<RenderOutcome> => {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 1);
  const gl = renderer.getContext();
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const webgl = {
    renderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null,
    version: String(gl.getParameter(gl.VERSION)),
  };
  const scene = new THREE.Scene();
  const runtime = new SplatRuntime({
    renderer: () => renderer,
    scene: () => scene,
    assets: () => new Map([[ASSET_ID, { format: "spz", name: "acceptance" }]]),
    fetchBytes: async () => (await fetch(url)).arrayBuffer(),
  });
  const glErrors: number[] = [];
  let mesh: THREE.Object3D | null = null;
  try {
    mesh = await runtime.load(`m_${ASSET_ID}`, "acceptance");
  } catch {
    // reported through runtime.failures()
  }
  if (!mesh)
    return {
      gaussianCount: null,
      frames: [],
      glErrors,
      loadFailures: runtime.failures().map((f) => `${f.kind}: ${f.message}`),
      webgl,
    };
  scene.add(mesh);
  const box = (mesh as unknown as { getBoundingBox: () => THREE.Box3 }).getBoundingBox();
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z, 1e-3);

  const camera = new THREE.PerspectiveCamera(focalLengthToFovDegrees(35), W / H, extent * 1e-3, extent * 100);
  const pixels = new Uint8Array(W * H * 4);
  const frames: RenderFrame[] = [];
  const shoot = async (name: RenderFrame["name"], position: THREE.Vector3, target: THREE.Vector3) => {
    camera.position.copy(position);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
    await runtime.renderFromCamera(camera, () => renderer.render(scene, camera));
    for (let e = gl.getError(); e !== gl.NO_ERROR && glErrors.length < 16; e = gl.getError())
      glErrors.push(e);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let covered = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i]! + pixels[i + 1]! + pixels[i + 2]! > 12) covered++;
    frames.push({ name, coverage: covered / (W * H), dataUrl: canvas.toDataURL("image/png") });
  };
  // outside the splat's bounds, looking at its centre (whatever was reconstructed is in view)
  await shoot("overview", center.clone().add(new THREE.Vector3(0, extent * 0.35, extent * 1.4)), center);
  // a Production Camera standing at the centre of the reconstructed space (for a room: inside it)
  await shoot("interior", center.clone(), center.clone().add(new THREE.Vector3(0, 0, -1)));
  const count = runtime.stats()[0]?.gaussianCount ?? null;
  return { gaussianCount: count, frames, glErrors, loadFailures: [], webgl };
};

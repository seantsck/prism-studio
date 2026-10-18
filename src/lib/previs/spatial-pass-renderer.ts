import * as THREE from "three";
import type { ControlCamera } from "@/domain/previs/spatial-passes";

/**
 * Renders the machine-readable spatial control passes (Phase 2F M2C) with the editor's EXISTING WebGL renderer:
 * one temporary float render target, two temporary shader materials, no second context, no postprocessing.
 *
 *   depth      linear VIEW-SPACE depth in metres  (positive distance along the camera's forward axis; 0 = background)
 *   object id  the bundle-local manifest index of the production entity that owns the pixel (0 = background)
 *
 * Only PRODUCTION geometry takes part: a registry of entity roots (Set objects and Shot Character proxies) is
 * given explicitly. Everything else in the scene (grid, gizmos, FK handles, skeleton lines, path overlay, camera
 * proxy, lights, labels, selection outlines) is hidden for the duration of the render and restored in `finally`.
 * The original materials, visibility, background, fog and renderer state are put back exactly.
 *
 * Output rasters are row 0 = TOP (the one flip from WebGL's bottom-left origin happens here, at readback).
 */

export interface PassEntity {
  /** bundle-local manifest index (1..N) */
  index: number;
  semanticId: string;
  kind: "set_object" | "character_proxy";
  /** scene objects that make up this entity (a Set object, or a whole Character proxy group) */
  roots: THREE.Object3D[];
}

export interface RenderedPasses {
  width: number;
  height: number;
  /** linear view-space depth in metres, 0 = background */
  depth: Float32Array;
  /** manifest index per pixel, 0 = background */
  ids: Uint32Array;
}

const EDITOR_ONLY_LAYER = 1;

const DEPTH_VERTEX = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
varying float vViewDepth;
void main() {
  #include <batching_vertex>
  #include <skinbase_vertex>
  #include <morphinstance_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vViewDepth = -mvPosition.z;
}
`;
const DEPTH_FRAGMENT = /* glsl */ `
varying float vViewDepth;
void main() {
  gl_FragColor = vec4(vViewDepth, 0.0, 0.0, 1.0);
}
`;
const ID_FRAGMENT = /* glsl */ `
uniform float uObjectIndex;
void main() {
  gl_FragColor = vec4(uObjectIndex, 0.0, 0.0, 1.0);
}
`;

function passMaterial(kind: "depth" | "id", side: THREE.Side, index: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: DEPTH_VERTEX,
    fragmentShader: kind === "depth" ? DEPTH_FRAGMENT : ID_FRAGMENT,
    uniforms: { uObjectIndex: { value: index } },
    side,
    // exact values: no blending, no tone mapping, no lighting, no fog
    blending: THREE.NoBlending,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
    fog: false,
    lights: false,
  });
}

export class SpatialPassUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpatialPassUnsupported";
  }
}

export function isRenderable(o: THREE.Object3D): boolean {
  const x = o as THREE.Mesh & THREE.Line & THREE.Points & THREE.Sprite;
  return x.isMesh === true || x.isLine === true || x.isPoints === true || x.isSprite === true;
}

/** Production camera for the passes, built purely from the frozen camera value. */
export function buildPassCamera(c: ControlCamera): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(c.fovVerticalDegrees, c.aspect, c.near, c.far);
  cam.position.set(c.position.x, c.position.y, c.position.z);
  cam.quaternion.set(c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w);
  cam.layers.disable(EDITOR_ONLY_LAYER);
  cam.updateMatrixWorld(true);
  return cam;
}

export function renderSpatialPasses(args: {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: ControlCamera;
  entities: PassEntity[];
}): RenderedPasses {
  const { renderer, scene, camera: control, entities } = args;
  const { width, height } = control;
  const gl = renderer.getContext();
  if (!renderer.capabilities.isWebGL2 || !renderer.extensions.has("EXT_color_buffer_float"))
    throw new SpatialPassUnsupported(
      "This browser cannot render 32-bit float depth (WebGL2 EXT_color_buffer_float is required). No depth was captured.",
    );
  if (width * height > gl.getParameter(gl.MAX_TEXTURE_SIZE) ** 2)
    throw new SpatialPassUnsupported("The control frame is larger than this GPU supports.");

  const cam = buildPassCamera(control);

  // ── production registry: which meshes belong to which entity ──
  const rootSet = new Set<THREE.Object3D>();
  for (const e of entities) for (const r of e.roots) rootSet.add(r);
  const meshEntity = new Map<THREE.Mesh, PassEntity>();
  const hideInside: THREE.Object3D[] = [];
  for (const e of entities) {
    for (const root of e.roots) {
      root.traverse((o) => {
        if (!isRenderable(o)) return;
        const mesh = o as THREE.Mesh;
        const eligible =
          mesh.isMesh === true &&
          cam.layers.test(o.layers) &&
          (e.kind !== "character_proxy" || o.userData?.prismProxyPiece === true);
        if (eligible) meshEntity.set(mesh, e);
        else hideInside.push(o);
      });
    }
  }

  // ── save everything we are about to touch ──
  const savedVisible = new Map<THREE.Object3D, boolean>();
  const hide = (o: THREE.Object3D) => {
    if (!savedVisible.has(o)) savedVisible.set(o, o.visible);
    o.visible = false;
  };
  const savedMaterial = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  const prev = {
    target: renderer.getRenderTarget(),
    clearColor: renderer.getClearColor(new THREE.Color()).clone(),
    clearAlpha: renderer.getClearAlpha(),
    autoClear: renderer.autoClear,
    background: scene.background,
    environment: scene.environment,
    fog: scene.fog,
    overrideMaterial: scene.overrideMaterial,
  };

  const materials: THREE.ShaderMaterial[] = [];
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    samples: 0, // no multisampling: ids must never be blended
    colorSpace: THREE.NoColorSpace,
  });

  const readPass = (kind: "depth" | "id"): Float32Array => {
    // swap in the pass materials (one per entity and side so ids stay exact)
    const cache = new Map<string, THREE.ShaderMaterial>();
    const matFor = (e: PassEntity, side: THREE.Side) => {
      const key = `${e.index}:${side}`;
      let m = cache.get(key);
      if (!m) {
        m = passMaterial(kind, side, e.index);
        cache.set(key, m);
        materials.push(m);
      }
      return m;
    };
    for (const [mesh, e] of meshEntity) {
      if (!savedMaterial.has(mesh)) savedMaterial.set(mesh, mesh.material);
      const original = savedMaterial.get(mesh)!;
      mesh.material = Array.isArray(original)
        ? original.map((m) => matFor(e, m.side))
        : matFor(e, (original as THREE.Material).side);
    }
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    const buf = new Float32Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, buf);
    // flip ONCE: WebGL rows start at the bottom, the stored raster starts at the top
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const srcRow = (height - 1 - y) * width;
      const dstRow = y * width;
      for (let x = 0; x < width; x++) out[dstRow + x] = buf[(srcRow + x) * 4];
    }
    return out;
  };

  try {
    // hide everything that is not production geometry
    for (const child of scene.children) if (!rootSet.has(child)) hide(child);
    for (const o of hideInside) hide(o);
    scene.background = null;
    scene.environment = null;
    scene.fog = null;
    scene.overrideMaterial = null;

    const depth = readPass("depth");
    const idsF = readPass("id");
    const ids = new Uint32Array(width * height);
    for (let i = 0; i < ids.length; i++) ids[i] = Math.round(idsF[i]);
    return { width, height, depth, ids };
  } finally {
    for (const [mesh, m] of savedMaterial) mesh.material = m;
    for (const [o, v] of savedVisible) o.visible = v;
    scene.background = prev.background;
    scene.environment = prev.environment;
    scene.fog = prev.fog;
    scene.overrideMaterial = prev.overrideMaterial;
    renderer.setRenderTarget(prev.target);
    renderer.setClearColor(prev.clearColor, prev.clearAlpha);
    renderer.autoClear = prev.autoClear;
    for (const m of materials) m.dispose();
    target.dispose();
  }
}

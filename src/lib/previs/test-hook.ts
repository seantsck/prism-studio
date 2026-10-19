import * as THREE from "three";
import { bookmarkFromCamera } from "@/domain/previs/camera";
import { sha256Bytes } from "@/domain/hash";
import {
  buildObjectManifest,
  controlCameraFromPose,
  deriveCharacterMasks,
  type ControlCamera,
  type ObjectManifest,
} from "@/domain/previs/spatial-passes";
import type { SpatialSceneAdapter } from "./scene-adapter";
import { buildPassCamera, type RenderedPasses } from "./spatial-pass-renderer";

/**
 * Read/steer helpers for browser acceptance tests only. Installed solely when the page is automated
 * (`navigator.webdriver`), so ordinary operators never get a global.
 */
export interface SpatialTestHook {
  /** Renders depth + object ids for an explicit pose (never the navigation camera) and remembers the result. */
  capture(pose: { position: number[]; rotation: number[]; focalLengthMm: number }): {
    width: number;
    height: number;
    objects: Array<{ index: number; semanticId: string; category: string; pixels: number }>;
    depthMin: number | null;
    depthMax: number | null;
    nonFinite: number;
    negative: number;
  };
  /** depth (m) and object index at a pixel (row 0 = top) of the last capture */
  sample(x: number, y: number): { depth: number; id: number };
  /** the pixel the last capture's camera projects a world point to */
  pixelOf(world: number[]): { x: number; y: number; inFront: boolean };
  /** bounding box + pixel count of one object index in the last capture */
  bbox(index: number): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    count: number;
    /** a pixel that really belongs to the object, as close to the bbox centre as possible */
    anchor: { x: number; y: number };
  } | null;
  /** how many mask pixels a Character's derived mask has, and whether every one carries that object's id */
  maskStats(characterId: string): { count: number; objectIndex: number } | null;
  /** SHA-256 of the last capture's raw rasters */
  digest(): { depth: string; ids: string };
  /** SHA-256 of a master-frame style beauty render through the current Production Camera */
  beautyDigest(): Promise<string>;
  /** a digest of everything a pass capture must not change in the live scene (visibility, materials, layers) */
  sceneStateDigest(): string;
  renderInfo(): { textures: number; geometries: number; programs: number; canvases: number };
  /** Live-scene setup for geometry tests (never saved; reload discards it). */
  addBox(position: number[], scale: number[]): Promise<string>;
  clearScene(): void;
  placeFigure(characterId: string, position: number[]): void;
  setFigureVisible(characterId: string, visible: boolean): void;
  /** Re-selects a Set object (selection outline) so tests can prove selection never reaches a pass. */
  selectObject(id: string | null): void;
}

/** Gaussian-splat acceptance helpers (M2D.1). */
export interface SplatTestHook {
  /** live splat roots, SparkRenderers and WebGL facts of the mounted editor */
  info(): {
    liveSplats: number;
    sparkRenderers: number;
    splatObjects: Array<{
      id: string;
      visible: boolean;
      locked: boolean;
      position: number[];
      rotation: number[];
      scale: number[];
      hasUrlInUserData: boolean;
    }>;
    stats: Array<{ gaussianCount: number; loadMs: number; estimatedGpuBytes: number; format: string }>;
    failures: Array<{ message: string; kind: string }>;
  };
  /**
   * Renders the Production Frame through an EXPLICIT pose (as a master frame does) and returns the RGB at the given
   * pixels (row 0 = top). Never reads the navigation camera.
   */
  beautyPixels(
    pose: { position: number[]; rotation: number[]; focalLengthMm: number },
    pixels: Array<[number, number]>,
  ): Promise<Array<[number, number, number]>>;
  /** Same, but through the local previs frame renderer at `size` (row 0 = top). */
  previsPixels(
    pose: { position: number[]; rotation: number[]; focalLengthMm: number },
    size: { width: number; height: number },
    pixels: Array<[number, number]>,
  ): Promise<Array<[number, number, number]>>;
  /** The pixel (row 0 = top) a world point projects to for an explicit pose. */
  pixelOf(
    pose: { position: number[]; rotation: number[]; focalLengthMm: number },
    world: number[],
  ): { x: number; y: number };
  /** Mean frames per second of the editor viewport over `ms` milliseconds. */
  fps(ms: number): Promise<number>;
  /** True once the editor has finished loading the saved scene (every object resolved or failed). */
  sceneLoaded(): boolean;
  /** World-space bounding box of a splat object. */
  worldBounds(id: string): { min: number[]; max: number[] } | null;
  /** Client-space (CSS px) position of a point on a splat's bounding box, for real pointer interaction. */
  bboxClientPoint(id: string, fraction?: number[]): { x: number; y: number } | null;
}

export interface PrevisTestHook {
  spatial: SpatialTestHook;
  splat: SplatTestHook;
  /** Client-space (CSS px) position of a point `offsetWorld` away from the object's origin. */
  project(id: string, offsetWorld?: { x: number; y: number; z: number }): { x: number; y: number } | null;
  navigationCamera(): { position: number[]; rotation: number[]; fov: number } | null;
  /** The live production camera (position, Euler rotation, focal length), never the navigation camera. */
  productionCamera(): { position: number[]; rotation: number[]; focalLengthMm: number } | null;
  /** True when the editor-only camera-path overlay is in the scene (and visible to the editor camera only). */
  overlay(): { present: boolean; onEditorLayerOnly: boolean };
  /** Move the editor/navigation camera somewhere else (test-only). */
  setNavigationCamera(position: number[], lookAt: number[]): void;
  /** Client-space position of a character proxy's root (plus an offset in world metres), or null. */
  projectFigure(
    characterId: string,
    offset?: { x: number; y: number; z: number },
  ): { x: number; y: number } | null;
  /** Client-space position of one of a proxy's joints. */
  projectJoint(characterId: string, joint: string): { x: number; y: number } | null;
  /** World position and local quaternion of a proxy's joint. */
  jointState(characterId: string, joint: string): { world: number[]; quaternion: number[] } | null;
  /** What the blocking overlay currently holds, and whether any editor helper could leak into a render. */
  blockingInfo(): {
    proxyCount: number;
    poseMode: boolean;
    selectedCharacter: string | null;
    selectedJoint: string | null;
    helpers: Array<{ name: string; onEditorLayerOnly: boolean }>;
    geometries: number;
    sceneProxyNames: string[];
  };
}

export function installPrevisTestHook(adapter: SpatialSceneAdapter, canvas: HTMLCanvasElement) {
  if (typeof navigator === "undefined" || !navigator.webdriver) return () => {};
  const w = window as unknown as { __prismSet?: PrevisTestHook };
  const cam = () => adapter.getEditor()?.cameraController.camera ?? null;
  let last: { passes: RenderedPasses; manifest: ObjectManifest; camera: ControlCamera } | null = null;
  const requireLast = () => {
    if (!last) throw new Error("No spatial capture has been taken yet.");
    return last;
  };
  w.__prismSet = {
    spatial: {
      capture(pose) {
        const camera = controlCameraFromPose(
          { x: pose.position[0], y: pose.position[1], z: pose.position[2] },
          { x: pose.rotation[0], y: pose.rotation[1], z: pose.rotation[2] },
          pose.focalLengthMm,
        );
        const e = adapter.productionEntities();
        const manifest = buildObjectManifest({
          setObjects: e.setObjects,
          characters: e.characterIds.map((id) => ({ characterId: id, blockingId: `test-${id}` })),
        });
        const passes = adapter.captureSpatialPasses(camera, manifest);
        last = { passes, manifest, camera };
        const counts = new Uint32Array(manifest.objects.length + 1);
        let min = Infinity;
        let max = -Infinity;
        let nonFinite = 0;
        let negative = 0;
        for (let i = 0; i < passes.ids.length; i++) {
          counts[passes.ids[i]]++;
          const d = passes.depth[i];
          if (!Number.isFinite(d)) nonFinite++;
          else if (d < 0) negative++;
          else if (d > 0) {
            if (d < min) min = d;
            if (d > max) max = d;
          }
        }
        return {
          width: passes.width,
          height: passes.height,
          objects: manifest.objects.map((o) => ({
            index: o.index,
            semanticId: o.semanticId,
            category: o.category,
            pixels: counts[o.index],
          })),
          depthMin: Number.isFinite(min) ? min : null,
          depthMax: Number.isFinite(max) ? max : null,
          nonFinite,
          negative,
        };
      },
      sample(x, y) {
        const { passes } = requireLast();
        const i = y * passes.width + x;
        return { depth: passes.depth[i], id: passes.ids[i] };
      },
      pixelOf(world) {
        const { passes, camera } = requireLast();
        const cam = buildPassCamera(camera);
        const v = new THREE.Vector3(world[0], world[1], world[2]);
        const inFront = v.clone().applyMatrix4(cam.matrixWorldInverse).z < 0;
        v.project(cam);
        return {
          x: ((v.x + 1) / 2) * passes.width,
          y: ((1 - v.y) / 2) * passes.height,
          inFront,
        };
      },
      bbox(index) {
        const { passes } = requireLast();
        let minX = Infinity;
        let maxX = -1;
        let minY = Infinity;
        let maxY = -1;
        let count = 0;
        for (let y = 0; y < passes.height; y++)
          for (let x = 0; x < passes.width; x++)
            if (passes.ids[y * passes.width + x] === index) {
              count++;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
        if (!count) return null;
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        let best = Infinity;
        const anchor = { x: minX, y: minY };
        for (let y = minY; y <= maxY; y++)
          for (let x = minX; x <= maxX; x++)
            if (passes.ids[y * passes.width + x] === index) {
              const d = (x - cx) ** 2 + (y - cy) ** 2;
              if (d < best) {
                best = d;
                anchor.x = x;
                anchor.y = y;
              }
            }
        return { minX, maxX, minY, maxY, count, anchor };
      },
      maskStats(characterId) {
        const { passes, manifest } = requireLast();
        const m = deriveCharacterMasks(passes.ids, manifest).find((x) => x.characterId === characterId);
        return m ? { count: m.visiblePixelCount, objectIndex: m.objectIndex } : null;
      },
      digest() {
        const { passes } = requireLast();
        return {
          depth: sha256Bytes(
            new Uint8Array(passes.depth.buffer, passes.depth.byteOffset, passes.depth.byteLength),
          ),
          ids: sha256Bytes(new Uint8Array(passes.ids.buffer, passes.ids.byteOffset, passes.ids.byteLength)),
        };
      },
      async beautyDigest() {
        const cam = adapter.getProductionCamera();
        if (!cam) throw new Error("No production camera.");
        const frame = await adapter.captureMasterFrame(bookmarkFromCamera(cam));
        return sha256Bytes(new Uint8Array(await frame.blob.arrayBuffer()));
      },
      sceneStateDigest() {
        const scene = adapter.getEditor()?.activeScene.scene;
        const parts: string[] = [];
        scene?.traverse((o) => {
          const m = (o as THREE.Mesh).material;
          const mats = Array.isArray(m) ? m : m ? [m] : [];
          parts.push(
            [o.uuid, o.visible ? 1 : 0, o.layers.mask, o.renderOrder, mats.map((x) => x.uuid).join(",")].join(
              "|",
            ),
          );
        });
        const bg = scene?.background ? String((scene.background as THREE.Color).getHex?.() ?? "tex") : "none";
        parts.push(`bg:${bg}|fog:${scene?.fog ? 1 : 0}|sel:${adapter.selectedId() ?? ""}`);
        return sha256Bytes(new TextEncoder().encode(parts.join(";")));
      },
      async addBox(position, scale) {
        const id = await adapter.addPrimitive("Box");
        if (!id) throw new Error("Could not add a box.");
        adapter.updateTransform(id, {
          position: { x: position[0], y: position[1], z: position[2] },
          scale: { x: scale[0], y: scale[1], z: scale[2] },
        });
        return id;
      },
      clearScene() {
        for (const o of adapter.listObjects()) adapter.removeObject(o.id);
        for (const f of adapter.blocking.list()) adapter.blocking.setVisible(f.characterId, false);
      },
      placeFigure(characterId, position) {
        adapter.blocking.setRoot(characterId, {
          position: { x: position[0], y: position[1], z: position[2] },
        });
        adapter.blocking.setVisible(characterId, true);
      },
      setFigureVisible(characterId, visible) {
        adapter.blocking.setVisible(characterId, visible);
      },
      selectObject(id) {
        adapter.select(id);
      },
      renderInfo() {
        const r = adapter.getEditor()?.renderer;
        return {
          textures: r?.info.memory.textures ?? -1,
          geometries: r?.info.memory.geometries ?? -1,
          programs: r?.info.programs?.length ?? -1,
          canvases: document.querySelectorAll("canvas").length,
        };
      },
    },
    splat: {
      info() {
        const editor = adapter.getEditor();
        const scene = editor?.activeScene.scene;
        let spark = 0;
        scene?.traverse((o) => {
          if (o.name === "::PRISM_SPARK::") spark++;
        });
        const stats = adapter.splatStats().map((s) => ({
          gaussianCount: s.gaussianCount,
          loadMs: s.loadMs,
          estimatedGpuBytes: s.estimatedGpuBytes,
          format: s.format,
        }));
        const objs = adapter
          .listObjects()
          .filter((o) => o.kind === "splat")
          .map((o) => {
            const node = scene?.getObjectByProperty("uuid", o.id);
            return {
              id: o.id,
              visible: o.visible,
              locked: o.locked,
              position: [o.position.x, o.position.y, o.position.z],
              rotation: [o.rotation.x, o.rotation.y, o.rotation.z],
              scale: [o.scale.x, o.scale.y, o.scale.z],
              hasUrlInUserData: /(https?:|blob:|X-Amz|token=)/i.test(JSON.stringify(node?.userData ?? {})),
            };
          });
        return {
          liveSplats: adapter.splatCount(),
          sparkRenderers: spark,
          splatObjects: objs,
          stats,
          failures: adapter.splatFailures().map((f) => ({ message: f.message, kind: f.kind })),
        };
      },
      async beautyPixels(pose, pixels) {
        const bookmark = bookmarkFromCamera({
          id: "test",
          label: "test",
          position: { x: pose.position[0], y: pose.position[1], z: pose.position[2] },
          rotation: { x: pose.rotation[0], y: pose.rotation[1], z: pose.rotation[2] },
          focalLengthMm: pose.focalLengthMm,
        });
        const frame = await adapter.captureMasterFrame(bookmark);
        const bitmap = await createImageBitmap(frame.blob);
        const c = document.createElement("canvas");
        c.width = bitmap.width;
        c.height = bitmap.height;
        const g = c.getContext("2d", { willReadFrequently: true })!;
        g.drawImage(bitmap, 0, 0);
        bitmap.close();
        return pixels.map(([x, y]) => {
          const d = g.getImageData(x, y, 1, 1).data;
          return [d[0], d[1], d[2]] as [number, number, number];
        });
      },
      async previsPixels(pose, size, pixels) {
        const canvas2 = await adapter.renderPrevisFrame(
          {
            position: { x: pose.position[0], y: pose.position[1], z: pose.position[2] },
            rotation: { x: pose.rotation[0], y: pose.rotation[1], z: pose.rotation[2] },
            focalLengthMm: pose.focalLengthMm,
          },
          size,
        );
        const g = (canvas2 as HTMLCanvasElement).getContext("2d", { willReadFrequently: true })!;
        return pixels.map(([x, y]) => {
          const d = g.getImageData(x, y, 1, 1).data;
          return [d[0], d[1], d[2]] as [number, number, number];
        });
      },
      pixelOf(pose, world) {
        const camera = controlCameraFromPose(
          { x: pose.position[0], y: pose.position[1], z: pose.position[2] },
          { x: pose.rotation[0], y: pose.rotation[1], z: pose.rotation[2] },
          pose.focalLengthMm,
        );
        const cam = buildPassCamera(camera);
        const v = new THREE.Vector3(world[0], world[1], world[2]).project(cam);
        return { x: ((v.x + 1) / 2) * 1912, y: ((1 - v.y) / 2) * 800 };
      },
      fps(ms) {
        return new Promise((resolve) => {
          let frames = 0;
          const start = performance.now();
          const tick = () => {
            frames++;
            const elapsed = performance.now() - start;
            if (elapsed >= ms) resolve((frames * 1000) / elapsed);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      },
      sceneLoaded() {
        return adapter.getEditor()?.isEngineDataLoaded() === true;
      },
      worldBounds(id) {
        const node = adapter.getEditor()?.activeScene.scene.getObjectByProperty("uuid", id) as
          (THREE.Object3D & { getBoundingBox?: () => THREE.Box3 }) | undefined;
        if (!node?.getBoundingBox) return null;
        node.updateMatrixWorld(true);
        const box = node.getBoundingBox().clone().applyMatrix4(node.matrixWorld);
        return { min: box.min.toArray(), max: box.max.toArray() };
      },
      bboxClientPoint(id, fraction = [0.5, 0.5, 0.5]) {
        const c = cam();
        const node = adapter.getEditor()?.activeScene.scene.getObjectByProperty("uuid", id) as
          (THREE.Object3D & { getBoundingBox?: () => THREE.Box3 }) | undefined;
        if (!c || !node?.getBoundingBox) return null;
        node.updateMatrixWorld(true);
        c.updateMatrixWorld(true);
        const box = node.getBoundingBox();
        const centre = new THREE.Vector3(
          box.min.x + (box.max.x - box.min.x) * fraction[0]!,
          box.min.y + (box.max.y - box.min.y) * fraction[1]!,
          box.min.z + (box.max.z - box.min.z) * fraction[2]!,
        ).applyMatrix4(node.matrixWorld);
        centre.project(c);
        const r = canvas.getBoundingClientRect();
        return { x: r.left + ((centre.x + 1) / 2) * r.width, y: r.top + ((1 - centre.y) / 2) * r.height };
      },
    },
    project(id, offset = { x: 0, y: 0, z: 0 }) {
      const c = cam();
      const o = adapter.listObjects().find((x) => x.id === id);
      if (!c || !o) return null;
      c.updateMatrixWorld(true);
      const v = new THREE.Vector3(o.position.x + offset.x, o.position.y + offset.y, o.position.z + offset.z);
      v.project(c);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    },
    overlay() {
      const g = adapter.getEditor()?.activeScene.scene.getObjectByName("::PRISM_PATH_OVERLAY::");
      if (!g) return { present: false, onEditorLayerOnly: false };
      let only = true;
      g.traverse((o) => {
        if (!o.layers.isEnabled(1) || o.layers.isEnabled(0)) only = false;
      });
      return { present: true, onEditorLayerOnly: only };
    },
    productionCamera() {
      const c = adapter.getProductionCamera();
      if (!c) return null;
      return {
        position: [c.position.x, c.position.y, c.position.z],
        rotation: [c.rotation.x, c.rotation.y, c.rotation.z],
        focalLengthMm: c.focalLengthMm,
      };
    },
    navigationCamera() {
      const c = cam();
      if (!c) return null;
      return {
        position: c.position.toArray(),
        rotation: [c.rotation.x, c.rotation.y, c.rotation.z],
        fov: c.fov,
      };
    },
    projectFigure(characterId, offset = { x: 0, y: 0, z: 0 }) {
      const c = cam();
      const f = adapter.blocking.list().find((x) => x.characterId === characterId);
      if (!c || !f) return null;
      c.updateMatrixWorld(true);
      const v = new THREE.Vector3(
        f.root.position.x + offset.x,
        f.root.position.y + offset.y,
        f.root.position.z + offset.z,
      );
      v.project(c);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    },
    projectJoint(characterId, joint) {
      const c = cam();
      const w = adapter.blocking.jointWorld(characterId, joint as never);
      if (!c || !w) return null;
      c.updateMatrixWorld(true);
      const v = new THREE.Vector3(w.x, w.y, w.z).project(c);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    },
    jointState(characterId, joint) {
      const w = adapter.blocking.jointWorld(characterId, joint as never);
      const pose = adapter.blocking.list().find((f) => f.characterId === characterId)?.pose;
      if (!w || !pose) return null;
      const q = (pose.joints as Record<string, { x: number; y: number; z: number; w: number }>)[joint] ?? {
        x: 0,
        y: 0,
        z: 0,
        w: 1,
      };
      return { world: [w.x, w.y, w.z], quaternion: [q.x, q.y, q.z, q.w] };
    },
    blockingInfo() {
      const editor = adapter.getEditor();
      const scene = editor?.activeScene.scene;
      const helpers: Array<{ name: string; onEditorLayerOnly: boolean }> = [];
      const names: string[] = [];
      scene?.traverse((o) => {
        const isHelper =
          o.name === "__FKHelperSphere__" || (o as THREE.SkeletonHelper).isSkeletonHelper === true;
        if (isHelper)
          helpers.push({
            name: o.name || o.type,
            onEditorLayerOnly: o.layers.isEnabled(1) && !o.layers.isEnabled(0),
          });
      });
      scene?.children.forEach((c) => {
        if (c.userData?.prismBlocking) names.push(c.name);
      });
      return {
        proxyCount: adapter.blocking.sceneProxyCount(),
        poseMode: adapter.blocking.poseMode(),
        selectedCharacter: adapter.blocking.selectedCharacter(),
        selectedJoint: adapter.blocking.selectedJointId(),
        helpers,
        geometries: editor?.renderer?.info.memory.geometries ?? -1,
        sceneProxyNames: names,
      };
    },
    setNavigationCamera(position, lookAt) {
      const c = cam();
      if (!c) return;
      c.position.set(position[0], position[1], position[2]);
      c.lookAt(lookAt[0], lookAt[1], lookAt[2]);
      c.updateMatrixWorld(true);
    },
  };
  return () => {
    delete w.__prismSet;
  };
}

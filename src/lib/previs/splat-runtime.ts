import * as THREE from "three";
import type { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { assetIdFromToken } from "@/domain/previs/document";
import { SPLAT_FORMAT_INFO, type SplatFormat } from "@/domain/previs/splat";
import { inspectSplat } from "@/lib/splat/inspect";

/**
 * Prism's Gaussian-splat integration (Phase 2F M2D.1). Spark (@sparkjsdev/spark, MIT) renders splats through the
 * editor's EXISTING THREE.WebGLRenderer: there is no second renderer, canvas, iframe or WebGL context. The splat
 * bytes come from authenticated Prism Asset bytes, are validated structurally here before the runtime sees them, and
 * are handed to the runtime as an in-memory buffer (no URL of any kind, so nothing to persist or revoke).
 *
 * Splats are one production object: selectable and transformable at the root, never per-Gaussian. The runtime
 * bundles nothing from ArtCraft and fetches nothing from a third party.
 */

export class SplatLoadError extends Error {
  constructor(
    message: string,
    readonly kind: "unsupported" | "corrupt" | "missing" | "fetch" | "gpu" | "aborted",
  ) {
    super(message);
    this.name = kind === "aborted" ? "AbortError" : "SplatLoadError";
  }
}

export interface SplatAssetInfo {
  format: SplatFormat;
  name: string;
}

export interface SplatRuntimeOptions {
  renderer: () => THREE.WebGLRenderer | null;
  scene: () => THREE.Scene | null;
  /** the project's splat Assets, keyed by Asset id (the engine token is `m_<assetId>`) */
  assets: () => Map<string, SplatAssetInfo>;
  /** authenticated Asset bytes. The adapter implements this over the private `/api/assets/<id>` route. */
  fetchBytes: (assetId: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
}

export interface SplatLoadFailure {
  assetId: string;
  name: string;
  kind: SplatLoadError["kind"];
  message: string;
}

export interface SplatLoadStat {
  assetId: string;
  format: SplatFormat;
  gaussianCount: number;
  loadMs: number;
  /** PackedSplats stores 16 bytes per Gaussian on the GPU; an estimate, not a measurement */
  estimatedGpuBytes: number;
}

type SparkModule = typeof import("@sparkjsdev/spark");
const SPARK_NAME = "::PRISM_SPARK::";
const PREPARE_TIMEOUT_MS = 8000;

/** the root object the engine holds for one splat environment */
export type PrismSplat = SplatMesh & { isPrismSplat: true };

export class SplatRuntime {
  private mod: SparkModule | null = null;
  private spark: SparkRenderer | null = null;
  private readonly meshes = new Set<SplatMesh>();
  private readonly stats_: SplatLoadStat[] = [];
  private readonly failures_: SplatLoadFailure[] = [];
  private disposed = false;

  constructor(private readonly options: SplatRuntimeOptions) {}

  isSplatToken(token: string): boolean {
    const id = assetIdFromToken(token);
    return !!id && this.options.assets().has(id);
  }

  /** How many live splat roots this runtime owns (used to prove repeated navigation never duplicates). */
  liveCount(): number {
    return this.meshes.size;
  }

  stats(): SplatLoadStat[] {
    return this.stats_.map((s) => ({ ...s }));
  }

  /** Splats the scene names that could NOT be loaded (missing Asset, fetch failure, corrupt file, GPU). */
  failures(): SplatLoadFailure[] {
    return this.failures_.map((f) => ({ ...f }));
  }

  /** A splat the saved scene names that never materialised (its Asset is gone, unreadable or unclaimed). */
  recordMissing(assetId: string, name: string) {
    if (this.failures_.some((f) => f.assetId === assetId)) return;
    this.failures_.push({
      assetId,
      name,
      kind: "missing",
      message: `The splat "${name}" could not be loaded (its Asset is missing or unreadable).`,
    });
  }

  clearFailures() {
    this.failures_.length = 0;
  }

  private async sparkModule(): Promise<SparkModule> {
    if (!this.mod) this.mod = await import("@sparkjsdev/spark");
    return this.mod;
  }

  /** One SparkRenderer per scene, bound to the editor's own renderer. Re-added if a scene reload cleared it. */
  private ensureSpark(mod: SparkModule): SparkRenderer {
    const renderer = this.options.renderer();
    const scene = this.options.scene();
    if (!renderer || !scene) throw new SplatLoadError("The 3D set is not ready to render splats.", "gpu");
    if (!this.spark) {
      this.spark = new mod.SparkRenderer({ renderer });
      this.spark.name = SPARK_NAME;
      this.spark.raycast = () => undefined; // never pickable
      this.spark.userData.prismEditorOnly = true; // no media_id: never serialised, listed or fingerprinted
    }
    if (this.spark.parent !== scene) scene.add(this.spark);
    return this.spark;
  }

  /**
   * Loads one splat Asset into an in-memory runtime object. Returns null when the token is not a splat Asset so the
   * engine falls back to its model loader.
   */
  async load(token: string, name: string, signal?: AbortSignal): Promise<THREE.Object3D | null> {
    const assetId = assetIdFromToken(token);
    const info = assetId ? this.options.assets().get(assetId) : undefined;
    if (!assetId || !info) return null;
    try {
      return await this.loadKnown(assetId, info, name, signal);
    } catch (e) {
      // a splat that cannot load is reported, never silently dropped from what the user thinks they saved
      if (!(e instanceof SplatLoadError) || e.kind !== "aborted")
        this.failures_.push({
          assetId,
          name: info.name,
          kind: e instanceof SplatLoadError ? e.kind : "gpu",
          message: e instanceof Error ? e.message : "The splat could not be loaded.",
        });
      throw e;
    }
  }

  private async loadKnown(
    assetId: string,
    info: SplatAssetInfo,
    name: string,
    signal?: AbortSignal,
  ): Promise<THREE.Object3D> {
    const started = performance.now();

    let buffer: ArrayBuffer;
    try {
      buffer = await this.options.fetchBytes(assetId, signal);
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError")
        throw new SplatLoadError("Splat load cancelled.", "aborted");
      throw new SplatLoadError(
        `The splat "${info.name}" could not be fetched: ${(e as Error).message}`,
        "fetch",
      );
    }
    if (signal?.aborted) throw new SplatLoadError("Splat load cancelled.", "aborted");

    // structurally validate BEFORE the runtime parses it; the file's declared format must match its bytes
    const bytes = new Uint8Array(buffer);
    const inspected = inspectSplat(bytes, `asset${SPLAT_FORMAT_INFO[info.format].extension}`);
    if (!inspected.ok) throw new SplatLoadError(inspected.error, "corrupt");

    const mod = await this.sparkModule();
    if (this.disposed) throw new SplatLoadError("Splat load cancelled.", "aborted");
    const spark = this.ensureSpark(mod);

    const fileType = {
      splat: mod.SplatFileType.SPLAT,
      spz: mod.SplatFileType.SPZ,
      ply: mod.SplatFileType.PLY,
    }[info.format];
    let mesh: SplatMesh;
    try {
      // Spark reads some formats through `fileBytes.buffer`, so give it a buffer it owns outright (offset 0)
      mesh = new mod.SplatMesh({
        fileBytes: new Uint8Array(buffer),
        fileType,
        fileName: `asset${SPLAT_FORMAT_INFO[info.format].extension}`,
      });
      await mesh.initialized;
    } catch (e) {
      throw new SplatLoadError(
        `The splat "${info.name}" could not be parsed: ${(e as Error).message}`,
        "corrupt",
      );
    }
    if (signal?.aborted || this.disposed) {
      mesh.dispose();
      throw new SplatLoadError("Splat load cancelled.", "aborted");
    }

    const box = mesh.getBoundingBox();
    mesh.frustumCulled = false;
    mesh.name = name;
    // one production object: picking is the splat's bounding box, never an individual Gaussian
    mesh.raycast = (raycaster, intersects) => {
      const inverse = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
      const ray = raycaster.ray.clone().applyMatrix4(inverse);
      const hit = ray.intersectBox(box, new THREE.Vector3());
      if (!hit) return;
      const point = hit.clone().applyMatrix4(mesh.matrixWorld);
      intersects.push({ distance: raycaster.ray.origin.distanceTo(point), point, object: mesh });
    };
    const ownDispose = mesh.dispose.bind(mesh);
    const meshes = this.meshes;
    (mesh as unknown as { isPrismSplat: boolean }).isPrismSplat = true;
    mesh.dispose = () => {
      meshes.delete(mesh);
      mesh.removeFromParent();
      ownDispose();
    };
    this.meshes.add(mesh);
    void spark;

    const count = mesh.numSplats ?? mesh.packedSplats?.numSplats ?? inspected.gaussianCount;
    this.stats_.push({
      assetId,
      format: info.format,
      gaussianCount: count,
      loadMs: Math.round(performance.now() - started),
      estimatedGpuBytes: count * 16,
    });
    return mesh;
  }

  /**
   * Runs one synchronous render (`render`) with the splat draw order sorted from ONE isolated camera. Spark sorts
   * asynchronously, and for the viewport camera, so a master frame / previs frame cannot simply draw: this sorts a
   * dedicated viewpoint from the production pose first, makes Spark display it for exactly the render, and then
   * gives the viewport its own viewpoint back. With no splat in the scene it just runs `render`.
   */
  async renderFromCamera<T>(camera: THREE.Camera, render: () => T): Promise<T> {
    if (this.meshes.size === 0) return render(); // no splat in the scene: nothing to sort
    const scene = this.options.scene();
    const spark = this.spark;
    if (!scene || !spark) return render();
    camera.updateMatrixWorld(true);
    const viewpoint = spark.newViewpoint({ autoUpdate: false });
    try {
      await Promise.race([
        viewpoint.prepare({ scene, camera, update: true, forceOrigin: false }),
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new SplatLoadError("Sorting the splat took too long.", "gpu")),
            PREPARE_TIMEOUT_MS,
          ),
        ),
      ]);
      // Spark's prepare() takes one extra reference on the accumulator it sorts that only its own render-target path
      // gives back. Return it, or every capture would leak an accumulator until none could be allocated.
      const sorted = viewpoint.display?.accumulator;
      if (sorted) spark.releaseAccumulator(sorted);
      spark.prepareViewpoint(viewpoint);
      return render(); // synchronous: nothing can re-point Spark between the sort and the draw
    } finally {
      spark.prepareViewpoint(spark.defaultView);
      viewpoint.dispose();
    }
  }

  /** Remove the splat renderer from the scene and free everything this runtime still owns. */
  dispose() {
    this.disposed = true;
    for (const mesh of [...this.meshes]) mesh.dispose();
    this.meshes.clear();
    if (this.spark) {
      this.spark.removeFromParent();
      this.spark.material?.dispose();
      this.spark.geometry?.dispose();
      this.spark = null;
    }
  }
}

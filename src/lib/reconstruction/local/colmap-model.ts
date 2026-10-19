import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { LocalReconstructionError } from "./types";

/**
 * Reader for COLMAP's binary sparse model (`cameras.bin`, `images.bin`, `points3D.bin`), as written by COLMAP 4.2.1
 * (`src/colmap/scene/reconstruction_io_binary.cc` @ bd1fcf6). Everything is little-endian:
 *
 *   cameras.bin   u64 n; n × { camera_id u32, model_id i32, width u64, height u64, params f64[numParams(model)] }
 *   images.bin    u64 n (REGISTERED images only); n × { image_id u32, qw qx qy qz tx ty tz f64, camera_id u32,
 *                 name NUL-terminated, u64 nPoints2D, nPoints2D × { x f64, y f64, point3D_id u64 } }
 *   points3D.bin  u64 n; n × { id u64, xyz f64×3, rgb u8×3, error f64, u64 trackLength,
 *                 trackLength × { image_id u32, point2D_idx u32 } }
 *
 * Used to VALIDATE a reconstruction (COLMAP's exit code alone proves nothing) and to choose among several models.
 * Every record is bounds-checked; a short or inconsistent file is refused, never half-read.
 */

/** COLMAP camera model ids 0-10 and their parameter counts (sensor/models.h); Brush accepts exactly these. */
export const CAMERA_MODELS: Record<number, { name: string; params: number }> = {
  0: { name: "SIMPLE_PINHOLE", params: 3 },
  1: { name: "PINHOLE", params: 4 },
  2: { name: "SIMPLE_RADIAL", params: 4 },
  3: { name: "RADIAL", params: 5 },
  4: { name: "OPENCV", params: 8 },
  5: { name: "OPENCV_FISHEYE", params: 8 },
  6: { name: "FULL_OPENCV", params: 12 },
  7: { name: "FOV", params: 5 },
  8: { name: "SIMPLE_RADIAL_FISHEYE", params: 4 },
  9: { name: "RADIAL_FISHEYE", params: 5 },
  10: { name: "THIN_PRISM_FISHEYE", params: 12 },
};

const MAX_MODEL_FILE_BYTES = 1024 * 1024 * 1024;

export interface SparseCamera {
  id: number;
  model: string;
  width: number;
  height: number;
  params: number[];
}

export interface SparseImage {
  id: number;
  cameraId: number;
  name: string;
  /** observations that triangulated to a 3D point */
  triangulated: number;
}

export interface SparseModel {
  dir: string;
  cameras: SparseCamera[];
  images: SparseImage[];
  points: number;
}

class Cursor {
  private o = 0;
  private readonly v: DataView;
  constructor(
    private readonly b: Uint8Array,
    private readonly file: string,
  ) {
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  private need(n: number) {
    if (this.o + n > this.b.length) throw bad(`${this.file} is truncated.`);
  }
  u8() {
    this.need(1);
    return this.v.getUint8(this.o++);
  }
  u32() {
    this.need(4);
    const x = this.v.getUint32(this.o, true);
    this.o += 4;
    return x;
  }
  i32() {
    this.need(4);
    const x = this.v.getInt32(this.o, true);
    this.o += 4;
    return x;
  }
  /** u64 as a JS number; refuses values that cannot be exact */
  u64() {
    this.need(8);
    const x = this.v.getBigUint64(this.o, true);
    this.o += 8;
    if (x > BigInt(Number.MAX_SAFE_INTEGER)) throw bad(`${this.file} has an out-of-range count.`);
    return Number(x);
  }
  rawU64() {
    this.need(8);
    const x = this.v.getBigUint64(this.o, true);
    this.o += 8;
    return x;
  }
  f64() {
    this.need(8);
    const x = this.v.getFloat64(this.o, true);
    this.o += 8;
    return x;
  }
  skip(n: number) {
    this.need(n);
    this.o += n;
  }
  cstring(max = 4096) {
    const end = this.b.indexOf(0, this.o);
    if (end < 0 || end - this.o > max) throw bad(`${this.file} has an unterminated image name.`);
    const s = new TextDecoder("utf-8").decode(this.b.subarray(this.o, end));
    this.o = end + 1;
    return s;
  }
  done() {
    if (this.o !== this.b.length) throw bad(`${this.file} has trailing data.`);
  }
}

const bad = (message: string) =>
  new LocalReconstructionError("colmap_failed", message, "camera_reconstruction");

const INVALID_POINT = 0xffffffffffffffffn;

async function load(file: string): Promise<Uint8Array> {
  const s = await stat(file).catch(() => null);
  if (!s || !s.isFile()) throw bad(`${path.basename(file)} is missing from the sparse model.`);
  if (s.size > MAX_MODEL_FILE_BYTES) throw bad(`${path.basename(file)} is unexpectedly large.`);
  return new Uint8Array(await readFile(file));
}

/** Parses one sparse model directory (`…/sparse/N`). */
export async function readSparseModel(dir: string): Promise<SparseModel> {
  const cams = new Cursor(await load(path.join(dir, "cameras.bin")), "cameras.bin");
  const cameras: SparseCamera[] = [];
  for (let i = 0, n = cams.u64(); i < n; i++) {
    const id = cams.u32();
    const modelId = cams.i32();
    const model = CAMERA_MODELS[modelId];
    if (!model) throw bad(`Camera ${id} uses an unsupported COLMAP camera model (${modelId}).`);
    const width = cams.u64();
    const height = cams.u64();
    const params = Array.from({ length: model.params }, () => cams.f64());
    if (!params.every(Number.isFinite) || width <= 0 || height <= 0) throw bad(`Camera ${id} is not valid.`);
    cameras.push({ id, model: model.name, width, height, params });
  }
  cams.done();

  const imgs = new Cursor(await load(path.join(dir, "images.bin")), "images.bin");
  const images: SparseImage[] = [];
  for (let i = 0, n = imgs.u64(); i < n; i++) {
    const id = imgs.u32();
    const pose = Array.from({ length: 7 }, () => imgs.f64());
    if (!pose.every(Number.isFinite)) throw bad(`Image ${id} has a non-finite pose.`);
    const cameraId = imgs.u32();
    if (!cameras.some((c) => c.id === cameraId)) throw bad(`Image ${id} refers to an unknown camera.`);
    const name = imgs.cstring();
    const nPts = imgs.u64();
    let triangulated = 0;
    for (let k = 0; k < nPts; k++) {
      imgs.skip(16);
      if (imgs.rawU64() !== INVALID_POINT) triangulated++;
    }
    images.push({ id, cameraId, name, triangulated });
  }
  imgs.done();

  const pts = new Cursor(await load(path.join(dir, "points3D.bin")), "points3D.bin");
  const points = pts.u64();
  for (let i = 0; i < points; i++) {
    pts.skip(8);
    const xyz = [pts.f64(), pts.f64(), pts.f64()];
    if (!xyz.every(Number.isFinite)) throw bad(`3D point ${i} is not finite.`);
    pts.skip(3 + 8);
    pts.skip(pts.u64() * 8);
  }
  pts.done();
  return { dir, cameras, images, points };
}

/** Every numbered model under `sparse/` (COLMAP writes 0, 1, 2, … as models finish). */
export async function listSparseModels(sparseRoot: string): Promise<string[]> {
  const entries = await readdir(sparseRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && /^\d{1,4}$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => Number(a) - Number(b));
}

/**
 * Chooses ONE model deterministically: the most registered images, then the most 3D points, then the lowest model
 * number. Never "directory 0" by default. Unreadable models are reported, not silently skipped.
 */
export async function selectSparseModel(sparseRoot: string): Promise<{
  chosen: SparseModel & { name: string };
  discovered: Array<{ name: string; registeredImages: number; points: number; error?: string }>;
}> {
  const names = await listSparseModels(sparseRoot);
  if (names.length === 0)
    throw new LocalReconstructionError(
      "insufficient_camera_registration",
      "COLMAP did not produce any sparse model (no camera poses could be recovered from these photographs).",
      "camera_reconstruction",
    );
  const discovered: Array<{ name: string; registeredImages: number; points: number; error?: string }> = [];
  let best: (SparseModel & { name: string }) | null = null;
  for (const name of names) {
    try {
      const m = await readSparseModel(path.join(sparseRoot, name));
      discovered.push({ name, registeredImages: m.images.length, points: m.points });
      if (
        !best ||
        m.images.length > best.images.length ||
        (m.images.length === best.images.length && m.points > best.points)
      )
        best = { ...m, name };
    } catch (e) {
      discovered.push({ name, registeredImages: 0, points: 0, error: (e as Error).message.slice(0, 200) });
    }
  }
  if (!best) throw bad("No sparse model COLMAP produced could be read.");
  return { chosen: best, discovered };
}

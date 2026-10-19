import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { colmapCommands, runColmap } from "../colmap";
import { readSparseModel, selectSparseModel } from "../colmap-model";
import { LocalReconstructionError } from "../types";
import { fakeColmap } from "./fake-tools";
import { jpegBytes, tempDir } from "./fixtures";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

async function setup(images = 5) {
  const t = await tempDir();
  cleanups.push(t.cleanup);
  const imageDir = path.join(t.dir, "input");
  const colmapDir = path.join(t.dir, "colmap");
  await mkdir(imageDir);
  await mkdir(colmapDir);
  for (let i = 0; i < images; i++)
    await writeFile(path.join(imageDir, `${String(i + 1).padStart(6, "0")}.jpg`), jpegBytes(i));
  return { root: t.dir, imageDir, colmapDir, datasetDir: path.join(t.dir, "brush", "dataset"), images };
}

const run = (
  s: Awaited<ReturnType<typeof setup>>,
  mode: string,
  extra: Partial<Parameters<typeof runColmap>[0]> = {},
) =>
  runColmap({
    tool: fakeColmap(mode, { FAKE_COLMAP_RECORD: path.join(s.root, "calls.jsonl") }),
    imageDir: s.imageDir,
    colmapDir: s.colmapDir,
    datasetDir: s.datasetDir,
    inputImages: s.images,
    timeoutMs: 60_000,
    ...extra,
  });

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof LocalReconstructionError ? e.code : `other: ${(e as Error).message}`),
  );

describe("COLMAP command contract (4.2.1 CPU pipeline)", () => {
  it("builds the four audited commands: CPU SIFT, exhaustive CPU matching, incremental mapper, COLMAP-format undistortion", () => {
    const p = {
      imageDir: path.resolve("/w/r/input"),
      colmapDir: path.resolve("/w/r/colmap"),
      datasetDir: path.resolve("/w/r/brush/dataset"),
    };
    const c = colmapCommands(p, path.resolve("/w/r/colmap/sparse/1"));
    expect(c.featureExtractor).toEqual([
      "feature_extractor",
      "--database_path",
      path.join(p.colmapDir, "database.db"),
      "--image_path",
      p.imageDir,
      "--ImageReader.camera_model",
      "SIMPLE_RADIAL",
      "--ImageReader.single_camera",
      "0",
      "--FeatureExtraction.use_gpu",
      "0",
    ]);
    expect(c.matcher).toEqual([
      "exhaustive_matcher",
      "--database_path",
      path.join(p.colmapDir, "database.db"),
      "--FeatureMatching.use_gpu",
      "0",
    ]);
    expect(c.mapper).toEqual([
      "mapper",
      "--database_path",
      c.db,
      "--image_path",
      p.imageDir,
      "--output_path",
      c.sparse,
    ]);
    expect(c.undistorter).toEqual([
      "image_undistorter",
      "--image_path",
      p.imageDir,
      "--input_path",
      path.resolve("/w/r/colmap/sparse/1"),
      "--output_path",
      p.datasetDir,
      "--output_type",
      "COLMAP",
    ]);
    // nothing that can download or run dense steps is ever constructed
    const all = JSON.stringify(c);
    for (const banned of [
      "automatic_reconstructor",
      "vocab_tree",
      "loop_detection",
      "ALIKED",
      "LIGHTGLUE",
      "patch_match",
      'use_gpu","1',
    ])
      expect(all).not.toContain(banned);
  });
});

describe("COLMAP runs (fake colmap.exe as a real child process; real binary model reader)", () => {
  it("success: validated sparse model, metrics, and a PINHOLE undistorted dataset for Brush", async () => {
    const s = await setup(5);
    const steps: string[] = [];
    const { metrics, datasetDir } = await run(s, "success", { onStep: (x) => steps.push(x) });
    expect(steps).toEqual(["feature_extraction", "matching", "mapping", "undistortion"]);
    expect(metrics).toMatchObject({
      inputImages: 5,
      registeredImages: 5,
      registrationRatio: 1,
      sparsePoints: 500,
      cameraCount: 1,
      chosenModel: "0",
    });
    const undist = await readSparseModel(path.join(datasetDir, "sparse"));
    expect(undist.cameras.map((c) => c.model)).toEqual(["PINHOLE"]);
    expect(undist.images.map((i) => i.name)).toEqual([
      "000001.jpg",
      "000002.jpg",
      "000003.jpg",
      "000004.jpg",
      "000005.jpg",
    ]);
    expect(undist.images[0]!.triangulated).toBe(2); // the invalid point3D_id is not counted
    const calls = (await readFile(path.join(s.root, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l)[0]);
    expect(calls).toEqual(["feature_extractor", "exhaustive_matcher", "mapper", "image_undistorter"]);
  });

  it("several models: chooses the one with the MOST registered images (not directory 0), then the most points", async () => {
    const s = await setup(6);
    const { metrics } = await run(s, "multi");
    expect(metrics.chosenModel).toBe("1");
    expect(metrics.modelsDiscovered).toEqual([
      { name: "0", registeredImages: 2, points: 50 },
      { name: "1", registeredImages: 6, points: 300 },
    ]);
    const t = await setup(4);
    expect((await run(t, "tie")).metrics.chosenModel).toBe("1");
    const sel = await selectSparseModel(path.join(t.colmapDir, "sparse"));
    expect(sel.chosen.points).toBe(400);
  });

  it("too few registered images is a failure, never 'a room'", async () => {
    const s = await setup(5);
    const err = (await run(s, "few").catch((e) => e)) as LocalReconstructionError;
    expect(err.code).toBe("insufficient_camera_registration");
    expect(err.message).toMatch(/Only 2 of 5/);
  });

  it("normalizes failures: no model, corrupt model, failed or SILENT extraction, cancel, timeout", async () => {
    expect(await code(run(await setup(), "no_model"))).toBe("insufficient_camera_registration");
    expect(await code(run(await setup(), "corrupt"))).toBe("colmap_failed");
    expect(await code(run(await setup(), "extract_fails"))).toBe("colmap_failed");
    expect(await code(run(await setup(), "silent_extract"))).toBe("colmap_failed"); // exit 0 proves nothing
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    expect(await code(run(await setup(), "slow_mapper", { signal: ac.signal }))).toBe("cancelled");
    expect(await code(run(await setup(), "slow_mapper", { timeoutMs: 1500 }))).toBe("timeout");
  }, 60_000);
});

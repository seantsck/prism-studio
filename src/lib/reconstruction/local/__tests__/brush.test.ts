import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  boundedDiagnostic,
  brushArgs,
  brushIteration,
  expectedExportName,
  runBrush,
  verifyBrushDataset,
} from "../brush";
import { inspectGaussianPlyFile } from "../ply";
import { LocalReconstructionError } from "../types";
import { fakeBrush } from "./fake-tools";
import { tempDir } from "./fixtures";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});
async function dir() {
  const t = await tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

/** An undistorted COLMAP dataset as image_undistorter lays it out (file contents are irrelevant to Brush's fake). */
async function dataset(root: string, extra: Record<string, string> = {}) {
  const d = path.join(root, "dataset");
  await mkdir(path.join(d, "images"), { recursive: true });
  await mkdir(path.join(d, "sparse"), { recursive: true });
  for (const n of ["000001.jpg", "000002.jpg", "000003.jpg"]) await writeFile(path.join(d, "images", n), "x");
  for (const n of ["cameras.bin", "images.bin", "points3D.bin"])
    await writeFile(path.join(d, "sparse", n), "x");
  for (const [rel, body] of Object.entries(extra)) {
    await mkdir(path.dirname(path.join(d, rel)), { recursive: true });
    await writeFile(path.join(d, rel), body);
  }
  return d;
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof LocalReconstructionError ? e.code : `other: ${(e as Error).message}`),
  );

describe("Brush command contract (v0.3.0)", () => {
  it("builds a fixed, allow-listed argv: local dataset path, headless, absolute export dir outside the dataset", () => {
    const ds = path.resolve("/w/run/brush/dataset");
    const ex = path.resolve("/w/run/brush/exports");
    expect(brushArgs(ds, ex, "standard")).toEqual([
      ds,
      "--total-steps",
      "30000",
      "--max-splats",
      "1000000",
      "--sh-degree",
      "3",
      "--seed",
      "42",
      "--export-every",
      "30000",
      "--export-path",
      ex,
      "--export-name",
      "prism_export_{iter}.ply",
    ]);
    expect(brushArgs(ds, ex, "standard")).not.toContain("--with-viewer");
    expect(expectedExportName("standard")).toBe("prism_export_30000.ply");
    expect(() => brushArgs("relative", ex, "standard")).toThrow(/absolute/);
    expect(() => brushArgs(ds, ex, "draft")).toThrow(/not available yet/);
    expect(() => brushArgs(ds, ex, "high")).toThrow(/not available yet/);
  }, 60_000);

  it("guards Brush's dataset discovery: exactly one model, images present, no stray PLY or second model", async () => {
    const root = await dir();
    expect(await verifyBrushDataset(await dataset(root))).toEqual({ images: 3 });
    const bad: Array<Record<string, string>> = [
      { "sparse/0/cameras.bin": "x", "sparse/0/images.bin": "x" }, // a second model
      { "init.ply": "ply" }, // would hijack initialisation
      { "stereo/fused.ply": "ply" },
      { "sparse/cameras.txt": "x" },
      { "transforms.json": "{}" },
    ];
    for (const [i, extra] of bad.entries()) {
      const r = await dir();
      expect([i, await code(verifyBrushDataset(await dataset(r, extra)))]).toEqual([i, "brush_failed"]);
    }
    const noImages = await dir();
    const d = await dataset(noImages);
    const { rm } = await import("node:fs/promises");
    await rm(path.join(d, "images"), { recursive: true });
    expect(await code(verifyBrushDataset(d))).toBe("brush_failed");
  }, 60_000);

  it("parses exact training iterations and redacts paths in bounded diagnostics", () => {
    expect(brushIteration("[ts INFO  brush_process] Refine iter 15000, 45000 splats.")).toBe(15000);
    expect(brushIteration("Eval iter 1000: PSNR 25.1, ssim 0.8")).toBe(1000);
    expect(brushIteration("Loaded dataset with 3 training views")).toBeNull();
    const d = boundedDiagnostic(
      "Error: failed at C:\\Users\\alice\\photos\\x.jpg and /home/alice/p/y.jpg\n".repeat(40),
    );
    expect(d).not.toMatch(/alice/);
    expect(d.split("\n").length).toBeLessThanOrEqual(12);
    expect(d.length).toBeLessThanOrEqual(1200);
  }, 60_000);
});

describe("Brush runs (fake brush_app as a real child process)", () => {
  it("trains, then the PLY is checked to EXIST and is read by the production PLY reader (alphabetical property order)", async () => {
    const root = await dir();
    const exports = path.join(root, "exports");
    const iterations: number[] = [];
    const { plyPath } = await runBrush({
      tool: fakeBrush(),
      datasetDir: await dataset(root),
      exportDir: exports,
      quality: "standard",
      timeoutMs: 30_000,
      onIteration: (it, total) => {
        expect(total).toBe(30000);
        iterations.push(it);
      },
    });
    expect(path.basename(plyPath)).toBe("prism_export_30000.ply");
    expect(path.dirname(plyPath)).toBe(exports);
    expect(iterations).toEqual([200, 15000, 30000]);
    const info = await inspectGaussianPlyFile(plyPath);
    expect(info).toMatchObject({ vertexCount: 64, shDegree: 3 });
    expect(info.properties[0]!.name).toBe("f_dc_0"); // Brush's BTreeMap order, mapped by name
  }, 60_000);

  it("normalizes failures: no GPU adapter, out of memory, generic failure, exit 0 without a PLY, cancel, timeout", async () => {
    const cases: Array<[string, string]> = [
      ["no_adapter", "gpu_unavailable"],
      ["oom", "out_of_memory"],
      ["fail", "brush_failed"],
      ["no_export", "ply_missing"],
    ];
    for (const [mode, want] of cases) {
      const root = await dir();
      const err = await runBrush({
        tool: fakeBrush(mode),
        datasetDir: await dataset(root),
        exportDir: path.join(root, "exports"),
        quality: "standard",
        timeoutMs: 30_000,
      }).catch((e: LocalReconstructionError) => e);
      expect([mode, (err as LocalReconstructionError).code]).toEqual([mode, want]);
      expect((err as LocalReconstructionError).stage).toBe("splat_training");
      expect((err as LocalReconstructionError).diagnostic ?? "").not.toMatch(/someone|secret/);
    }
    const root = await dir();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    expect(
      await code(
        runBrush({
          tool: fakeBrush("slow"),
          datasetDir: await dataset(root),
          exportDir: path.join(root, "e1"),
          quality: "standard",
          timeoutMs: 30_000,
          signal: ac.signal,
        }),
      ),
    ).toBe("cancelled");
    expect(
      await code(
        runBrush({
          tool: fakeBrush("slow"),
          datasetDir: path.join(root, "dataset"),
          exportDir: path.join(root, "e2"),
          quality: "standard",
          timeoutMs: 300,
        }),
      ),
    ).toBe("timeout");
  }, 60_000);

  it("a PLY Brush wrote but that is invalid is refused by validation (exit code 0 proves nothing)", async () => {
    const root = await dir();
    const { plyPath } = await runBrush({
      tool: fakeBrush("bad_ply"),
      datasetDir: await dataset(root),
      exportDir: path.join(root, "exports"),
      quality: "standard",
      timeoutMs: 30_000,
    });
    expect(await code(inspectGaussianPlyFile(plyPath))).toBe("ply_invalid");
  }, 60_000);
});

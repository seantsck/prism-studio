import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SpzReader } from "@sparkjsdev/spark";
import { afterEach, describe, expect, it } from "vitest";
import { inspectSplat } from "@/lib/splat/inspect";
import { UNVERIFIED_MESSAGE } from "../colmap-provenance";
import { DEFAULT_ENGINE_LIMITS, runLocalReconstruction, type RunOptions } from "../engine";
import { resolveExecutable } from "../resolve";
import { probeLocalToolchain } from "../toolchain";
import {
  LocalReconstructionError,
  type LocalReconstructionProgress,
  type LocalReconstructionRequest,
} from "../types";
import { fakeMachine, type FakeMachineOptions } from "./fake-machine";
import { fakeBrush, fakeColmap } from "./fake-tools";
import { jpegBytes, PNG_BYTES, tempDir } from "./fixtures";

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

// ───────────────────────── toolchain probe ─────────────────────────

/** A machine layout: tool binaries (dummies; the fakes run in their place), a provenance manifest, a SystemRoot. */
const machine = async (o: FakeMachineOptions = {}) => fakeMachine(await dir(), o);

const probe = (
  m: Awaited<ReturnType<typeof machine>>,
  env: Record<string, string | undefined>,
  modes: { colmap?: string; brush?: string } = {},
) =>
  probeLocalToolchain({
    platform: "win32",
    env: { SystemRoot: m.sysRoot, ...env },
    commandFor: (tool) =>
      tool === "colmap" ? fakeColmap(modes.colmap ?? "success") : fakeBrush(modes.brush ?? "success"),
  });

describe("local toolchain probe (provenance policy)", () => {
  it("READY only with a VERIFIED operator-built COLMAP, a supported Brush and a Vulkan loader", async () => {
    const m = await machine();
    const r = await probe(m, {
      PRISM_COLMAP_PATH: m.colmapExe,
      PRISM_COLMAP_PROVENANCE_PATH: m.manifestPath,
      PRISM_BRUSH_PATH: m.brushExe,
    });
    expect(r.colmap).toMatchObject({
      installed: true,
      source: "configured",
      version: "4.2.1",
      provenance: "verified",
      compatible: true,
    });
    expect(r.brush).toMatchObject({ installed: true, version: "0.3.0", compatible: true });
    expect(r.gpu).toMatchObject({ backend: "vulkan", loaderPresent: true });
    expect(r.overall).toBe("ready");
    expect(r.commands.colmap).not.toBeNull();
  }, 60_000);

  it("an installed COLMAP without provenance (official archive, PATH binary) is UNVERIFIED and never makes it ready", async () => {
    const m = await machine({ manifest: false });
    const viaPath = await probe(m, { PATH: `${m.bin};relative\\dir;.`, PRISM_BRUSH_PATH: m.brushExe });
    expect(viaPath.colmap).toMatchObject({
      installed: true,
      source: "path",
      provenance: "unverified",
      compatible: false,
    });
    expect(viaPath.colmap.reason).toContain(UNVERIFIED_MESSAGE);
    expect(viaPath.overall).toBe("incomplete");
    expect(viaPath.commands).toEqual({ colmap: null, brush: null });
    const configured = await probe(m, { PRISM_COLMAP_PATH: m.colmapExe, PRISM_BRUSH_PATH: m.brushExe });
    expect(configured.colmap.provenance).toBe("unverified");
    expect(configured.overall).toBe("incomplete");
  }, 60_000);

  it("refuses unsupported versions and launchers instead of guessing their semantics", async () => {
    const m = await machine();
    const env = {
      PRISM_COLMAP_PATH: m.colmapExe,
      PRISM_COLMAP_PROVENANCE_PATH: m.manifestPath,
      PRISM_BRUSH_PATH: m.brushExe,
    };
    expect((await probe(m, env, { colmap: "wrong_version" })).colmap).toMatchObject({
      provenance: "incompatible",
      version: "4.1.1",
    });
    const b = await probe(m, env, { brush: "wrong_version" });
    expect(b.brush).toMatchObject({ version: "0.4.0", compatible: false });
    expect(b.overall).toBe("incompatible");
    const bat = path.join(m.bin, "COLMAP.bat");
    await writeFile(bat, "@echo off");
    expect((await probe(m, { ...env, PRISM_COLMAP_PATH: bat })).colmap).toMatchObject({
      installed: false,
      provenance: "incompatible",
    });
    expect((await probe(m, { ...env, PRISM_COLMAP_PATH: "colmap.exe" })).colmap.reason).toMatch(/absolute/);
  }, 60_000);

  it("missing tools and a missing Vulkan loader are reported truthfully (incomplete, never faked)", async () => {
    const m = await machine({ vulkan: false });
    const r = await probe(m, { PATH: "" });
    expect(r.colmap).toMatchObject({ installed: false, provenance: "missing" });
    expect(r.brush).toMatchObject({ installed: false, compatible: false });
    expect(r.overall).toBe("incomplete");
    const v = await probe(m, {
      PRISM_COLMAP_PATH: m.colmapExe,
      PRISM_COLMAP_PROVENANCE_PATH: m.manifestPath,
      PRISM_BRUSH_PATH: m.brushExe,
    });
    expect(v.gpu.loaderPresent).toBe(false);
    expect(v.overall).toBe("incomplete");
  }, 60_000);

  it("PATH search never uses relative entries (the current directory) and accepts only .exe on Windows", async () => {
    const m = await machine();
    expect(
      await resolveExecutable({
        configured: undefined,
        envVar: "X",
        names: ["colmap"],
        pathEnv: ".;bin;",
        platform: "win32",
      }),
    ).toMatchObject({
      status: "missing",
    });
    expect(
      await resolveExecutable({
        configured: undefined,
        envVar: "X",
        names: ["colmap"],
        pathEnv: `.;${m.bin}`,
        platform: "win32",
      }),
    ).toMatchObject({ status: "found", source: "path" });
  }, 60_000);
});

// ───────────────────────── the orchestrator (key acceptance) ─────────────────────────

const toolchain = (colmap = "success", brush = "success"): RunOptions["toolchain"] => ({
  colmap: fakeColmap(colmap),
  brush: fakeBrush(brush),
  versions: { colmap: "4.2.1 (bd1fcf6, verified)", brush: "0.3.0" },
});
const request = (runId: string, n = 3): LocalReconstructionRequest => ({
  runId,
  quality: "standard",
  inputs: Array.from({ length: n }, (_, i) => ({
    ordinal: i,
    source: { kind: "bytes" as const, bytes: i === 1 ? PNG_BYTES : jpegBytes(i) },
    checksum: null,
    mime: i === 1 ? "image/png" : "image/jpeg",
  })),
});
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => ({ code: "ok", stage: null as string | null }),
    (e: unknown) =>
      e instanceof LocalReconstructionError
        ? { code: e.code, stage: e.stage }
        : { code: `other: ${(e as Error).message}`, stage: null },
  );

describe("runLocalReconstruction: synthetic photos → fake COLMAP → fake Brush → REAL PLY parser → REAL SPZ converter → inspectSplat", () => {
  it("produces a validated SPZ that Spark's own reader decodes, with checksums and a local provenance manifest", async () => {
    const root = await dir();
    const events: LocalReconstructionProgress[] = [];
    const r = await runLocalReconstruction(request("run-ok"), {
      toolchain: toolchain(),
      workRoot: root,
      onProgress: (p) => events.push(p),
    });
    // the result
    expect(r).toMatchObject({ runId: "run-ok", format: "spz", gaussianCount: 64 });
    expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
    const bytes = await readFile(r.spzPath);
    expect(bytes.length).toBe(r.byteSize);
    expect(inspectSplat(bytes, "x.spz")).toMatchObject({ ok: true, gaussianCount: 64 });
    const reader = new SpzReader({ fileBytes: bytes });
    await reader.parseHeader();
    expect({ v: reader.version, n: reader.numSplats, sh: reader.shDegree }).toEqual({ v: 3, n: 64, sh: 3 });
    // provenance
    expect(r.metadata).toMatchObject({
      quality: "standard",
      tools: {
        colmap: "4.2.1 (bd1fcf6, verified)",
        brush: "0.3.0",
        spzEncoder: "@sparkjsdev/spark@0.1.10 SpzWriter",
      },
      colmap: {
        settings: { cameraModel: "SIMPLE_RADIAL", matching: "exhaustive", featureGpu: false },
        metrics: { inputImages: 3, registeredImages: 3, chosenModel: "0" },
      },
      brush: { settings: { "total-steps": 30000, "sh-degree": 3 } },
      ply: { gaussianCount: 64, shDegree: 3 },
      spz: { lossless: false, shDegreeIn: 3, shDegreeOut: 3, shReduced: false, clamped: { positions: 0 } },
    });
    const manifest = JSON.parse(await readFile(r.manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      schema: "prism.local-reconstruction-run.v1",
      status: "succeeded",
      runId: "run-ok",
    });
    expect(manifest.inputs.map((i: { fileName: string }) => i.fileName)).toEqual([
      "000001.jpg",
      "000002.png",
      "000003.jpg",
    ]);
    expect(manifest.inputs.every((i: { checksum: string }) => /^[0-9a-f]{64}$/.test(i.checksum))).toBe(true);
    expect(manifest.metadata.ply.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain(root); // relative names only, no machine paths
    // retention: output, logs and manifest kept for ingestion; intermediates removed
    const runDir = path.dirname(r.manifestPath);
    expect((await readdir(runDir)).sort()).toEqual(["logs", "manifest.json", "output"]);
    expect((await readdir(path.join(runDir, "output"))).sort()).toEqual(["splat.ply", "splat.spz"]);
    const log = await readFile(path.join(runDir, "logs", "run.log"), "utf8");
    expect(log).toMatch(/camera_reconstruction\tcolmap\tstep feature_extraction/);
    expect(log).toMatch(/splat_training\tbrush\t/);
    // progress: the explicit stages, in order, monotone, ending at 1
    const stages = [...new Set(events.map((e) => e.stage))];
    expect(stages).toEqual([
      "preparing",
      "camera_reconstruction",
      "splat_training",
      "validating_ply",
      "converting_spz",
      "validating_spz",
      "complete",
    ]);
    const ps = events.map((e) => e.progress);
    expect(ps.every((p, i) => i === 0 || p >= ps[i - 1]!)).toBe(true);
    expect(ps.at(-1)).toBe(1);
    expect(events.some((e) => /iteration 15000 of 30000/.test(e.message))).toBe(true);
  }, 120_000);

  it("fails truthfully at each stage and leaves no partial result (logs and a failure manifest are kept)", async () => {
    const root = await dir();
    const few = await outcome(
      runLocalReconstruction(request("f1", 5), { toolchain: toolchain("few"), workRoot: root }),
    );
    expect(few).toEqual({ code: "insufficient_camera_registration", stage: "camera_reconstruction" });
    const m = JSON.parse(await readFile(path.join(root, "f1", "manifest.json"), "utf8"));
    expect(m).toMatchObject({ status: "failed", error: { code: "insufficient_camera_registration" } });
    expect((await readdir(path.join(root, "f1"))).sort()).toEqual(["logs", "manifest.json"]);

    expect(
      await outcome(
        runLocalReconstruction(request("f2"), { toolchain: toolchain("extract_fails"), workRoot: root }),
      ),
    ).toEqual({
      code: "colmap_failed",
      stage: "camera_reconstruction",
    });
    expect(
      await outcome(
        runLocalReconstruction(request("f3"), { toolchain: toolchain("success", "oom"), workRoot: root }),
      ),
    ).toEqual({
      code: "out_of_memory",
      stage: "splat_training",
    });
    expect(
      await outcome(
        runLocalReconstruction(request("f4"), {
          toolchain: toolchain("success", "no_adapter"),
          workRoot: root,
        }),
      ),
    ).toEqual({
      code: "gpu_unavailable",
      stage: "splat_training",
    });
    expect(
      await outcome(
        runLocalReconstruction(request("f5"), {
          toolchain: toolchain("success", "no_export"),
          workRoot: root,
        }),
      ),
    ).toEqual({
      code: "ply_missing",
      stage: "splat_training",
    });
    expect(
      await outcome(
        runLocalReconstruction(request("f6"), { toolchain: toolchain("success", "bad_ply"), workRoot: root }),
      ),
    ).toEqual({
      code: "ply_invalid",
      stage: "validating_ply",
    });
    // a conversion that cannot fit the bounds → result_too_large, never silently decimated
    expect(
      await outcome(
        runLocalReconstruction(request("f7"), {
          toolchain: toolchain(),
          workRoot: root,
          limits: { ...DEFAULT_ENGINE_LIMITS, maxRawSpzBytes: 1000 },
        }),
      ),
    ).toEqual({ code: "result_too_large", stage: "converting_spz" });
    for (const id of ["f2", "f3", "f4", "f5", "f6", "f7"])
      await expect(stat(path.join(root, id, "output"))).rejects.toThrow();
  }, 180_000);

  it("cancellation at every major stage stops the work, never reports success, and cleans intermediates", async () => {
    const root = await dir();
    const cancelAt = async (
      id: string,
      tc: RunOptions["toolchain"],
      when: (p: LocalReconstructionProgress) => boolean,
    ) => {
      const ac = new AbortController();
      const r = await outcome(
        runLocalReconstruction(request(id), {
          toolchain: tc,
          workRoot: root,
          signal: ac.signal,
          onProgress: (p) => {
            if (when(p)) setTimeout(() => ac.abort(), 200);
          },
        }),
      );
      expect((await readdir(path.join(root, id))).sort()).toEqual(["logs", "manifest.json"]);
      expect(JSON.parse(await readFile(path.join(root, id, "manifest.json"), "utf8")).status).toBe(
        "cancelled",
      );
      return r;
    };
    expect(
      await cancelAt("c1", toolchain("slow_mapper"), (p) => p.stage === "camera_reconstruction"),
    ).toEqual({
      code: "cancelled",
      stage: "camera_reconstruction",
    });
    expect(await cancelAt("c2", toolchain("success", "slow"), (p) => p.stage === "splat_training")).toEqual({
      code: "cancelled",
      stage: "splat_training",
    });
    // abort lands while the converter or the final validation runs: the result is still "cancelled"
    const lateAc = new AbortController();
    const late = await outcome(
      runLocalReconstruction(request("c3"), {
        toolchain: toolchain(),
        workRoot: root,
        signal: lateAc.signal,
        onProgress: (p) => p.stage === "converting_spz" && lateAc.abort(),
      }),
    );
    expect(late.code).toBe("cancelled");
    const lastAc = new AbortController();
    const last = await outcome(
      runLocalReconstruction(request("c4"), {
        toolchain: toolchain(),
        workRoot: root,
        signal: lastAc.signal,
        onProgress: (p) => p.stage === "validating_spz" && lastAc.abort(),
      }),
    );
    expect(last).toEqual({ code: "cancelled", stage: "validating_spz" });
    await expect(stat(path.join(root, "c4", "output"))).rejects.toThrow();
    const pre = new AbortController();
    pre.abort();
    expect(
      (
        await outcome(
          runLocalReconstruction(request("c5"), {
            toolchain: toolchain(),
            workRoot: root,
            signal: pre.signal,
          }),
        )
      ).code,
    ).toBe("cancelled");
  }, 180_000);

  it("enforces the total time limit, refuses undefined profiles and reused run ids, and test retention removes everything", async () => {
    const root = await dir();
    expect(
      (
        await outcome(
          runLocalReconstruction(request("t1"), {
            toolchain: toolchain("slow_mapper"),
            workRoot: root,
            limits: { ...DEFAULT_ENGINE_LIMITS, maxRunMs: 1500 },
          }),
        )
      ).code,
    ).toBe("timeout");
    expect(
      await outcome(
        runLocalReconstruction(
          { ...request("t2"), quality: "draft" },
          { toolchain: toolchain(), workRoot: root },
        ),
      ),
    ).toEqual({
      code: "invalid_inputs",
      stage: "splat_training",
    });
    await expect(stat(path.join(root, "t2"))).rejects.toThrow(); // refused before any workspace was made
    expect(
      (await outcome(runLocalReconstruction(request("t1"), { toolchain: toolchain(), workRoot: root }))).code,
    ).toBe("workspace_failed");
    const ok = await runLocalReconstruction(request("t3"), {
      toolchain: toolchain(),
      workRoot: root,
      retention: "none",
    });
    expect(ok.gaussianCount).toBe(64);
    await expect(stat(path.join(root, "t3"))).rejects.toThrow();
  }, 120_000);
});

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  APPROVED_COLMAP,
  COLMAP_PROVENANCE_SCHEMA,
  hashRuntimeFiles,
  REQUIRED_CMAKE,
  sha256OfFile,
  VERIFIER_VERSION,
} from "../colmap-provenance";

export interface FakeMachineOptions {
  manifest?: boolean;
  vulkan?: boolean;
  brushName?: string;
}

/**
 * TEST-ONLY machine layout under `root`: dummy tool binaries (the M2D.3A fakes run in their place), a REAL provenance
 * manifest for the dummy colmap.exe (so the production verifier re-hashes it and says VERIFIED), and a SystemRoot
 * with or without a Vulkan loader. Nothing here is a real tool.
 */
export async function fakeMachine(root: string, o: FakeMachineOptions = {}) {
  const bin = path.join(root, "colmap", "bin");
  const brushDir = path.join(root, "brush");
  await mkdir(bin, { recursive: true });
  await mkdir(brushDir, { recursive: true });
  const colmapExe = path.join(bin, "colmap.exe");
  await writeFile(colmapExe, "MZ operator-built colmap");
  await writeFile(path.join(bin, "cholmod.dll"), "dll");
  const brushExe = path.join(brushDir, o.brushName ?? "brush_app.exe");
  await writeFile(brushExe, "MZ brush");
  const sysRoot = path.join(root, "Windows");
  await mkdir(path.join(sysRoot, "System32"), { recursive: true });
  if (o.vulkan !== false) await writeFile(path.join(sysRoot, "System32", "vulkan-1.dll"), "loader");
  const manifestPath = path.join(root, "colmap.provenance.json");
  if (o.manifest !== false)
    await writeFile(
      manifestPath,
      JSON.stringify({
        schema: COLMAP_PROVENANCE_SCHEMA,
        tool: "colmap",
        version: APPROVED_COLMAP.version,
        sourceCommit: APPROVED_COLMAP.commit,
        worktreeClean: true,
        binary: {
          fileName: "colmap.exe",
          sha256: await sha256OfFile(colmapExe),
          byteSize: (await stat(colmapExe)).size,
        },
        runtimeFiles: await hashRuntimeFiles(bin),
        cmake: {
          generator: "Ninja",
          flags: { ...REQUIRED_CMAKE },
          compiler: { id: "MSVC", version: "19.44" },
          architecture: "x64",
        },
        linkCheck: { method: "ninja", forbiddenAbsent: true },
        runtimeChecks: {
          versionLine: "COLMAP 4.2.1 (Commit bd1fcf6 …)",
          gpuSiftRefused: true,
          mvsCommandsAbsent: true,
        },
        dependencies: [],
        copyleftComponents: ["suitesparse-cholmod (LGPL-2.1+)"],
        verifiedAt: "2026-10-19T00:00:00Z",
        verifier: VERIFIER_VERSION,
      }),
    );
  return { root, bin, colmapExe, brushExe, sysRoot, manifestPath };
}

/** The tool environment for a fake machine: what an operator would set in .env.local. */
export const machineEnv = (m: Awaited<ReturnType<typeof fakeMachine>>) => ({
  SystemRoot: m.sysRoot,
  PRISM_COLMAP_PATH: m.colmapExe,
  PRISM_COLMAP_PROVENANCE_PATH: m.manifestPath,
  PRISM_BRUSH_PATH: m.brushExe,
});

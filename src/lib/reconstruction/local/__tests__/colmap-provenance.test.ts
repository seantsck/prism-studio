import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPROVED_COLMAP,
  checkBuildDescription,
  checkColmapProvenance,
  parseCMakeCache,
  parseVcpkgStatus,
  readGitHead,
  REQUIRED_CMAKE,
  UNVERIFIED_MESSAGE,
  verifyColmapBuild,
  writeColmapProvenance,
  type ColmapProvenance,
} from "../colmap-provenance";
import type { ToolCommand } from "../process";
import { fakeColmap, fakeGit } from "./fake-tools";
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

const STATUS = `Package: ceres
Version: 2.2.0
Port-Version: 6
Architecture: x64-windows
Status: install ok installed

Package: ceres
Feature: suitesparse
Architecture: x64-windows
Status: install ok installed

Package: suitesparse-cholmod
Version: 5.3.5
Architecture: x64-windows
Status: install ok installed

Package: suitesparse-cholmod
Feature: matrixops
Architecture: x64-windows
Status: install ok installed

Package: suitesparse-spqr
Version: 4.3.6
Architecture: x64-windows
Status: install ok installed

Package: openimageio
Version: 3.1.14.0
Architecture: x64-windows
Status: install ok installed

Package: glew
Version: 2.2.0
Architecture: x64-windows
Status: purge ok not-installed
`;

interface Fixture {
  source: string;
  build: string;
  bin: string;
  exe: string;
}

/** A fake source checkout, CMake build tree and installed binary directory laid out like a real Ninja build. */
async function fixture(
  over: {
    commit?: string;
    cache?: Record<string, string | undefined>;
    ninja?: string;
    status?: string;
  } = {},
): Promise<Fixture> {
  const root = await dir();
  const source = path.join(root, "colmap");
  await mkdir(path.join(source, ".git", "refs", "tags"), { recursive: true });
  await writeFile(path.join(source, ".git", "HEAD"), `${over.commit ?? APPROVED_COLMAP.commit}\n`);
  const build = path.join(root, "build");
  await mkdir(path.join(build, "CMakeFiles", "3.30.2"), { recursive: true });
  await mkdir(path.join(build, "vcpkg_installed", "vcpkg"), { recursive: true });
  const cache: Record<string, string | undefined> = {
    ...REQUIRED_CMAKE,
    CMAKE_GENERATOR: "Ninja",
    ...over.cache,
  };
  await writeFile(
    path.join(build, "CMakeCache.txt"),
    "# This is the CMakeCache file.\n//comment\n" +
      Object.entries(cache)
        .filter(([, v]) => v !== undefined)
        .map(
          ([k, v]) => `${k}:${k === "CMAKE_BUILD_TYPE" || k === "CMAKE_GENERATOR" ? "STRING" : "BOOL"}=${v}`,
        )
        .join("\n") +
      "\n",
  );
  await writeFile(
    path.join(build, "build.ninja"),
    over.ninja ??
      "build src/colmap/exe/colmap.exe: CXX_EXECUTABLE_LINKER__colmap_main_Release src/colmap/exe/CMakeFiles/colmap_main.dir/colmap.cc.obj\n" +
        "  LINK_LIBRARIES = src/colmap/controllers/colmap_controllers.lib src/thirdparty/VLFeat/colmap_vlfeat.lib cholmod.lib ceres.lib\n" +
        "  DEFINES = -DCOLMAP_OPENMP_ENABLED -DNDEBUG\n",
  );
  await writeFile(
    path.join(build, "CMakeFiles", "3.30.2", "CMakeCXXCompiler.cmake"),
    'set(CMAKE_CXX_COMPILER_ID "MSVC")\nset(CMAKE_CXX_COMPILER_VERSION "19.44.35211.0")\nset(MSVC_CXX_ARCHITECTURE_ID x64)\nset(CMAKE_CXX_COMPILER_ARCHITECTURE_ID "x64")\n',
  );
  await writeFile(path.join(build, "vcpkg_installed", "vcpkg", "status"), over.status ?? STATUS);
  const bin = path.join(root, "install", "bin");
  await mkdir(bin, { recursive: true });
  const exe = path.join(bin, "colmap.exe");
  await writeFile(exe, "MZ fake colmap executable bytes");
  await writeFile(path.join(bin, "cholmod.dll"), "fake dll");
  return { source, build, bin, exe };
}

const verify = (f: Fixture, mode = "success", git: ToolCommand | null = fakeGit()) =>
  verifyColmapBuild({
    sourceDir: f.source,
    buildDir: f.build,
    tool: fakeColmap(mode),
    binaryPath: f.exe,
    git,
    now: () => "2026-10-19T12:00:00Z",
  });

async function manifestFor(f: Fixture): Promise<string> {
  const r = await verify(f);
  if (!r.ok) throw new Error(r.problems.join("; "));
  const p = path.join(path.dirname(f.build), "colmap.provenance.json");
  await writeColmapProvenance(r.manifest, p);
  return p;
}

describe("COLMAP build provenance: the operator's local verifier", () => {
  it("correct commit + approved flags + clean build files + refusing GPU SIFT → a manifest; the probe then says VERIFIED", async () => {
    const f = await fixture();
    const r = await verify(f);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    const m = r.manifest as ColmapProvenance;
    expect(m).toMatchObject({
      schema: "prism.local-tool.colmap.v1",
      version: "4.2.1",
      sourceCommit: APPROVED_COLMAP.commit,
      worktreeClean: true,
      binary: { fileName: "colmap.exe" },
      cmake: { generator: "Ninja", compiler: { id: "MSVC", version: "19.44.35211.0" }, architecture: "x64" },
      linkCheck: { method: "ninja", forbiddenAbsent: true },
      runtimeChecks: { gpuSiftRefused: true, mvsCommandsAbsent: true },
    });
    expect(m.cmake.flags).toEqual(REQUIRED_CMAKE);
    expect(m.runtimeFiles.map((x) => x.fileName)).toEqual(["cholmod.dll"]);
    // copyleft components the profile cannot remove are RECORDED, not hidden
    expect(m.copyleftComponents).toEqual([
      "suitesparse-cholmod (LGPL-2.1+ core; GPL-2+ modules: matrixops)",
      "suitesparse-spqr (GPL-2+)",
    ]);
    expect(m.dependencies.find((d) => d.name === "glew")).toBeUndefined(); // not installed rows are ignored
    // no absolute paths or user directories in the manifest
    expect(JSON.stringify(m)).not.toContain(path.dirname(f.build));

    const p = path.join(path.dirname(f.build), "colmap.provenance.json");
    await writeColmapProvenance(m, p);
    await expect(writeColmapProvenance(m, p)).rejects.toThrow(); // never silently overwritten
    expect(await checkColmapProvenance(f.exe, p)).toMatchObject({ state: "verified", reason: null });
  });

  it("refuses: wrong commit, a forbidden option ON, a missing option, a dirty or unverifiable checkout", async () => {
    const wrong = await verify(await fixture({ commit: "a".repeat(40) }));
    expect(wrong.ok).toBe(false);
    expect(wrong.problems.join(" ")).toMatch(/not bd1fcf6/);
    for (const k of [
      "LSD_ENABLED",
      "CUDA_ENABLED",
      "OPENGL_ENABLED",
      "CGAL_ENABLED",
      "DOWNLOAD_ENABLED",
      "ONNX_ENABLED",
    ]) {
      const r = await verify(await fixture({ cache: { [k]: "ON" } }));
      expect([k, r.ok]).toEqual([k, false]);
      expect(r.problems.join(" ")).toContain(`${k}=ON`);
    }
    const absent = await verify(await fixture({ cache: { MVS_ENABLED: undefined } }));
    expect(absent.problems.join(" ")).toMatch(/MVS_ENABLED is not recorded/);
    const found = await verify(await fixture({ cache: { CGAL_DIR: "C:/vcpkg/share/cgal" } }));
    expect(found.problems.join(" ")).toMatch(/CGAL_DIR is set/);
    expect((await verify(await fixture(), "success", fakeGit("dirty"))).problems.join(" ")).toMatch(
      /local modifications/,
    );
    expect((await verify(await fixture(), "success", null)).problems.join(" ")).toMatch(/git was not found/);
  }, 120_000);

  it("refuses what the cache cannot show: forbidden link targets or defines, forbidden packages, and the BINARY's own behaviour", async () => {
    const sift = await verify(
      await fixture({
        ninja:
          "build src/colmap/exe/colmap.exe: LINK\n  LINK_LIBRARIES = src/thirdparty/SiftGPU/colmap_sift_gpu.lib\n",
      }),
    );
    expect(sift.problems.join(" ")).toMatch(/colmap_sift_gpu/);
    const def = await verify(
      await fixture({ ninja: "build src/colmap/exe/colmap.exe: LINK\n  DEFINES = -DCOLMAP_GPU_ENABLED\n" }),
    );
    expect(def.problems.join(" ")).toMatch(/defines COLMAP_GPU_ENABLED/);
    const cgal = await verify(
      await fixture({
        status: `${STATUS}\nPackage: cgal\nVersion: 6.0.1\nArchitecture: x64-windows\nStatus: install ok installed\n`,
      }),
    );
    expect(cgal.problems.join(" ")).toMatch(/forbidden package cgal/);
    // an executable that still accepts GPU SIFT (SiftGPU compiled in) or offers MVS is refused, whatever the cache says
    expect((await verify(await fixture(), "siftgpu")).problems.join(" ")).toMatch(/did not refuse GPU SIFT/);
    expect((await verify(await fixture(), "mvs")).problems.join(" ")).toMatch(/dense MVS/);
    expect((await verify(await fixture(), "wrong_version")).problems.join(" ")).toMatch(/not COLMAP 4\.2\.1/);
    // the define check must catch every spelling a generator uses, and nothing that merely contains the name
    for (const spelling of ["-DCOLMAP_GPU_ENABLED", "/DCOLMAP_GPU_ENABLED", "NDEBUG;COLMAP_GPU_ENABLED;X"])
      expect(checkBuildDescription(spelling)).toEqual(["The build defines COLMAP_GPU_ENABLED."]);
    expect(checkBuildDescription("-DCOLMAP_GPU_ENABLED_EXTRA -DXCOLMAP_GPU_ENABLED")).toEqual([]);
  }, 120_000);
});

describe("COLMAP provenance at run time (toolchain probe policy)", () => {
  it("an official archive / PATH binary without a manifest is UNVERIFIED, never usable for Local Capture", async () => {
    const f = await fixture();
    expect(await checkColmapProvenance(f.exe, undefined)).toMatchObject({ state: "unverified" });
    expect((await checkColmapProvenance(f.exe, undefined)).reason).toContain(UNVERIFIED_MESSAGE);
    expect(await checkColmapProvenance(f.exe, "relative.json")).toMatchObject({ state: "unverified" });
    expect(await checkColmapProvenance(f.exe, path.join(f.bin, "missing.json"))).toMatchObject({
      state: "unverified",
    });
    expect(await checkColmapProvenance(null, undefined)).toMatchObject({ state: "missing" });
  });

  it("a hash mismatch (rebuilt, replaced or tampered executable or DLL) is UNVERIFIED", async () => {
    const f = await fixture();
    const p = await manifestFor(f);
    await writeFile(f.exe, "MZ a different build");
    expect(await checkColmapProvenance(f.exe, p)).toMatchObject({ state: "unverified" });
    const g = await fixture();
    const q = await manifestFor(g);
    await writeFile(path.join(g.bin, "cholmod.dll"), "patched");
    expect((await checkColmapProvenance(g.exe, q)).reason).toMatch(/runtime libraries changed/);
    const h = await fixture();
    const r = await manifestFor(h);
    await writeFile(path.join(h.bin, "extra.dll"), "new");
    expect(await checkColmapProvenance(h.exe, r)).toMatchObject({ state: "unverified" });
  });

  it("a manifest for another version/commit or an unapproved profile is INCOMPATIBLE", async () => {
    const f = await fixture();
    const p = await manifestFor(f);
    const m = JSON.parse(await readFile(p, "utf8")) as ColmapProvenance;
    const other = path.join(f.bin, "other.json");
    await writeFile(other, JSON.stringify({ ...m, sourceCommit: "b".repeat(40) }));
    expect(await checkColmapProvenance(f.exe, other)).toMatchObject({ state: "incompatible" });
    const lsd = path.join(f.bin, "lsd.json");
    await writeFile(
      lsd,
      JSON.stringify({ ...m, cmake: { ...m.cmake, flags: { ...m.cmake.flags, LSD_ENABLED: "ON" } } }),
    );
    expect(await checkColmapProvenance(f.exe, lsd)).toMatchObject({ state: "incompatible" });
    const garbage = path.join(f.bin, "garbage.json");
    await writeFile(garbage, "{not json");
    expect(await checkColmapProvenance(f.exe, garbage)).toMatchObject({ state: "unverified" });
  });
});

describe("parsers", () => {
  it("reads CMakeCache entries, vcpkg status stanzas and git HEAD (detached, ref, packed-refs)", async () => {
    expect(parseCMakeCache("//x\nA:BOOL=OFF\nB:STRING=Release\n# c\nC=1\n")).toEqual({
      A: "OFF",
      B: "Release",
      C: "1",
    });
    expect(parseVcpkgStatus(STATUS).map((p) => [p.name, p.version, p.features])).toEqual([
      ["ceres", "2.2.0#6", ["suitesparse"]],
      ["openimageio", "3.1.14.0", []],
      ["suitesparse-cholmod", "5.3.5", ["matrixops"]],
      ["suitesparse-spqr", "4.3.6", []],
    ]);
    const d = await dir();
    await mkdir(path.join(d, ".git", "refs", "heads"), { recursive: true });
    await writeFile(path.join(d, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(
      path.join(d, ".git", "packed-refs"),
      `# pack-refs\n${APPROVED_COLMAP.commit} refs/heads/main\n`,
    );
    expect(await readGitHead(d)).toBe(APPROVED_COLMAP.commit);
    await writeFile(path.join(d, ".git", "refs", "heads", "main"), `${"c".repeat(40)}\n`);
    expect(await readGitHead(d)).toBe("c".repeat(40));
    expect(await readGitHead(path.join(d, "nope"))).toBeNull();
  });
});

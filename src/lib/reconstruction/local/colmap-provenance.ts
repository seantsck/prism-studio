import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { runProcess, type ToolCommand } from "./process";

/**
 * COLMAP build provenance (`prism.local-tool.colmap.v1`).
 *
 * Prism supports ONE COLMAP configuration for Local Capture: COLMAP 4.2.1 (bd1fcf6) built FROM SOURCE by the operator
 * with a constrained, CPU-only profile. The official prebuilt Windows archives compile in SiftGPU ("educational,
 * research and non-profit purposes" only) and LSD (AGPL-3.0) and enable CGAL; Prism treats them as detected but
 * UNVERIFIED. This is an engineering policy, not legal advice.
 *
 * A COLMAP executable cannot say how it was built (its version line reports only CUDA/HIP, so an OpenGL SiftGPU build
 * also says "without GPU support"). So the operator runs a LOCAL verifier once, against the source checkout, the
 * build directory and the produced executable; it writes a manifest only when every check passes. At run time Prism
 * re-hashes the executable (and its directory's DLLs) against that manifest. Nothing is downloaded or built here.
 *
 * What a manifest PROVES: the source checkout was at the approved commit and unmodified (git); CMakeCache.txt shows
 * every approved option explicitly OFF; the generated build files link and define none of SiftGPU, LSD, MVS, GUI/Qt,
 * CGAL, ONNX or CUDA for the colmap executable; the vcpkg-installed packages contain none of CGAL/GMP/MPFR/Qt/ONNX/
 * CUDA; the executable itself refuses GPU SIFT and lacks the MVS commands; and the hashed files are those binaries.
 * What it does NOT prove: that the compiler or the vcpkg-built DLLs are free of defects or of anything not named
 * here, or anything about files other than the hashed ones. Copyleft components that the profile cannot remove
 * (SuiteSparse CHOLMOD, LGPL-2.1+; with COLMAP's stock manifest also GPL-2+ CHOLMOD modules and SPQR) are RECORDED;
 * they permit local commercial use, and Prism never redistributes COLMAP.
 */

export const COLMAP_PROVENANCE_SCHEMA = "prism.local-tool.colmap.v1" as const;
export const APPROVED_COLMAP = {
  version: "4.2.1",
  commit: "bd1fcf654d2dd8fefa1466999c190a246f83f4b9",
} as const;
export const VERIFIER_VERSION = "prism-colmap-verifier/1";

/** CMake cache entries the approved profile requires (exact option names in COLMAP 4.2.1's CMakeLists.txt). */
export const REQUIRED_CMAKE: Readonly<Record<string, string>> = {
  CUDA_ENABLED: "OFF",
  HIP_ENABLED: "OFF",
  CASPAR_ENABLED: "OFF",
  GUI_ENABLED: "OFF",
  OPENGL_ENABLED: "OFF",
  MVS_ENABLED: "OFF",
  CGAL_ENABLED: "OFF",
  LSD_ENABLED: "OFF",
  ONNX_ENABLED: "OFF",
  FETCH_ONNX: "OFF",
  DOWNLOAD_ENABLED: "OFF",
  TESTS_ENABLED: "OFF",
  BENCHMARK_ENABLED: "OFF",
  CMAKE_BUILD_TYPE: "Release",
};

/** Must not appear in the colmap executable's generated build/link description. */
export const FORBIDDEN_BUILD_TOKENS = [
  "colmap_sift_gpu",
  "SiftGPU",
  "colmap_lsd",
  "colmap_mvs",
  "colmap_ui",
  "CGAL",
  "Qt6",
  "Qt5",
  "onnxruntime",
  "cudart",
];
export const FORBIDDEN_DEFINES = [
  "COLMAP_GPU_ENABLED",
  "COLMAP_LSD_ENABLED",
  "COLMAP_CGAL_ENABLED",
  "COLMAP_CUDA_ENABLED",
  "COLMAP_ONNX_ENABLED",
  "COLMAP_MVS_ENABLED",
  "COLMAP_GUI_ENABLED",
  "COLMAP_DOWNLOAD_ENABLED",
];
/** vcpkg packages that must not be installed for the build. */
export const FORBIDDEN_PACKAGES = [/^cgal$/, /^gmp$/, /^mpfr$/, /^qt/, /^onnxruntime/, /^cuda/, /^cudnn/];
/** Installed packages recorded as copyleft (allowed for local use; never redistributed by Prism). */
const COPYLEFT = (p: VcpkgPackage): string | null =>
  p.name === "suitesparse-cholmod"
    ? p.features.some((f) => ["matrixops", "supernodal", "modify", "gpl"].includes(f))
      ? "suitesparse-cholmod (LGPL-2.1+ core; GPL-2+ modules: " +
        p.features.filter((f) => ["matrixops", "supernodal", "modify", "gpl"].includes(f)).join(", ") +
        ")"
      : "suitesparse-cholmod (LGPL-2.1+)"
    : p.name === "suitesparse-spqr"
      ? "suitesparse-spqr (GPL-2+)"
      : null;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
export const colmapProvenanceSchema = z.object({
  schema: z.literal(COLMAP_PROVENANCE_SCHEMA),
  tool: z.literal("colmap"),
  version: z.string().max(32),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  worktreeClean: z.literal(true),
  binary: z.object({ fileName: z.string().max(128), sha256: hex64, byteSize: z.number().int().positive() }),
  runtimeFiles: z.array(z.object({ fileName: z.string().max(128), sha256: hex64 })).max(500),
  cmake: z.object({
    generator: z.string().max(64),
    flags: z.record(z.string(), z.string()),
    compiler: z.object({ id: z.string().max(32), version: z.string().max(64) }),
    architecture: z.string().max(32),
  }),
  linkCheck: z.object({ method: z.enum(["ninja", "vcxproj"]), forbiddenAbsent: z.literal(true) }),
  runtimeChecks: z.object({
    versionLine: z.string().max(200),
    gpuSiftRefused: z.literal(true),
    mvsCommandsAbsent: z.literal(true),
  }),
  dependencies: z
    .array(z.object({ name: z.string(), version: z.string(), features: z.array(z.string()) }))
    .max(500),
  copyleftComponents: z.array(z.string()).max(50),
  verifiedAt: z.string(),
  verifier: z.literal(VERIFIER_VERSION),
});
export type ColmapProvenance = z.infer<typeof colmapProvenanceSchema>;

// ───────────────────────── helpers ─────────────────────────

export async function sha256OfFile(p: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Hashes every DLL next to the executable (its runtime dependencies on Windows vcpkg builds), sorted by name. */
export async function hashRuntimeFiles(exeDir: string): Promise<Array<{ fileName: string; sha256: string }>> {
  const names = (await readdir(exeDir)).filter((n) => /\.(dll|so(\.\d+)*|dylib)$/i.test(n)).sort();
  const out = [];
  for (const n of names) out.push({ fileName: n, sha256: await sha256OfFile(path.join(exeDir, n)) });
  return out;
}

/** CMakeCache.txt → { NAME: value } (types dropped). */
export function parseCMakeCache(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;
    const m = /^([A-Za-z0-9_.+-]+)(?::[A-Za-z_]+)?=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const truthy = (v: string | undefined) => ["ON", "1", "TRUE", "YES", "Y"].includes((v ?? "").toUpperCase());

/** Compares the cache against the approved profile (an option must be EXPLICITLY OFF; absent is a failure). */
export function checkCMakeFlags(cache: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [k, want] of Object.entries(REQUIRED_CMAKE)) {
    const got = cache[k];
    if (got === undefined) problems.push(`${k} is not recorded in CMakeCache.txt (required ${want}).`);
    else if (want === "OFF" ? truthy(got) || got.toUpperCase() !== "OFF" : got !== want)
      problems.push(`${k}=${got} (required ${want}).`);
  }
  for (const k of Object.keys(cache))
    if (/^(CGAL|Qt\d|onnxruntime)_DIR$/.test(k) && cache[k] && !/NOTFOUND/.test(cache[k]!))
      problems.push(`${k} is set: a forbidden dependency was found during configure.`);
  return problems;
}

/** The generated build description of the colmap executable must not reference forbidden targets or defines. */
export function checkBuildDescription(text: string): string[] {
  const problems: string[] = [];
  for (const t of FORBIDDEN_BUILD_TOKENS) if (text.includes(t)) problems.push(`The build references ${t}.`);
  // a define appears as -DNAME / /DNAME (Ninja, Makefiles) or in a ;-separated list (vcxproj); `\b` would miss -DNAME
  for (const d of FORBIDDEN_DEFINES)
    if (new RegExp(`(?:^|[^A-Za-z0-9_]|[-/]D)${d}(?![A-Za-z0-9_])`).test(text))
      problems.push(`The build defines ${d}.`);
  return problems;
}

export interface VcpkgPackage {
  name: string;
  version: string;
  features: string[];
}

/** `vcpkg_installed/vcpkg/status` (Debian-control-like stanzas) → installed packages with their features. */
export function parseVcpkgStatus(text: string): VcpkgPackage[] {
  const pkgs = new Map<string, VcpkgPackage>();
  for (const stanza of text.split(/\r?\n\r?\n/)) {
    const f: Record<string, string> = {};
    for (const line of stanza.split(/\r?\n/)) {
      const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
      if (m) f[m[1]!] = m[2]!;
    }
    if (!f.Package || !/install ok installed/.test(f.Status ?? "")) continue;
    const p = pkgs.get(f.Package) ?? { name: f.Package, version: "", features: [] };
    if (f.Feature) p.features.push(f.Feature);
    else p.version = f.Version + (f["Port-Version"] ? `#${f["Port-Version"]}` : "");
    pkgs.set(f.Package, p);
  }
  return [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** HEAD commit of a checkout, read from .git without running anything. */
export async function readGitHead(sourceDir: string): Promise<string | null> {
  let gitDir = path.join(sourceDir, ".git");
  const s = await stat(gitDir).catch(() => null);
  if (!s) return null;
  if (s.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(await readFile(gitDir, "utf8"));
    if (!m) return null;
    gitDir = path.resolve(sourceDir, m[1]!.trim());
  }
  const head = (await readFile(path.join(gitDir, "HEAD"), "utf8").catch(() => "")).trim();
  if (/^[0-9a-f]{40}$/.test(head)) return head;
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (!ref) return null;
  const loose = (await readFile(path.join(gitDir, ref), "utf8").catch(() => "")).trim();
  if (/^[0-9a-f]{40}$/.test(loose)) return loose;
  const packed = await readFile(path.join(gitDir, "packed-refs"), "utf8").catch(() => "");
  return (
    new RegExp(`^([0-9a-f]{40}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(packed)?.[1] ??
    null
  );
}

async function compilerInfo(buildDir: string) {
  const files = await readdir(path.join(buildDir, "CMakeFiles"), { withFileTypes: true }).catch(() => []);
  for (const d of files) {
    if (!d.isDirectory() || !/^\d/.test(d.name)) continue;
    const t = await readFile(
      path.join(buildDir, "CMakeFiles", d.name, "CMakeCXXCompiler.cmake"),
      "utf8",
    ).catch(() => "");
    const get = (k: string) => new RegExp(`set\\(${k} "([^"]*)"\\)`).exec(t)?.[1] ?? "";
    if (t)
      return {
        id: get("CMAKE_CXX_COMPILER_ID"),
        version: get("CMAKE_CXX_COMPILER_VERSION"),
        architecture: get("CMAKE_CXX_COMPILER_ARCHITECTURE_ID") || get("MSVC_CXX_ARCHITECTURE_ID"),
      };
  }
  return { id: "unknown", version: "unknown", architecture: "unknown" };
}

/** The colmap executable's own build description from the generator's files. */
async function buildDescription(
  buildDir: string,
  generator: string,
): Promise<{ method: "ninja" | "vcxproj"; text: string } | null> {
  if (/ninja/i.test(generator)) {
    const t = await readFile(path.join(buildDir, "build.ninja"), "utf8").catch(() => null);
    if (t && /colmap_main|colmap\.exe|\/colmap\b/.test(t)) return { method: "ninja", text: t };
  }
  if (/visual studio/i.test(generator)) {
    const t = await readFile(
      path.join(buildDir, "src", "colmap", "exe", "colmap_main.vcxproj"),
      "utf8",
    ).catch(() => null);
    if (t) return { method: "vcxproj", text: t };
  }
  return null;
}

// ───────────────────────── the operator's one-time verifier ─────────────────────────

export interface VerifyBuildInput {
  sourceDir: string;
  buildDir: string;
  /** how to run the built colmap executable */
  tool: ToolCommand;
  /** the executable FILE whose hash is recorded (default: tool.executable; they differ only for test fakes) */
  binaryPath?: string;
  /** absolute path of git, to prove the checkout is unmodified */
  git: ToolCommand | null;
  now?: () => string;
}

export type VerifyBuildResult =
  { ok: true; manifest: ColmapProvenance; problems: [] } | { ok: false; manifest: null; problems: string[] };

/**
 * Verifies a COLMAP source build against Prism's approved profile. Returns a manifest only if EVERY check passes;
 * otherwise lists every problem found. Never downloads, builds or installs anything.
 */
export async function verifyColmapBuild(input: VerifyBuildInput): Promise<VerifyBuildResult> {
  const problems: string[] = [];
  // 1. source commit + unmodified checkout
  const commit = await readGitHead(input.sourceDir);
  if (commit !== APPROVED_COLMAP.commit)
    problems.push(
      `The source checkout is at ${commit ?? "an unknown commit"}, not ${APPROVED_COLMAP.commit}.`,
    );
  let clean = false;
  if (!input.git) problems.push("git was not found, so the checkout cannot be proven unmodified.");
  else {
    const r = await runProcess({
      executable: input.git.executable,
      args: [...input.git.prefixArgs, "-C", input.sourceDir, "status", "--porcelain", "--untracked-files=no"],
      cwd: input.sourceDir,
      env: input.git.env,
      timeoutMs: 30_000,
    });
    clean = r.outcome === "exited" && r.exitCode === 0 && r.stdout.trim() === "";
    if (!clean) problems.push("The source checkout has local modifications (or git could not inspect it).");
  }
  // 2. CMake cache
  const cacheText = await readFile(path.join(input.buildDir, "CMakeCache.txt"), "utf8").catch(() => null);
  const cache = cacheText ? parseCMakeCache(cacheText) : {};
  if (!cacheText) problems.push("CMakeCache.txt was not found in the build directory.");
  else problems.push(...checkCMakeFlags(cache));
  const generator = cache.CMAKE_GENERATOR ?? "unknown";
  // 3. generated build description (what is actually compiled and linked)
  const desc = await buildDescription(input.buildDir, generator);
  if (!desc)
    problems.push(
      `The build files for generator "${generator}" could not be inspected (Ninja or Visual Studio required).`,
    );
  else problems.push(...checkBuildDescription(desc.text));
  // 4. installed dependencies
  const statusText = await readFile(
    path.join(input.buildDir, "vcpkg_installed", "vcpkg", "status"),
    "utf8",
  ).catch(() => null);
  const deps = statusText ? parseVcpkgStatus(statusText) : [];
  if (!statusText)
    problems.push("vcpkg_installed/vcpkg/status was not found: the dependency set cannot be verified.");
  for (const p of deps)
    if (FORBIDDEN_PACKAGES.some((re) => re.test(p.name)))
      problems.push(`The forbidden package ${p.name} is installed.`);
  // 5. the executable itself
  const exe = input.binaryPath ?? input.tool.executable;
  const exeStat = await stat(exe).catch(() => null);
  if (!exeStat?.isFile()) problems.push("The COLMAP executable was not found.");
  const env = { ...input.tool.env, PATH: `${path.dirname(exe)}${path.delimiter}${process.env.PATH ?? ""}` };
  const run = (args: string[], cwd: string) =>
    runProcess({
      executable: input.tool.executable,
      args: [...input.tool.prefixArgs, ...args],
      cwd,
      env,
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024,
    });
  let versionLine = "";
  let gpuSiftRefused = false;
  let mvsCommandsAbsent = false;
  if (exeStat?.isFile()) {
    const v = await run(["version"], path.dirname(exe));
    versionLine = `${v.stdout}${v.stderr}`.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? "";
    if (!new RegExp(`^COLMAP ${APPROVED_COLMAP.version.replace(/\./g, "\\.")}\\b`).test(versionLine))
      problems.push(
        `The executable reports "${versionLine.slice(0, 80)}", not COLMAP ${APPROVED_COLMAP.version}.`,
      );
    if (!versionLine.includes(`Commit ${APPROVED_COLMAP.commit.slice(0, 7)}`))
      problems.push("The executable does not report the approved source commit.");
    const h = await run(["help"], path.dirname(exe));
    mvsCommandsAbsent =
      h.outcome === "exited" && !/patch_match_stereo|stereo_fusion/.test(h.stdout + h.stderr);
    if (!mvsCommandsAbsent) problems.push("The executable offers dense MVS commands (MVS must be OFF).");
    // GPU SIFT must be impossible in this binary (COLMAP's own refusal when neither CUDA nor OpenGL was compiled)
    const tmp = await mkdtemp(path.join(os.tmpdir(), "prism-colmap-verify-"));
    try {
      const g = await run(
        [
          "feature_extractor",
          "--database_path",
          path.join(tmp, "probe.db"),
          "--image_path",
          tmp,
          "--FeatureExtraction.use_gpu",
          "1",
        ],
        tmp,
      );
      gpuSiftRefused = /Cannot use GPU feature extraction without CUDA or OpenGL support/.test(
        g.stdout + g.stderr,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
    }
    if (!gpuSiftRefused) problems.push("The executable did not refuse GPU SIFT: SiftGPU may be compiled in.");
  }
  if (problems.length > 0) return { ok: false, manifest: null, problems };

  const compiler = await compilerInfo(input.buildDir);
  const manifest: ColmapProvenance = {
    schema: COLMAP_PROVENANCE_SCHEMA,
    tool: "colmap",
    version: APPROVED_COLMAP.version,
    sourceCommit: APPROVED_COLMAP.commit,
    worktreeClean: true,
    binary: { fileName: path.basename(exe), sha256: await sha256OfFile(exe), byteSize: exeStat!.size },
    runtimeFiles: await hashRuntimeFiles(path.dirname(exe)),
    cmake: {
      generator,
      flags: Object.fromEntries(Object.keys(REQUIRED_CMAKE).map((k) => [k, cache[k]!])),
      compiler: { id: compiler.id, version: compiler.version },
      architecture: compiler.architecture,
    },
    linkCheck: { method: desc!.method, forbiddenAbsent: true },
    runtimeChecks: { versionLine, gpuSiftRefused: true, mvsCommandsAbsent: true },
    dependencies: deps,
    copyleftComponents: deps.map(COPYLEFT).filter((x): x is string => x !== null),
    verifiedAt: (input.now ?? (() => new Date().toISOString()))(),
    verifier: VERIFIER_VERSION,
  };
  return { ok: true, manifest: colmapProvenanceSchema.parse(manifest), problems: [] };
}

export async function writeColmapProvenance(manifest: ColmapProvenance, file: string) {
  await writeFile(file, `${JSON.stringify(colmapProvenanceSchema.parse(manifest), null, 2)}\n`, {
    flag: "wx",
  });
}

// ───────────────────────── run-time check (toolchain probe) ─────────────────────────

export type ColmapProvenanceState = "verified" | "unverified" | "incompatible" | "missing";

export interface ColmapProvenanceCheck {
  state: ColmapProvenanceState;
  reason: string | null;
  manifest: ColmapProvenance | null;
}

export const UNVERIFIED_MESSAGE =
  "COLMAP is installed but this build has not been verified for Prism Local Capture.";

/**
 * Is THIS executable the verified build? `verified` needs: a manifest that parses, the approved version and source
 * commit, the approved CMake flags, and the executable's (and its DLLs') current hashes equal to the manifest's.
 * A missing manifest or a hash mismatch is `unverified` (e.g. an official archive, a rebuild, a PATH binary);
 * a manifest stating another version, commit or profile is `incompatible`.
 */
export async function checkColmapProvenance(
  executable: string | null,
  manifestPath: string | undefined,
): Promise<ColmapProvenanceCheck> {
  if (!executable)
    return { state: "missing", reason: "COLMAP is not installed or not configured.", manifest: null };
  if (!manifestPath?.trim())
    return {
      state: "unverified",
      reason: `${UNVERIFIED_MESSAGE} (No PRISM_COLMAP_PROVENANCE_PATH.)`,
      manifest: null,
    };
  if (!path.isAbsolute(manifestPath))
    return {
      state: "unverified",
      reason: "PRISM_COLMAP_PROVENANCE_PATH must be an absolute path.",
      manifest: null,
    };
  let manifest: ColmapProvenance;
  try {
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    if (raw.schema !== COLMAP_PROVENANCE_SCHEMA)
      return {
        state: "unverified",
        reason: `${UNVERIFIED_MESSAGE} (Unknown provenance format.)`,
        manifest: null,
      };
    const loose = raw as {
      version?: unknown;
      sourceCommit?: unknown;
      cmake?: { flags?: Record<string, string> };
    };
    if (loose.version !== APPROVED_COLMAP.version || loose.sourceCommit !== APPROVED_COLMAP.commit)
      return {
        state: "incompatible",
        reason: `This COLMAP build is ${String(loose.version)} @ ${String(loose.sourceCommit).slice(0, 12)}; Prism supports ${APPROVED_COLMAP.version} @ ${APPROVED_COLMAP.commit.slice(0, 7)}.`,
        manifest: null,
      };
    const flagProblems = checkCMakeFlags(loose.cmake?.flags ?? {});
    if (flagProblems.length)
      return {
        state: "incompatible",
        reason: `This COLMAP build profile is not approved: ${flagProblems[0]}`,
        manifest: null,
      };
    manifest = colmapProvenanceSchema.parse(raw);
  } catch {
    return {
      state: "unverified",
      reason: `${UNVERIFIED_MESSAGE} (The provenance manifest is unreadable or invalid.)`,
      manifest: null,
    };
  }
  const exeStat = await stat(executable).catch(() => null);
  if (!exeStat?.isFile()) return { state: "missing", reason: "The COLMAP executable is missing.", manifest };
  if (
    path.basename(executable).toLowerCase() !== manifest.binary.fileName.toLowerCase() ||
    exeStat.size !== manifest.binary.byteSize ||
    (await sha256OfFile(executable)) !== manifest.binary.sha256
  )
    return {
      state: "unverified",
      reason: `${UNVERIFIED_MESSAGE} (The executable does not match its provenance hash.)`,
      manifest,
    };
  const now = await hashRuntimeFiles(path.dirname(executable));
  const want = new Map(manifest.runtimeFiles.map((f) => [f.fileName.toLowerCase(), f.sha256]));
  const have = new Map(now.map((f) => [f.fileName.toLowerCase(), f.sha256]));
  if (want.size !== have.size || [...want].some(([n, h]) => have.get(n) !== h))
    return {
      state: "unverified",
      reason: `${UNVERIFIED_MESSAGE} (Its runtime libraries changed since verification.)`,
      manifest,
    };
  return { state: "verified", reason: null, manifest };
}

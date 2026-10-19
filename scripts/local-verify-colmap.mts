// Phase 2F M2D.3A: the operator's LOCAL COLMAP build verifier. Run once after building COLMAP from source with
// Prism's approved profile (docs/local-reconstruction.md):
//
//   npm run local:verify-colmap -- --source <colmap checkout> --build <cmake build dir> \
//        --exe <installed colmap.exe> --out <manifest.json>
//
// It checks the checkout (approved commit, unmodified), CMakeCache.txt (approved options explicitly OFF), the
// generated build files (no SiftGPU/LSD/MVS/GUI/CGAL/ONNX/CUDA for the colmap executable), the vcpkg-installed
// packages, and the executable's own behaviour (version, no MVS commands, refuses GPU SIFT). Only if EVERY check
// passes does it write the provenance manifest that PRISM_COLMAP_PROVENANCE_PATH points at. It downloads, builds and
// installs nothing; it runs only the given colmap executable and `git status`. No database, no network.
import path from "node:path";
import { verifyColmapBuild, writeColmapProvenance } from "../src/lib/reconstruction/local/colmap-provenance";
import { resolveExecutable } from "../src/lib/reconstruction/local/resolve";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const source = arg("source");
const build = arg("build");
const exe = arg("exe");
const out = arg("out");
if (!source || !build || !exe || !out || ![source, build, exe, out].every((p) => path.isAbsolute(p))) {
  console.error(
    "Usage: --source <abs dir> --build <abs dir> --exe <abs colmap executable> --out <abs manifest.json>",
  );
  process.exit(2);
}
const git = await resolveExecutable({
  configured: process.env.PRISM_GIT_PATH,
  envVar: "PRISM_GIT_PATH",
  names: ["git"],
  pathEnv: process.env.PATH ?? process.env.Path,
});
const result = await verifyColmapBuild({
  sourceDir: source,
  buildDir: build,
  tool: { executable: exe, prefixArgs: [] },
  git: git.status === "found" ? { executable: git.path, prefixArgs: [] } : null,
});
if (!result.ok) {
  console.error("COLMAP build NOT verified for Prism Local Capture:");
  for (const p of result.problems) console.error(`  - ${p}`);
  process.exit(1);
}
await writeColmapProvenance(result.manifest, out);
const m = result.manifest;
console.log(
  `VERIFIED: COLMAP ${m.version} @ ${m.sourceCommit.slice(0, 7)}  sha256 ${m.binary.sha256.slice(0, 16)}…`,
);
console.log(
  `  link check: ${m.linkCheck.method}; GPU SIFT refused; no MVS commands; ${m.runtimeFiles.length} runtime libraries hashed`,
);
if (m.copyleftComponents.length)
  console.log(
    `  recorded copyleft components (local use only; Prism never redistributes COLMAP): ${m.copyleftComponents.join("; ")}`,
  );
console.log(`  manifest written: ${out}  → set PRISM_COLMAP_PATH and PRISM_COLMAP_PROVENANCE_PATH`);

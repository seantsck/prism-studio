// TEST-ONLY fake of Brush v0.3.0's CLI (brush_app). Runs as a real child process through Prism's process runner.
// Behaviour is selected with FAKE_BRUSH_MODE:
//   success | version | wrong_version | fail | oom | no_adapter | no_export | bad_ply | slow
// It parses the same arguments Prism passes and writes a binary little-endian Gaussian PLY with Brush's
// ALPHABETICAL property order (Brush serialises through a BTreeMap) and SH degree 3.
import fs from "node:fs";
import path from "node:path";

const mode = process.env.FAKE_BRUSH_MODE || "success";
const argv = process.argv.slice(2);

if (argv.includes("--version") || argv.includes("-V")) {
  process.stdout.write(mode === "wrong_version" ? "brush_app 0.4.0\n" : "brush_app 0.3.0\n");
  process.exit(0);
}

const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dataset = argv[0];
const total = Number(flag("--total-steps") || 30000);
const exportPath = flag("--export-path") || ".";
const exportName = flag("--export-name") || "export_{iter}.ply";
const shDegree = Number(flag("--sh-degree") || 3);

const log = (m) => process.stdout.write(`[2026-10-19T00:00:00Z INFO  brush_process] ${m}\n`);

if (!dataset || !fs.existsSync(dataset)) {
  process.stderr.write("Error: Failed to load dataset\n");
  process.exit(1);
}
log(`Loaded dataset with 3 training, 0 eval views`);

if (mode === "no_adapter") {
  process.stderr.write(
    "thread 'main' panicked at cubecl-wgpu/src/runtime.rs:420:10:\nNo possible adapter available for backend. Falling back to first available.\n",
  );
  process.exit(101);
}
if (mode === "oom") {
  process.stderr.write("Error: Out of memory: failed to allocate buffer of 4294967296 bytes\n");
  process.exit(1);
}
if (mode === "fail") {
  process.stderr.write("Error: Dataset C:\\Users\\someone\\secret\\x has no valid cameras\n");
  process.exit(1);
}
if (mode === "slow") {
  log("Refine iter 200, 10000 splats.");
  // never finishes: the interval keeps the process alive and the pending await stops the script here
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

for (const it of [200, 15000, total]) log(`Refine iter ${it}, ${it * 3} splats.`);

if (mode !== "no_export") {
  const width = String(total).length;
  const name = exportName.replace("{iter}", String(total).padStart(width, "0"));
  fs.mkdirSync(exportPath, { recursive: true });
  const restCount = [0, 9, 24, 45][shDegree];
  const names = [
    "f_dc_0",
    "f_dc_1",
    "f_dc_2",
    ...Array.from({ length: restCount }, (_, i) => `f_rest_${i}`),
    "opacity",
    "rot_0",
    "rot_1",
    "rot_2",
    "rot_3",
    "scale_0",
    "scale_1",
    "scale_2",
    "x",
    "y",
    "z",
  ].sort(); // BTreeMap order: f_rest_10 sorts before f_rest_2
  const n = 64;
  const header =
    "ply\nformat binary_little_endian 1.0\ncomment Exported from Brush\ncomment Vertical axis: y\n" +
    `comment SH degree: ${shDegree}\nelement vertex ${n}\n` +
    names.map((p) => `property float ${p}\n`).join("") +
    "end_header\n";
  const body = Buffer.alloc(n * names.length * 4);
  for (let i = 0; i < n; i++) {
    const v = {
      x: (i % 8) * 0.25 - 1,
      y: Math.floor(i / 8) * 0.25 - 1,
      z: 0.5,
      opacity: (i % 5) - 2,
      rot_0: 1,
      rot_1: 0.1 * (i % 3),
      rot_2: 0,
      rot_3: 0,
      scale_0: -3,
      scale_1: -3.5,
      scale_2: -4,
      f_dc_0: 0.4,
      f_dc_1: -0.2,
      f_dc_2: 0.1,
    };
    names.forEach((p, k) => {
      let val = v[p];
      if (val === undefined) val = p.startsWith("f_rest_") ? ((Number(p.slice(7)) % 7) - 3) * 0.05 : 0;
      if (mode === "bad_ply" && p === "x" && i === 5) val = NaN;
      body.writeFloatLE(val, (i * names.length + k) * 4);
    });
  }
  fs.writeFileSync(path.join(exportPath, name), Buffer.concat([Buffer.from(header, "latin1"), body]));
}
log(`Done training! Took 1s.`);
process.exit(0);

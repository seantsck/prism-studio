// TEST-ONLY fake of the COLMAP 4.2.1 CLI subset Prism uses. Runs as a real child process through Prism's runner.
// FAKE_COLMAP_MODE selects the behaviour:
//   success            one model registering every image
//   multi              two models: 0 (2 images) and 1 (all images); Prism must pick 1, not "directory 0"
//   tie                two models with equal images; 1 has more points
//   few                one model registering only 2 images
//   no_model           mapper writes nothing and fails ("Failed to create any sparse model")
//   corrupt            mapper writes a truncated images.bin
//   extract_fails      feature_extractor exits 1
//   silent_extract     feature_extractor exits 0 but writes no database (COLMAP's partial-failure behaviour)
//   slow_mapper        mapper never finishes (for cancel / timeout)
//   wrong_version      reports 4.1.1
//   siftgpu            a build with GPU SIFT compiled in: does not refuse --FeatureExtraction.use_gpu 1
//   mvs                a build with dense MVS: `help` lists patch_match_stereo
// The binary model format is COLMAP's (reconstruction_io_binary.cc): little-endian, images.bin = registered only.
import fs from "node:fs";
import path from "node:path";

const mode = process.env.FAKE_COLMAP_MODE || "success";
const [cmd, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const record = process.env.FAKE_COLMAP_RECORD;
if (record) fs.appendFileSync(record, JSON.stringify([cmd, ...rest]) + "\n");

if (cmd === "version" || cmd === "--version" || cmd === "-v") {
  const v = mode === "wrong_version" ? "4.1.1" : "4.2.1";
  process.stdout.write(`COLMAP ${v} (Commit bd1fcf6 on 2026-09-29 without GPU support, std hash maps)\n`);
  process.exit(0);
}

if (cmd === "help" || cmd === "-h" || cmd === "--help") {
  const cmds = ["feature_extractor", "exhaustive_matcher", "mapper", "image_undistorter", "model_converter"];
  if (mode === "mvs") cmds.push("patch_match_stereo", "stereo_fusion");
  process.stdout.write(
    [
      "COLMAP 4.2.1",
      "Usage:",
      "  colmap [command] [options]",
      "Available commands:",
      ...cmds.map((c) => `  ${c}`),
    ].join("\n") + "\n",
  );
  process.exit(0);
}

class W {
  constructor() {
    this.parts = [];
  }
  u8(v) {
    const b = Buffer.alloc(1);
    b.writeUInt8(v);
    this.parts.push(b);
  }
  u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    this.parts.push(b);
  }
  i32(v) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    this.parts.push(b);
  }
  u64(v) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(v)));
    this.parts.push(b);
  }
  f64(v) {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v);
    this.parts.push(b);
  }
  str(s) {
    this.parts.push(Buffer.from(s + "\0", "utf8"));
  }
  buf() {
    return Buffer.concat(this.parts);
  }
}

/** Writes cameras/images/points3D.bin for `names` with `points` 3D points; modelId 2 = SIMPLE_RADIAL, 1 = PINHOLE. */
function writeModel(dir, names, points, modelId) {
  fs.mkdirSync(dir, { recursive: true });
  const cams = new W();
  cams.u64(1);
  cams.u32(1);
  cams.i32(modelId);
  cams.u64(640);
  cams.u64(480);
  const params = modelId === 1 ? [500, 500, 320, 240] : [500, 320, 240, 0.01];
  params.forEach((p) => cams.f64(p));
  fs.writeFileSync(path.join(dir, "cameras.bin"), cams.buf());

  const imgs = new W();
  imgs.u64(names.length);
  names.forEach((name, i) => {
    imgs.u32(i + 1);
    [1, 0, 0, 0, i * 0.1, 0, 0].forEach((v) => imgs.f64(v));
    imgs.u32(1);
    imgs.str(name);
    imgs.u64(3);
    for (let k = 0; k < 3; k++) {
      imgs.f64(10 * k);
      imgs.f64(20 * k);
      imgs.u64(k === 2 ? -1 : k + 1); // the last observation is untriangulated (point3D_id = invalid)
    }
  });
  const imagesBuf = imgs.buf();
  fs.writeFileSync(
    path.join(dir, "images.bin"),
    mode === "corrupt" ? imagesBuf.subarray(0, imagesBuf.length - 5) : imagesBuf,
  );

  const pts = new W();
  pts.u64(points);
  for (let p = 0; p < points; p++) {
    pts.u64(p + 1);
    [p * 0.01, -p * 0.02, 1 + p * 0.001].forEach((v) => pts.f64(v));
    pts.u8(200);
    pts.u8(100);
    pts.u8(50);
    pts.f64(0.5);
    pts.u64(2);
    pts.u32(1);
    pts.u32(0);
    pts.u32(2);
    pts.u32(1);
  }
  fs.writeFileSync(path.join(dir, "points3D.bin"), pts.buf());
}

const images = (p) =>
  fs
    .readdirSync(p)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .sort();

switch (cmd) {
  case "feature_extractor": {
    if (opt("FeatureExtraction.use_gpu") === "1" && mode !== "siftgpu") {
      process.stderr.write(
        "E1019 extractor.cc:155] Cannot use GPU feature extraction without CUDA or OpenGL support.\n",
      );
      process.exit(1);
    }
    if (mode === "extract_fails") {
      process.stderr.write("E1019 feature.cc:120] Failed to read image\n");
      process.exit(1);
    }
    if (mode === "silent_extract") process.exit(0);
    const db = opt("database_path");
    fs.writeFileSync(db, JSON.stringify({ images: images(opt("image_path")) }));
    process.stdout.write("Processed file [1/3]\n");
    process.exit(0);
  }
  case "exhaustive_matcher": {
    const db = opt("database_path");
    if (!fs.existsSync(db)) {
      process.stderr.write("database does not exist\n");
      process.exit(1);
    }
    fs.appendFileSync(db, "\nmatched");
    process.exit(0);
  }
  case "mapper": {
    const out = opt("output_path");
    if (!fs.existsSync(out) || !fs.statSync(out).isDirectory()) {
      process.stderr.write("`output_path` is not a directory.\n");
      process.exit(1);
    }
    if (mode === "slow_mapper") {
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    const names = images(opt("image_path"));
    if (mode === "no_model") {
      process.stderr.write("Failed to create any sparse model\n");
      process.exit(1);
    }
    if (mode === "multi") {
      writeModel(path.join(out, "0"), names.slice(0, 2), 50, 2);
      writeModel(path.join(out, "1"), names, 300, 2);
    } else if (mode === "tie") {
      writeModel(path.join(out, "0"), names, 100, 2);
      writeModel(path.join(out, "1"), names, 400, 2);
    } else if (mode === "few") {
      writeModel(path.join(out, "0"), names.slice(0, 2), 80, 2);
    } else {
      writeModel(path.join(out, "0"), names, 500, 2);
    }
    process.exit(0);
  }
  case "image_undistorter": {
    const input = opt("input_path");
    const out = opt("output_path");
    if (opt("output_type") !== "COLMAP") {
      process.stderr.write("unsupported output type\n");
      process.exit(1);
    }
    const imagesIn = opt("image_path");
    // the registered image names, read back from the chosen model (a real undistorter only writes those)
    const buf = fs.readFileSync(path.join(input, "images.bin"));
    const n = Number(buf.readBigUInt64LE(0));
    let o = 8;
    const names = [];
    for (let i = 0; i < n; i++) {
      o += 4 + 56 + 4;
      const end = buf.indexOf(0, o);
      names.push(buf.toString("utf8", o, end));
      o = end + 1;
      const np = Number(buf.readBigUInt64LE(o));
      o += 8 + np * 24;
    }
    fs.mkdirSync(path.join(out, "images"), { recursive: true });
    for (const name of names) fs.copyFileSync(path.join(imagesIn, name), path.join(out, "images", name));
    writeModel(path.join(out, "sparse"), names, 500, 1);
    fs.mkdirSync(path.join(out, "stereo"), { recursive: true });
    fs.writeFileSync(path.join(out, "stereo", "patch-match.cfg"), names.join("\n"));
    fs.writeFileSync(path.join(out, "run-colmap-geometric.sh"), "# generated\n");
    process.exit(0);
  }
  default:
    process.stderr.write(`Command \`${cmd}\` not recognized.\n`);
    process.exit(1);
}

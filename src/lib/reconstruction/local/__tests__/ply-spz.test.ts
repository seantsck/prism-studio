import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { SpzReader } from "@sparkjsdev/spark";
import { afterEach, describe, expect, it } from "vitest";
import { inspectSplat } from "@/lib/splat/inspect";
import { inspectGaussianPlyFile, scanGaussianPly, SH_C0 } from "../ply";
import { chooseFractionalBits, convertPlyToSpz, SPZ_ENCODER } from "../spz";
import { LocalReconstructionError } from "../types";
import { fixtureGaussian, standardOrder, tempDir, writeGaussianPly, type FixtureGaussian } from "./fixtures";

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
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof LocalReconstructionError ? e.code : `other: ${(e as Error).message}`;
  }
};

describe("Gaussian PLY reader", () => {
  it("parses the header by NAME (property order and extra properties do not matter) and detects the SH degree", async () => {
    const d = await dir();
    for (const sh of [0, 1, 2, 3]) {
      const order = standardOrder(sh, ["nx", "ny", "nz"]).reverse();
      const file = path.join(d, `o${sh}.ply`);
      await writeGaussianPly(file, 50, (i) => fixtureGaussian(i, sh), {
        shDegree: sh,
        order,
        doubles: ["x", "opacity"],
      });
      const seen: FixtureGaussian[] = [];
      const info = await scanGaussianPly(file, (g) => {
        if (g.index < 3)
          seen.push({
            x: g.x,
            y: g.y,
            z: g.z,
            dc: [...g.dc] as [number, number, number],
            rest: [...g.rest],
            opacity: g.opacity,
            scale: [...g.scale] as [number, number, number],
            rot: [...g.rot] as [number, number, number, number],
          });
      });
      expect(info).toMatchObject({ vertexCount: 50, shDegree: sh, restCount: [0, 9, 24, 45][sh] });
      expect(info.attributes.x!.type).toBe("float64");
      for (let i = 0; i < 3; i++) {
        const want = fixtureGaussian(i, sh);
        expect(seen[i]!.x).toBe(want.x); // stored as double: exact
        expect(seen[i]!.z).toBeCloseTo(want.z, 5);
        expect(seen[i]!.rest.length).toBe(want.rest.length);
        if (want.rest.length) expect(seen[i]!.rest.at(-1)).toBeCloseTo(want.rest.at(-1)!, 5);
        expect(seen[i]!.rot[0]).toBeCloseTo(want.rot[0], 5);
      }
      expect(info.bbox.min[0]).toBeLessThan(info.bbox.max[0]);
      expect(info.maxAbsPosition).toBeGreaterThan(0);
    }
  });

  it("refuses ASCII, big-endian, missing properties, unsupported types, list properties and other elements", async () => {
    const d = await dir();
    const gen = (i: number) => fixtureGaussian(i, 0);
    const cases: Array<[string, Parameters<typeof writeGaussianPly>[3]]> = [
      ["ascii", { shDegree: 0, format: "ascii" }],
      ["be", { shDegree: 0, format: "binary_big_endian" }],
      ["missing", { shDegree: 0, order: standardOrder(0).filter((n) => n !== "rot_3") }],
      ["rest7", { shDegree: 0, order: [...standardOrder(0), "f_rest_0", "f_rest_1"] }],
      ["element", { shDegree: 0, extraElement: true }],
    ];
    for (const [name, o] of cases) {
      const file = path.join(d, `${name}.ply`);
      await writeGaussianPly(file, 4, gen, o);
      expect([name, await code(inspectGaussianPlyFile(file))]).toEqual([name, "ply_invalid"]);
    }
  });

  it("refuses truncated and padded files, absurd counts, and non-finite or zero-rotation Gaussians", async () => {
    const d = await dir();
    const gen = (i: number) => fixtureGaussian(i, 1);
    const trunc = path.join(d, "trunc.ply");
    await writeGaussianPly(trunc, 10, gen, { shDegree: 1, declaredCount: 11 });
    expect(await code(inspectGaussianPlyFile(trunc))).toBe("ply_invalid");
    const pad = path.join(d, "pad.ply");
    await writeGaussianPly(pad, 10, gen, { shDegree: 1, trailing: 3 });
    expect(await code(inspectGaussianPlyFile(pad))).toBe("ply_invalid");
    const many = path.join(d, "many.ply");
    await writeGaussianPly(many, 10, gen, { shDegree: 1 });
    expect(await code(inspectGaussianPlyFile(many, { maxGaussians: 9 }))).toBe("ply_invalid");
    const nan = path.join(d, "nan.ply");
    await writeGaussianPly(nan, 10, (i) => (i === 7 ? { ...gen(i), scale: [NaN, 0, 0] } : gen(i)), {
      shDegree: 1,
    });
    await expect(inspectGaussianPlyFile(nan)).rejects.toThrow(/Gaussian 7 has a non-finite/);
    const zero = path.join(d, "zero.ply");
    await writeGaussianPly(zero, 10, (i) => (i === 3 ? { ...gen(i), rot: [0, 0, 0, 0] } : gen(i)), {
      shDegree: 1,
    });
    await expect(inspectGaussianPlyFile(zero)).rejects.toThrow(/zero-length rotation/);
    expect(await code(inspectGaussianPlyFile(path.join(d, "absent.ply")))).toBe("ply_missing");
  });

  it("streams across chunk boundaries with ONE bounded buffer (records never straddle incorrectly)", async () => {
    const d = await dir();
    const file = path.join(d, "big.ply");
    const n = 100_003; // not a multiple of the chunk size
    await writeGaussianPly(file, n, (i) => fixtureGaussian(i, 3, 50), { shDegree: 3 });
    const size = (await stat(file)).size;
    let count = 0;
    let checksum = 0;
    let outOfOrder = 0;
    const info = await scanGaussianPly(
      file,
      (g) => {
        if (g.index !== count) outOfOrder++;
        count++;
        checksum += g.rest[44]!;
      },
      { chunkGaussians: 4096 },
    );
    expect(count).toBe(n);
    expect(outOfOrder).toBe(0);
    expect(info.peakChunkBytes).toBe(4096 * info.stride);
    expect(info.peakChunkBytes).toBeLessThan(size / 20); // never the whole file
    let expected = 0;
    for (let i = 0; i < n; i++) expected += Math.fround(fixtureGaussian(i, 3, 50).rest[44]!);
    expect(checksum).toBeCloseTo(expected, 3);
    expect(size).toBeGreaterThan(20_000_000); // a genuinely large file (SH-3: 59 floats = 236 bytes per Gaussian)
  }, 120_000);
});

// ───────────────────────── SPZ conversion ─────────────────────────

async function decodeSpz(bytes: Uint8Array) {
  const r = new SpzReader({ fileBytes: bytes });
  await r.parseHeader();
  const n = r.numSplats;
  const out = {
    header: {
      version: r.version,
      numSplats: n,
      shDegree: r.shDegree,
      fractionalBits: r.fractionalBits,
      aa: r.flagAntiAlias,
    },
    centers: new Float64Array(n * 3),
    alpha: new Float64Array(n),
    rgb: new Float64Array(n * 3),
    scales: new Float64Array(n * 3),
    quats: new Float64Array(n * 4),
    sh: [] as number[][],
  };
  await r.parseSplats(
    (i, x, y, z) => out.centers.set([x, y, z], i * 3),
    (i, a) => (out.alpha[i] = a),
    (i, cr, cg, cb) => out.rgb.set([cr, cg, cb], i * 3),
    (i, sx, sy, sz) => out.scales.set([sx, sy, sz], i * 3),
    (i, qx, qy, qz, qw) => out.quats.set([qx, qy, qz, qw], i * 4),
    (i, s1, s2, s3) => (out.sh[i] = [...s1, ...(s2 ?? []), ...(s3 ?? [])]),
  );
  return out;
}

describe("PLY → SPZ (production converter, Spark's SpzWriter)", () => {
  it("round-trips through Spark's own SpzReader within the format's quantization (count, position, scale, rotation, opacity, colour, SH)", async () => {
    const d = await dir();
    const ply = path.join(d, "scene.ply");
    const spz = path.join(d, "scene.spz");
    const n = 2000;
    const gen = (i: number) => fixtureGaussian(i, 3, 12);
    await writeGaussianPly(ply, n, gen, { shDegree: 3 });
    const { report } = await convertPlyToSpz({ plyPath: ply, spzPath: spz, antialiased: false });
    expect(report).toMatchObject({
      encoder: SPZ_ENCODER,
      spzVersion: 3,
      lossless: false,
      shDegreeIn: 3,
      shDegreeOut: 3,
      shReduced: false,
      gaussianCount: n,
      clamped: { positions: 0 },
    });
    const bytes = await readFile(spz);
    expect(inspectSplat(bytes, "x.spz")).toMatchObject({ ok: true, format: "spz", gaussianCount: n });
    const dec = await decodeSpz(bytes);
    expect(dec.header).toMatchObject({
      version: 3,
      numSplats: n,
      shDegree: 3,
      fractionalBits: report.fractionalBits,
      aa: false,
    });

    // worst error per attribute, measured in units of that attribute's quantization step
    const worst = { position: 0, opacity: 0, color: 0, logScale: 0, sh1: 0, sh23: 0, angle: 0 };
    const up = (k: keyof typeof worst, v: number) => (worst[k] = Math.max(worst[k], v));
    for (let i = 0; i < n; i++) {
      const g = gen(i);
      // float32 storage adds ~1e-7 relative error on top of the fixed-point step
      for (const [c, v] of [g.x, g.y, g.z].entries())
        up("position", Math.abs(dec.centers[i * 3 + c]! - Math.fround(v)) * 2 ** report.fractionalBits);
      up("opacity", Math.abs(dec.alpha[i]! - 1 / (1 + Math.exp(-Math.fround(g.opacity)))) * 255);
      for (let c = 0; c < 3; c++)
        up(
          "color",
          (Math.abs(dec.rgb[i * 3 + c]! - (0.5 + SH_C0 * Math.fround(g.dc[c]))) * 255) / (SH_C0 / 0.15),
        );
      for (let c = 0; c < 3; c++)
        up("logScale", Math.abs(Math.log(dec.scales[i * 3 + c]!) - Math.fround(g.scale[c])) * 16);
      // rotation: the same orientation (q and -q are equal), normalized from the raw PLY quaternion
      const [w, x, y, z] = g.rot.map(Math.fround) as [number, number, number, number];
      const len = Math.hypot(w, x, y, z);
      const dot = Math.abs(
        (dec.quats[i * 4]! * x +
          dec.quats[i * 4 + 1]! * y +
          dec.quats[i * 4 + 2]! * z +
          dec.quats[i * 4 + 3]! * w) /
          len,
      );
      up("angle", 2 * Math.acos(Math.min(1, dot)));
      // SH: channel-major PLY → interleaved; 5-bit degree 1 (step 8/128), 4-bit degrees 2-3 (step 16/128)
      for (let k = 0; k < 15; k++)
        for (let c = 0; c < 3; c++) {
          const err = Math.abs(dec.sh[i]![k * 3 + c]! - Math.fround(g.rest[k + c * 15]!)) * 128;
          up(k < 3 ? "sh1" : "sh23", err / (k < 3 ? 8 : 16));
        }
    }
    expect(worst.position).toBeLessThanOrEqual(0.5 + 1e-3); // half a fixed-point step
    expect(worst.opacity).toBeLessThanOrEqual(0.5 + 1e-3); // half an 8-bit step
    expect(worst.color).toBeLessThanOrEqual(0.5 + 1e-3);
    expect(worst.logScale).toBeLessThanOrEqual(0.5 + 1e-3);
    expect(worst.sh1).toBeLessThanOrEqual(0.5 + 1 / 8 + 1e-3); // half a bucket (+ the 1/128 rounding)
    expect(worst.sh23).toBeLessThanOrEqual(0.5 + 1 / 16 + 1e-3);
    expect(worst.angle).toBeLessThan(0.01); // radians
  }, 60_000);

  it("keeps view-dependent colour: SH degree is preserved unless an explicit setting lowers it (and says so)", async () => {
    const d = await dir();
    const ply = path.join(d, "s.ply");
    await writeGaussianPly(ply, 10, (i) => fixtureGaussian(i, 2), { shDegree: 2 });
    const keep = await convertPlyToSpz({ plyPath: ply, spzPath: path.join(d, "a.spz"), antialiased: false });
    expect(keep.report).toMatchObject({ shDegreeIn: 2, shDegreeOut: 2, shReduced: false });
    const lowered = await convertPlyToSpz({
      plyPath: ply,
      spzPath: path.join(d, "b.spz"),
      antialiased: true,
      shDegree: 1,
    });
    expect(lowered.report).toMatchObject({
      shDegreeIn: 2,
      shDegreeOut: 1,
      shReduced: true,
      antialiased: true,
    });
    expect((await decodeSpz(await readFile(path.join(d, "b.spz")))).header).toMatchObject({
      shDegree: 1,
      aa: true,
    });
    expect(
      await code(
        convertPlyToSpz({ plyPath: ply, spzPath: path.join(d, "c.spz"), antialiased: false, shDegree: 3 }),
      ),
    ).toBe("spz_conversion_failed");
  });

  it("chooses fractional bits from the real extent: large scenes lose precision, never wrap; impossible ones are refused", async () => {
    expect(chooseFractionalBits(0)).toBe(12);
    expect(chooseFractionalBits(10)).toBe(12);
    expect(chooseFractionalBits(5000)).toBe(10); // 5000·2^10 = 5,120,000 ≤ 8,388,607
    expect(chooseFractionalBits(9_000_000)).toBeNull();
    const d = await dir();
    const ply = path.join(d, "far.ply");
    await writeGaussianPly(ply, 20, (i) => fixtureGaussian(i, 0, 6000), { shDegree: 0 });
    const { report } = await convertPlyToSpz({
      plyPath: ply,
      spzPath: path.join(d, "far.spz"),
      antialiased: false,
    });
    expect(report.fractionalBits).toBeLessThan(12);
    const dec = await decodeSpz(await readFile(path.join(d, "far.spz")));
    for (let i = 0; i < 20; i++) expect(dec.centers[i * 3]!).toBeCloseTo(fixtureGaussian(i, 0, 6000).x, 1);
    const huge = path.join(d, "huge.ply");
    await writeGaussianPly(huge, 5, (i) => ({ ...fixtureGaussian(i, 0), x: 1e7 }), { shDegree: 0 });
    expect(
      await code(convertPlyToSpz({ plyPath: huge, spzPath: path.join(d, "h.spz"), antialiased: false })),
    ).toBe("spz_conversion_failed");
  });

  it("normalizes non-unit quaternions (the orientation is kept) and counts values the format clamps", async () => {
    const d = await dir();
    const ply = path.join(d, "q.ply");
    const gen = (i: number): FixtureGaussian => ({
      ...fixtureGaussian(i, 1),
      rot: i === 0 ? [10, 0, 0, 0] : i === 1 ? [0, 0, 3, 0] : [2, 2, 2, 2],
      dc: i === 2 ? [40, 0, 0] : [0.1, 0.2, 0.3], // 0.5 + SH_C0·40 is far outside SPZ's colour range
      scale: i === 2 ? [-30, -1, -1] : [-2, -2, -2],
      rest: i === 2 ? [5, ...Array(8).fill(0)] : Array(9).fill(0.1),
    });
    await writeGaussianPly(ply, 3, gen, { shDegree: 1 });
    const { report } = await convertPlyToSpz({
      plyPath: ply,
      spzPath: path.join(d, "q.spz"),
      antialiased: false,
    });
    expect(report.clamped).toEqual({ positions: 0, colors: 1, scales: 1, sh: 1 });
    const dec = await decodeSpz(await readFile(path.join(d, "q.spz")));
    expect([...dec.quats.subarray(0, 4)].map((v) => Math.round(v * 100) / 100)).toEqual([0, 0, 0, 1]);
    expect(Math.abs(dec.quats[5]!)).toBeCloseTo(1, 2); // (w,x,y,z)=(0,0,3,0) → decoded (x,y,z,w) = (0,±1,0,0)
    expect([...dec.quats.subarray(8, 12)].every((v) => Math.abs(v - 0.5) < 0.01)).toBe(true);
  });

  it("refuses a result over the splat size limit and a conversion over the memory bound; writes nothing partial", async () => {
    const d = await dir();
    const ply = path.join(d, "m.ply");
    await writeGaussianPly(ply, 5000, (i) => fixtureGaussian(i, 3), { shDegree: 3 });
    const spz = path.join(d, "m.spz");
    expect(
      await code(convertPlyToSpz({ plyPath: ply, spzPath: spz, antialiased: false, maxSpzBytes: 1000 })),
    ).toBe("result_too_large");
    expect(
      await code(convertPlyToSpz({ plyPath: ply, spzPath: spz, antialiased: false, maxRawBytes: 10_000 })),
    ).toBe("result_too_large");
    await expect(stat(spz)).rejects.toThrow();
    await expect(stat(`${spz}.partial`)).rejects.toThrow();
  });

  it("stops on cancellation", async () => {
    const d = await dir();
    const ply = path.join(d, "c.ply");
    await writeGaussianPly(ply, 20_000, (i) => fixtureGaussian(i, 1), { shDegree: 1 });
    const ac = new AbortController();
    ac.abort();
    expect(
      await code(
        convertPlyToSpz({
          plyPath: ply,
          spzPath: path.join(d, "c.spz"),
          antialiased: false,
          signal: ac.signal,
        }),
      ),
    ).toBe("cancelled");
  });

  it("names the encoder at the exact pinned Spark version", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), "node_modules/@sparkjsdev/spark/package.json"), "utf8"),
    ) as { version: string; license: string };
    expect(SPZ_ENCODER).toBe(`@sparkjsdev/spark@${pkg.version} SpzWriter`);
    expect(pkg.license).toBe("MIT");
    const root = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(root.dependencies["@sparkjsdev/spark"]).toBe(pkg.version); // pinned exactly
  });
});

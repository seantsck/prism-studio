import { gzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_SPLAT_BYTES } from "@/domain/previs/splat";
import { inspectSplat } from "../inspect";
import { encodePlyFile, encodeSplatFile, encodeSpzFile, syntheticPlane } from "../synthetic";

const gs = syntheticPlane({ n: 8 }); // 64 Gaussians
const ok = (bytes: Uint8Array, name: string) => {
  const r = inspectSplat(bytes, name);
  if (!r.ok) throw new Error(r.error);
  return r;
};
const err = (bytes: Uint8Array, name: string) => {
  const r = inspectSplat(bytes, name);
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.error;
};

describe("splat inspection: the enabled formats", () => {
  it(".splat: validated, counted, truthful MIME", () => {
    expect(ok(encodeSplatFile(gs), "plane.splat")).toMatchObject({
      format: "splat",
      mime: "application/x-gaussian-splat",
      gaussianCount: 64,
    });
  });
  it("Gaussian .ply: validated, counted, truthful MIME", () => {
    expect(ok(encodePlyFile(gs), "plane.ply")).toMatchObject({
      format: "ply",
      mime: "application/x-ply",
      gaussianCount: 64,
    });
  });
  it(".spz: validated against its header, counted, truthful MIME", () => {
    expect(ok(encodeSpzFile(gs), "plane.spz")).toMatchObject({
      format: "spz",
      mime: "application/x-spz",
      gaussianCount: 64,
    });
  });
  it("the extension is case-insensitive", () => {
    expect(ok(encodeSplatFile(gs), "PLANE.SPLAT").format).toBe("splat");
  });
});

describe("splat inspection: refusals", () => {
  it("empty, oversize and unsupported extensions", () => {
    expect(err(new Uint8Array(0), "a.splat")).toMatch(/empty/i);
    expect(err(new Uint8Array(MAX_SPLAT_BYTES + 32), "a.splat")).toMatch(/50 MB/);
    expect(err(encodeSplatFile(gs), "a.glb")).toMatch(/unsupported/i);
    expect(err(encodeSplatFile(gs), "a.ksplat")).toMatch(/unsupported/i);
    expect(err(encodeSplatFile(gs), "noextension")).toMatch(/unsupported/i);
  });
  it("a renamed file whose bytes are another format", () => {
    expect(err(encodePlyFile(gs), "a.splat")).toMatch(/named \.splat/);
    expect(err(encodeSpzFile(gs), "a.ply")).toMatch(/named \.ply/);
    expect(err(encodeSplatFile(gs), "a.spz")).toMatch(/named \.spz/);
  });
  it(".splat: truncated size and non-finite values", () => {
    expect(err(encodeSplatFile(gs).subarray(0, 100), "a.splat")).toMatch(/32-byte/);
    const bad = encodeSplatFile(gs);
    new DataView(bad.buffer).setFloat32(0, Number.NaN, true);
    expect(err(bad, "a.splat")).toMatch(/non-finite/);
  });
  it("PLY: not Gaussian, ASCII, truncated, padded", () => {
    const plain = new TextEncoder().encode(
      "ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n" +
        "\0\0\0\0\0\0\0\0\0\0\0\0",
    );
    expect(err(plain, "a.ply")).toMatch(/not a Gaussian splat/);
    const ascii = new TextEncoder().encode("ply\nformat ascii 1.0\nelement vertex 0\nend_header\n");
    expect(err(ascii, "a.ply")).toMatch(/binary little-endian/);
    const full = encodePlyFile(gs);
    expect(err(full.subarray(0, full.length - 4), "a.ply")).toMatch(/size does not match/);
    const padded = new Uint8Array(full.length + 4);
    padded.set(full);
    expect(err(padded, "a.ply")).toMatch(/size does not match/);
    expect(err(new TextEncoder().encode("ply\nformat binary_little_endian 1.0\n"), "a.ply")).toMatch(
      /valid PLY/,
    );
  });
  it("SPZ: not gzip, wrong header, truncated, and a decompression bomb", () => {
    expect(err(new Uint8Array(40).fill(7), "a.spz")).toMatch(/named .spz/);
    expect(err(gzipSync(new Uint8Array(64)), "a.spz")).toMatch(/bad header/i);
    const good = encodeSpzFile(gs);
    expect(err(good.subarray(0, good.length - 12), "a.spz")).toMatch(/corrupt|truncated/i);
    // header claims 4 Gaussians but is followed by a megabyte of zeroes
    const bomb = new Uint8Array(16 + 1_000_000);
    const v = new DataView(bomb.buffer);
    v.setUint32(0, 0x5053474e, true);
    v.setUint32(4, 2, true);
    v.setUint32(8, 4, true);
    bomb[13] = 12;
    expect(err(gzipSync(bomb), "a.spz")).toMatch(/larger than its header/i);
    // a header that claims more Gaussians than allowed
    const huge = new Uint8Array(16);
    const hv = new DataView(huge.buffer);
    hv.setUint32(0, 0x5053474e, true);
    hv.setUint32(4, 2, true);
    hv.setUint32(8, 50_000_000, true);
    expect(err(gzipSync(huge), "a.spz")).toMatch(/too many/i);
  });
});

import { describe, expect, it } from "vitest";
import { readImageSize } from "../image-size";
import { assertPathInProject, buildObjectPath, safeFileName } from "../storage-paths";
import { checkUpload, sniffUpload } from "../upload-policy";
import { makeWav } from "./audio-fixtures";

const PROJECT = "7b5fdc2d-d7dd-464d-a9cc-e6834bcada91";
const ASSET = "11111111-2222-4333-8444-555555555555";

/** Minimal valid-looking PNG header with a given size. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const v = new DataView(b.buffer);
  v.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

describe("upload policy", () => {
  it("identifies real formats by magic bytes, not by name", () => {
    expect(sniffUpload(png(10, 10))?.mime).toBe("image/png");
    expect(sniffUpload(makeWav({ seconds: 0.1 }))?.mime).toBe("audio/wav");
    expect(sniffUpload(new TextEncoder().encode("MZ\u0090\u0000 this is an exe....."))).toBeNull();
  });

  it("accepts a valid file for an allowed kind and returns the detected mime", () => {
    const r = checkUpload({ name: "take1.wav", size: 5000, claimedMime: "audio/wav" }, makeWav({ seconds: 0.2 }), ["audio"]);
    expect(r).toMatchObject({ ok: true, mime: "audio/wav", kind: "audio" });
  });

  it("rejects the wrong kind for the call site", () => {
    const r = checkUpload({ name: "x.png", size: 40, claimedMime: "image/png" }, png(4, 4), ["audio"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Expected audio/);
  });

  it("rejects executables and scriptable types regardless of content", () => {
    for (const name of ["setup.exe", "run.sh", "a.js", "page.html", "logo.svg", "x.php"]) {
      expect(checkUpload({ name, size: 100 }, png(1, 1), ["image"]).ok).toBe(false);
    }
  });

  it("detects MIME spoofing between families and empty uploads", () => {
    const spoof = checkUpload({ name: "a.png", size: 40, claimedMime: "audio/wav" }, png(4, 4), ["image", "audio"]);
    expect(spoof.ok).toBe(false);
    expect(spoof.reason).toMatch(/does not match/);
    expect(checkUpload({ name: "a.wav", size: 0 }, new Uint8Array(), ["audio"]).reason).toMatch(/empty/);
  });

  it("enforces per-kind size limits", () => {
    const big = new Uint8Array(26 * 1024 * 1024);
    big.set(png(2, 2));
    const r = checkUpload({ name: "big.png", size: big.length, claimedMime: "image/png" }, big, ["image"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too large/);
  });
});

describe("storage paths", () => {
  it("builds <project>/<asset>/<sanitised name> and strips traversal", () => {
    expect(buildObjectPath(PROJECT, ASSET, "../../etc/passwd")).toBe(`${PROJECT}/${ASSET}/passwd`);
    expect(buildObjectPath(PROJECT, ASSET, "Take 1 (final).wav")).toBe(`${PROJECT}/${ASSET}/Take_1_final_.wav`);
    expect(safeFileName("")).toBe("file");
    expect(safeFileName("..")).toBe("file");
    expect(safeFileName("a".repeat(300)).length).toBeLessThanOrEqual(100);
  });

  it("refuses non-uuid components and paths outside the project", () => {
    expect(() => buildObjectPath("not-a-uuid", ASSET, "a.png")).toThrow();
    expect(() => assertPathInProject(`${PROJECT}/${ASSET}/a.png`, PROJECT)).not.toThrow();
    expect(() => assertPathInProject(`${PROJECT}/${ASSET}/../x`, PROJECT)).toThrow();
    expect(() => assertPathInProject(`22222222-2222-4222-8222-222222222222/${ASSET}/a.png`, PROJECT)).toThrow();
    expect(() => assertPathInProject(`${PROJECT}/${ASSET}`, PROJECT)).toThrow();
  });
});

describe("image size", () => {
  it("reads PNG dimensions", () => {
    expect(readImageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });
  it("returns null for unknown data", () => {
    expect(readImageSize(new Uint8Array(40))).toBeNull();
  });
});

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jpegBytes } from "../../local/__tests__/fixtures";
import {
  AcceptanceInputError,
  checkOutputDirectory,
  comparePhotoNames,
  imageDimensions,
  scanPhotoDirectory,
} from "../photos";
import { encodePng } from "../synthetic";

const REPO = process.cwd();
let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "prism-acceptance-photos-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** a distinct, valid PNG of the given size */
const png = (seed: number, w = 4, h = 3) => encodePng(w, h, new Uint8Array(w * h * 3).fill(seed % 256));

async function dirWith(files: Record<string, Uint8Array | string>) {
  const d = path.join(tmp, "photos");
  await mkdir(d, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(d, name), body);
  return d;
}

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "accepted";
  } catch (e) {
    if (e instanceof AcceptanceInputError) return e.message;
    throw e;
  }
}

describe("photo directory", { timeout: 60_000 }, () => {
  it("orders by code point, identifies type by bytes (not extension), skips what is not a photo, never writes", async () => {
    const d = await dirWith({
      "b.png": png(2),
      "C.png": png(3),
      "a10.jpg": jpegBytes(10),
      "a2.jpg": jpegBytes(2),
      "really-a-png.txt": png(9),
      "fake.jpg": "not an image",
      "notes.md": "# capture notes",
    });
    await mkdir(path.join(d, "sub"));
    await writeFile(path.join(d, "sub", "inside.png"), png(5));
    const scan = await scanPhotoDirectory(d, { repoRoot: REPO });
    // upper case sorts before lower case, "a10" before "a2": code-point order, the same on every machine
    expect(scan.photos.map((p) => path.basename(p.path))).toEqual([
      "C.png",
      "a10.jpg",
      "a2.jpg",
      "b.png",
      "really-a-png.txt",
    ]);
    expect(scan.photos.map((p) => p.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(scan.photos.map((p) => p.mime)).toEqual([
      "image/png",
      "image/jpeg",
      "image/jpeg",
      "image/png",
      "image/png",
    ]);
    expect(scan.skipped).toEqual({ links: 0, directories: 1, notImages: 2 });
    expect(scan.photos[0]).toMatchObject({ width: 4, height: 3 });
    expect(scan.photos.every((p) => /^[0-9a-f]{64}$/.test(p.sha256))).toBe(true);
    expect(["b", "a", "B", "a2", "a10"].sort(comparePhotoNames)).toEqual(["B", "a", "a10", "a2", "b"]);
  });

  it("refuses too few, too many and duplicate photographs, a relative path, a file, and anything inside the repository", async () => {
    expect(
      await refused(
        scanPhotoDirectory(await dirWith({ "1.png": png(1), "2.png": png(2) }), { repoRoot: REPO }),
      ),
    ).toMatch(/Found 2 JPEG\/PNG photographs; at least 3/);
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 301; i++)
      many[`p${String(i).padStart(3, "0")}.png`] = png(i, 2 + (i % 7), 2 + Math.floor(i / 7));
    expect(await refused(scanPhotoDirectory(await dirWith(many), { repoRoot: REPO }))).toMatch(/at most 300/);
    await rm(path.join(tmp, "photos"), { recursive: true });
    expect(
      await refused(
        scanPhotoDirectory(await dirWith({ "1.png": png(1), "2.png": png(1), "3.png": png(3) }), {
          repoRoot: REPO,
        }),
      ),
    ).toMatch(/duplicate/);
    expect(await refused(scanPhotoDirectory("photos", { repoRoot: REPO }))).toMatch(/absolute/);
    expect(await refused(scanPhotoDirectory(path.join(REPO, "package.json"), { repoRoot: REPO }))).toMatch(
      /not a directory/,
    );
    expect(await refused(scanPhotoDirectory(path.join(REPO, "src"), { repoRoot: REPO }))).toMatch(
      /OUTSIDE the Prism repository/,
    );
  });

  it("never follows a link out of the chosen directory", async () => {
    const outside = path.join(tmp, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.png"), png(77));
    const d = await dirWith({ "1.png": png(1), "2.png": png(2), "3.png": png(3) });
    let linked = 0;
    // a file symlink needs a privilege on Windows; a directory junction does not
    await symlink(path.join(outside, "secret.png"), path.join(d, "4.png")).then(
      () => linked++,
      () => undefined,
    );
    await symlink(outside, path.join(d, "dirlink"), "junction").then(
      () => linked++,
      () => undefined,
    );
    const scan = await scanPhotoDirectory(d, { repoRoot: REPO });
    expect(scan.photos.map((p) => path.basename(p.path))).toEqual(["1.png", "2.png", "3.png"]);
    expect(scan.skipped.links + scan.skipped.directories).toBe(linked);
    expect(scan.photos.some((p) => p.path.includes("outside"))).toBe(false);
  });

  it("reads image dimensions from PNG and JPEG headers only", () => {
    expect(imageDimensions(png(1, 640, 480))).toEqual({ width: 640, height: 480 });
    // SOI, APP0, SOF0 (height 300, width 400)
    const jpg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0x2c, 0x01, 0x90, 3, 0, 0, 0, 0,
    ]);
    expect(imageDimensions(jpg)).toEqual({ width: 400, height: 300 });
    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("output directory", () => {
  it("must be absolute, outside the repository, not inside the photos, and new or empty", async () => {
    const photos = await dirWith({ "1.png": png(1) });
    await expect(
      checkOutputDirectory(path.join(tmp, "out"), { repoRoot: REPO, inputDir: photos }),
    ).resolves.toBeUndefined();
    expect(await refused(checkOutputDirectory("out", { repoRoot: REPO }))).toMatch(/absolute/);
    expect(
      await refused(checkOutputDirectory(path.join(REPO, "acceptance", "x"), { repoRoot: REPO })),
    ).toMatch(/outside the Prism repository/);
    expect(
      await refused(checkOutputDirectory(path.join(photos, "out"), { repoRoot: REPO, inputDir: photos })),
    ).toMatch(/inside the photo directory/);
    expect(await refused(checkOutputDirectory(tmp, { repoRoot: REPO, inputDir: photos }))).toMatch(
      /nor contain it/,
    );
    const used = path.join(tmp, "used");
    await mkdir(used);
    await writeFile(path.join(used, "acceptance-report.json"), "{}");
    expect(await refused(checkOutputDirectory(used, { repoRoot: REPO }))).toMatch(/new or empty/);
  });
});

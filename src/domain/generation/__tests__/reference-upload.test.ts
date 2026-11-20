import { describe, expect, it } from "vitest";
import { referenceOriginLabel } from "../reference-integrity";
import {
  copyReasons,
  copySize,
  copyTries,
  fileSize,
  parseUploadCopy,
  planUpload,
  uploadCopyName,
  uploadCopySentence,
  type UploadCandidate,
} from "../reference-upload";

const MB = 1024 * 1024;
const photo = (over: Partial<UploadCandidate> = {}): UploadCandidate => ({
  name: "IMG_2041.jpg",
  mime: "image/jpeg",
  bytes: 2.8 * MB,
  width: 3024,
  height: 4032,
  orientation: 1,
  ...over,
});

describe("what is sent for a chosen photograph", () => {
  it("the file itself, whenever one upload can carry it and it is stored upright", () => {
    expect(planUpload(photo(), 25 * MB)).toEqual({ action: "send" });
    expect(planUpload(photo({ orientation: null }), 4 * MB)).toEqual({ action: "send" });
    // exactly at the limit still fits
    expect(planUpload(photo({ bytes: 4 * MB }), 4 * MB)).toEqual({ action: "send" });
    expect(planUpload(photo({ mime: "image/png", name: "a.png" }), 4 * MB)).toEqual({ action: "send" });
    expect(planUpload(photo({ mime: "IMAGE/JPG" }), 4 * MB)).toEqual({ action: "send" });
  });

  it("a smaller copy when the file is more than one upload can carry", () => {
    expect(planUpload(photo({ bytes: 8.2 * MB, width: 6000, height: 8000 }), 4 * MB)).toEqual({
      action: "copy",
      reasons: ["too_large"],
      longSides: [2048, 1536],
    });
    // a heavy file that is already small in pixels is re-encoded at its own size first, never enlarged
    expect(
      planUpload(photo({ bytes: 6 * MB, width: 1200, height: 1600, mime: "image/png" }), 4 * MB),
    ).toEqual({ action: "copy", reasons: ["too_large"], longSides: [1600, 1536] });
    expect(planUpload(photo({ bytes: 6 * MB, width: 900, height: 1200 }), 4 * MB)).toEqual({
      action: "copy",
      reasons: ["too_large"],
      longSides: [1200],
    });
  });

  it("an upright copy at the picture's own size when the camera stored it turned", () => {
    expect(planUpload(photo({ orientation: 6 }), 25 * MB)).toEqual({
      action: "copy",
      reasons: ["turned"],
      longSides: [4032, 2048, 1536],
    });
    // larger than a browser reliably draws: the copy is capped
    expect(planUpload(photo({ orientation: 8, width: 6048, height: 8064 }), 25 * MB)).toEqual({
      action: "copy",
      reasons: ["turned"],
      longSides: [4096, 2048, 1536],
    });
    expect(planUpload(photo({ orientation: 3, bytes: 9 * MB }), 4 * MB)).toEqual({
      action: "copy",
      reasons: ["turned", "too_large"],
      longSides: [2048, 1536],
    });
  });

  it("nothing, with the reason, for a format Prism does not take or a file that will not open", () => {
    expect(planUpload(photo({ name: "IMG_1.HEIC", mime: "image/heic" }), 25 * MB)).toMatchObject({
      action: "refuse",
      reason: "format",
      message: expect.stringMatching(/^HEIC photos \(the iPhone camera format\)/),
    });
    // a browser that does not know the type reports none: the file name is all there is
    expect(planUpload(photo({ name: "IMG_1.heic", mime: "" }), 25 * MB)).toMatchObject({
      reason: "format",
      message: expect.stringMatching(/^HEIC photos/),
    });
    expect(planUpload(photo({ name: "loop.gif", mime: "image/gif" }), 25 * MB)).toMatchObject({
      reason: "format",
      message: "GIF files cannot be added here. Save the picture as JPEG, PNG or WebP and add that.",
    });
    expect(planUpload(photo({ name: "notes.txt", mime: "text/plain" }), 25 * MB)).toMatchObject({
      reason: "format",
      message: "This is not a JPEG, PNG or WebP picture.",
    });
    expect(planUpload(photo({ width: null, height: null }), 25 * MB)).toMatchObject({
      action: "refuse",
      reason: "unreadable",
    });
  });
});

describe("a copy made in the browser", () => {
  it("keeps the picture's shape and is never larger than the picture", () => {
    expect(copySize(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 });
    expect(copySize(8000, 6000, 1536)).toEqual({ width: 1536, height: 1152 });
    expect(copySize(900, 1200, 2048)).toEqual({ width: 900, height: 1200 });
    expect(copySize(5000, 3, 1536)).toEqual({ width: 1536, height: 1 });
  });

  it("gives up resolution last: a JPEG is tried a little more compressed before it is made smaller", () => {
    const plan = planUpload(photo({ orientation: 6 }), 4 * MB);
    if (plan.action !== "copy") throw new Error("expected a copy");
    expect(copyTries(plan, true)).toEqual([
      { longSide: 4032, quality: 0.92 },
      { longSide: 4032, quality: 0.85 },
      { longSide: 2048, quality: 0.92 },
      { longSide: 1536, quality: 0.92 },
    ]);
    // a PNG or WebP is written as WebP at one quality
    expect(copyTries(plan, false)).toEqual([
      { longSide: 4032, quality: 0.9 },
      { longSide: 2048, quality: 0.9 },
      { longSide: 1536, quality: 0.9 },
    ]);
  });

  it("an upright copy that had to be made smaller to fit is recorded as a smaller copy too", () => {
    const picture = { width: 3024, height: 4032 };
    expect(copyReasons(["turned"], picture, picture)).toEqual(["turned"]);
    expect(copyReasons(["turned"], picture, { width: 1536, height: 2048 })).toEqual(["turned", "too_large"]);
    expect(copyReasons(["too_large"], picture, { width: 1536, height: 2048 })).toEqual(["too_large"]);
    expect(copyReasons(["turned", "too_large"], picture, { width: 1152, height: 1536 })).toEqual([
      "turned",
      "too_large",
    ]);
    // a heavy file re-encoded at its own size is still a copy made because it was too large
    expect(copyReasons(["too_large"], picture, picture)).toEqual(["too_large"]);
  });

  it("carries its own name, in the format it was written in", () => {
    expect(uploadCopyName("IMG_2041.JPG", 1536, 2048, "image/jpeg")).toBe("IMG_2041-copy-1536x2048.jpg");
    expect(uploadCopyName("scan.final.png", 1200, 1600, "image/webp")).toBe("scan.final-copy-1200x1600.webp");
    expect(uploadCopyName(".jpg", 10, 10, "image/png")).toBe("photo-copy-10x10.png");
  });

  it("is recorded with the file that was chosen; anything malformed is no record", () => {
    const record = {
      name: "IMG_2041.jpg",
      bytes: 8598323,
      width: 3024,
      height: 4032,
      reasons: ["turned", "too_large"],
    };
    expect(parseUploadCopy(JSON.stringify(record))).toEqual(record);
    expect(parseUploadCopy(record)).toEqual(record);
    expect(
      parseUploadCopy(JSON.stringify({ ...record, reasons: ["too_large", "too_large", "nonsense"] })),
    ).toEqual({ ...record, reasons: ["too_large"] });
    for (const bad of [
      "",
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...record, reasons: [] }),
      JSON.stringify({ ...record, reasons: ["because"] }),
      JSON.stringify({ ...record, name: "  " }),
      JSON.stringify({ ...record, bytes: -1 }),
      JSON.stringify({ ...record, width: "3024" }),
      JSON.stringify({ ...record, name: "x".repeat(2000) }),
      undefined,
      42,
    ])
      expect(parseUploadCopy(bad), String(bad)).toBeNull();
    // a long name is kept short, not refused
    expect(parseUploadCopy({ ...record, name: "n".repeat(500) })!.name).toHaveLength(200);
  });

  it("is described in one sentence that says what it is, why, and that the chosen file was not uploaded", () => {
    const base = { name: "IMG_2041.jpg", bytes: 8.2 * MB, width: 3024, height: 4032 };
    expect(uploadCopySentence({ ...base, reasons: ["too_large"] })).toBe(
      "A smaller copy made in the browser when it was added: one upload here could not carry it at full size. The file chosen was IMG_2041.jpg (3024 × 4032, 8.2 MB); it was not uploaded.",
    );
    expect(uploadCopySentence({ ...base, reasons: ["turned"] })).toMatch(
      /^An upright copy made in the browser when it was added: the camera had stored the photo turned, with a rotation flag\./,
    );
    expect(uploadCopySentence({ ...base, reasons: ["turned", "too_large"] })).toMatch(
      /^An upright, smaller copy .* rotation flag, and one upload here could not carry it at full size\./,
    );
  });

  it("is never labelled an original once it is stored", () => {
    const uploadCopy = {
      name: "IMG_2041.jpg",
      bytes: 8598323,
      width: 3024,
      height: 4032,
      reasons: ["turned"],
    };
    expect(referenceOriginLabel({ source: "upload", metadata: {} })).toBe("uploaded original");
    expect(referenceOriginLabel({ source: "upload", metadata: { uploadCopy } })).toBe("uploaded copy");
    // only an upload can be a browser-made copy
    expect(referenceOriginLabel({ source: "generated", metadata: { uploadCopy } })).toBe(
      "generated reference",
    );
    expect(referenceOriginLabel(null)).toBe("");
  });

  it("file sizes read the way people say them", () => {
    expect(fileSize(53204)).toBe("52 KB");
    expect(fileSize(300)).toBe("1 KB");
    expect(fileSize(4 * MB)).toBe("4.0 MB");
    expect(fileSize(null)).toBe("");
  });
});

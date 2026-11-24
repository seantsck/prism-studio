import { describe, expect, it } from "vitest";
import { fullUrl, previewUrl } from "../utils";

const id = "3f0cf017-85d0-43b4-bac9-c8966193af50";

describe("picture preview URLs", () => {
  it("a stored picture is shown as its preview; anything else, or nothing stored, as before", () => {
    expect(previewUrl({ id, objectPath: "p/a/x.png", type: "image" })).toBe(`/api/assets/${id}/preview`);
    expect(previewUrl({ id, objectPath: "p/a/x.png", type: "reference", mime: "image/png" })).toBe(
      `/api/assets/${id}/preview`,
    );
    expect(previewUrl({ id, objectPath: "p/a/x.mp4", type: "video", mime: "video/mp4" })).toBe(
      `/api/assets/${id}`,
    );
    expect(previewUrl({ id, objectPath: null, type: "image" })).toBeNull();
  });

  it("the original behind a preview, for enlarging and downloading; other URLs unchanged", () => {
    expect(fullUrl(`/api/assets/${id}/preview`)).toBe(`/api/assets/${id}`);
    expect(fullUrl(`/api/assets/${id}`)).toBe(`/api/assets/${id}`);
    expect(fullUrl("blob:https://x/1")).toBe("blob:https://x/1");
  });
});

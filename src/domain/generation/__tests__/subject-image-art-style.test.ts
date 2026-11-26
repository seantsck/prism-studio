import { describe, expect, it } from "vitest";
import { seed } from "../../__tests__/helpers";
import type { Asset, ProjectData } from "../../schemas";
import { buildSubjectImagePlan, MAX_ART_STYLE_CHARS } from "../subject-image";

/**
 * An animated Character (migration 0070): drawn in the art style the creator wrote, from a real person's photos. The
 * photos decide WHO it is; the style decides how it is drawn, so "a photograph stays a photograph" does not apply.
 */
function photo(data: ProjectData): Asset {
  const asset = {
    ...data.assets[0]!,
    id: "00000000-0000-4000-8000-0000000000a1",
    type: "image",
    purpose: "identity_ref",
    source: "upload",
    name: "photo",
    storageProvider: "local",
    objectPath: "p/a1/photo.jpg",
    mime: "image/jpeg",
    byteSize: 1000,
    checksum: "a".repeat(64),
    width: 1200,
    height: 1600,
    metadata: {},
  } as Asset;
  data.assets.push(asset);
  return asset;
}
const lines = (plan: ReturnType<typeof buildSubjectImagePlan>, key: string) =>
  plan.plan.sections.find((s) => s.key === key)?.lines ?? [];

describe("an animated Character's pictures", () => {
  it("are drawn in its style from the photos, which keep the likeness, and are never photographs", () => {
    const data = seed();
    const sean = data.characters.find((c) => c.name === "Sean")!;
    sean.artStyle = "  anime  ";
    const p = photo(data);
    const plan = buildSubjectImagePlan(data, {
      subject: { kind: "character", characterId: sean.id, intent: "portrait" },
      direction: "",
      sourceAssetIds: [p.id],
    });
    expect(plan.operation).toBe("reference");
    expect(lines(plan, "identity")[0]).toBe(
      "The same person as in the identity reference image, drawn in the art style below: keep their recognisable face shape, eyes, nose, mouth, skin tone, hair, apparent age and build, translated into the style, so anyone who knows them recognises them.",
    );
    expect(lines(plan, "hard_constraints")).toEqual([
      "Draw it as anime: a stylised illustration in that style, not a photograph, even where the reference images are photographs. Every picture of this character is in this same style.",
    ]);
    expect(plan.positive).not.toContain("a photograph stays a photograph");
    expect(plan.negative).toContain("photograph, photorealistic, live action");
    expect(plan.packageSnapshot).toMatchObject({ subject: { artStyle: "anime" } });
  });

  it("change the request's fingerprint when the style changes, and a Character without one is drawn as before", () => {
    const data = seed();
    const sean = data.characters.find((c) => c.name === "Sean")!;
    const p = photo(data);
    const input = {
      subject: { kind: "character" as const, characterId: sean.id, intent: "portrait" as const },
      direction: "",
      sourceAssetIds: [p.id],
    };
    const plain = buildSubjectImagePlan(data, input);
    expect(lines(plain, "hard_constraints")).toEqual([
      "Keep the rendering style of the reference image: a photograph stays a photograph.",
    ]);
    expect(plain.negative).not.toContain("photorealistic");
    sean.artStyle = "3D animated film";
    const animated = buildSubjectImagePlan(data, input);
    expect(animated.packageFingerprint).not.toBe(plain.packageFingerprint);
    sean.artStyle = "x".repeat(500);
    expect(
      (buildSubjectImagePlan(data, input).packageSnapshot as { subject: { artStyle: string } }).subject.artStyle,
    ).toHaveLength(MAX_ART_STYLE_CHARS);
  });
});

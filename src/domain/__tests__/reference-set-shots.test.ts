import { describe, expect, it } from "vitest";
import { isReferenceSetRef, liveAppearance } from "@/domain/character-continuity";
import type { IdentityRef } from "@/domain/schemas";

/**
 * What a Shot is sent for a Character once the Reference Studio has filled the reference set: the set (canonical
 * first), the expression and cutout designations, and NOT also every plain extra reference the set was made from.
 */
const ref = (id: string, over: Partial<IdentityRef> = {}): IdentityRef => ({
  id,
  characterId: "c1",
  slot: "additional",
  assetId: `asset-${id}`,
  label: id,
  metadata: {},
  locked: false,
  ...over,
});

describe("a Shot's Character references", () => {
  const photo1 = ref("photo1", { label: "Reference photo", metadata: { source: "upload" } });
  const photo2 = ref("photo2", { label: "Reference photo", metadata: { source: "upload" } });
  const canonical = ref("canonical", { metadata: { visualRole: "canonical" } });
  const front = ref("front", { slot: "front", assetId: "asset-canonical" });
  const threeQuarter = ref("tq", { slot: "three_quarter" });
  const right = ref("right", { metadata: { view: "right_profile" } });
  const expression = ref("smile", { metadata: { visualRole: "expression", expression: "happy" } });
  const placeholder = ref("ph", { slot: "profile", assetId: "asset-placeholder" });

  it("tells the set apart from plain extra references", () => {
    expect([photo1, canonical, front, threeQuarter, right, expression].map(isReferenceSetRef)).toEqual([
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it("with a stored set image, a Shot gets the set (canonical first) and the designations, not the raw photos", () => {
    const stored = new Set([
      "asset-photo1",
      "asset-photo2",
      "asset-canonical",
      "asset-tq",
      "asset-right",
      "asset-smile",
    ]);
    const a = liveAppearance({
      character: null,
      look: null,
      identityRefs: [photo1, photo2, front, threeQuarter, right, canonical, expression, placeholder],
      hasImage: (id) => stored.has(id),
    });
    expect(a.identityReferenceAssetIds).toEqual([
      "asset-canonical",
      "asset-canonical",
      "asset-tq",
      "asset-right",
      "asset-placeholder",
      "asset-smile",
    ]);
    expect(a.identityReferenceAssetIds).not.toContain("asset-photo1");
    expect(a.canonicalIdentityAssetId).toBe("asset-canonical");
  });

  it("until the set holds a stored image (only seed placeholders), every reference is sent as before", () => {
    const stored = new Set(["asset-photo1", "asset-photo2"]);
    const refs = [photo1, photo2, placeholder];
    const a = liveAppearance({
      character: null,
      look: null,
      identityRefs: refs,
      hasImage: (id) => stored.has(id),
    });
    expect(a.identityReferenceAssetIds).toEqual(["asset-photo1", "asset-photo2", "asset-placeholder"]);
    // and a caller that cannot say which images are stored is unchanged
    const b = liveAppearance({ character: null, look: null, identityRefs: [photo1, canonical] });
    expect(b.identityReferenceAssetIds).toEqual(["asset-canonical", "asset-photo1"]);
  });
});

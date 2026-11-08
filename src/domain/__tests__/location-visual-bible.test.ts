import { describe, expect, it } from "vitest";
import { buildSeedProject } from "../../data/seed";
import { buildShotContext } from "../context";
import { approvalSnapshot } from "../fingerprint";
import { assembleGenerationPackage, type GenerationPackage } from "../generation-package";
import { deriveProductionFrameReferenceCandidates } from "../generation/compatibility";
import {
  irrelevantVariantAssetIds,
  locationBibleAssetIds,
  locationBibleReferences,
  locationBibleReadiness,
  locationVisualBibleSchema,
  variantIsRelevant,
} from "../location-visual-bible";

/** Phase 5B-I5 (pure): relevance, priority, and the "unchanged when unused" guarantees. */
const NOW = new Date("2026-11-08T00:00:00Z");

describe("Location Visual Bible domain", () => {
  it("variants are free labels matched against the Shot's time-of-day words, never a rigid list", () => {
    expect(variantIsRelevant("night", "night indoors night")).toBe(true);
    expect(variantIsRelevant("rainy night", "night rain")).toBe(true);
    expect(variantIsRelevant("golden hour", "night")).toBe(false);
    expect(variantIsRelevant("after the gala", "after the gala, late")).toBe(true);
    expect(variantIsRelevant("", "night")).toBe(false);
    expect(locationVisualBibleSchema.parse({})).toEqual({});
    expect(() =>
      locationVisualBibleSchema.parse({ entries: [{ assetId: "a", role: "angle", label: "" }] }),
    ).toThrow();
  });

  it("orders canonical, establishing, plates, then relevant variants; irrelevant variants are kept out", () => {
    const loc = {
      ...buildSeedProject().locations[0]!,
      name: "Lobby",
      referenceAssetIds: ["loose", "v-day"],
      visualBible: {
        canonicalAssetId: "canon",
        entries: [
          { assetId: "v-day", role: "variant" as const, label: "day" },
          { assetId: "plate", role: "plate" as const, label: "" },
          { assetId: "v-night", role: "variant" as const, label: "night" },
          { assetId: "est", role: "establishing" as const, label: "lobby wide" },
        ],
      },
    };
    expect(locationBibleReferences(loc, "night").map((r) => [r.kind, r.assetId])).toEqual([
      ["canonical", "canon"],
      ["establishing", "est"],
      ["plate", "plate"],
      ["variant", "v-night"],
    ]);
    expect([...irrelevantVariantAssetIds(loc, "night")]).toEqual(["v-day"]);
    expect(locationBibleAssetIds(loc).sort()).toEqual(["canon", "est", "plate", "v-day", "v-night"]);
  });

  it("a project without a Location Visual Bible keeps every package and fingerprint byte-for-byte", () => {
    const data = buildSeedProject();
    for (const shot of data.shots.filter((s) => s.spatial.locationId).slice(0, 6)) {
      const ctx = buildShotContext(data, shot.id);
      const same = { ...data, locations: data.locations.map((l) => ({ ...l, visualBible: {} })) };
      const ctx2 = buildShotContext(same, shot.id);
      expect(approvalSnapshot(ctx2).fingerprint).toBe(approvalSnapshot(ctx).fingerprint);
      const a = assembleGenerationPackage(ctx, NOW);
      const b = assembleGenerationPackage(ctx2, NOW);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(b.set && "visualReferences" in b.set).toBe(false);
    }
  });

  it("readiness is guidance: an empty Location has suggestions and nothing blocks", () => {
    const data = buildSeedProject();
    const l = data.locations[0]!;
    const vb = locationBibleReadiness({ ...data, locationViews: [] }, l.id);
    expect(vb.done).toBe(0);
    expect(vb.items.map((i) => i.key)).toEqual([
      "canonical",
      "establishing",
      "view",
      "reverse",
      "variant",
      "plate",
    ]);
    expect(vb.items.every((i) => i.suggestion)).toBe(true);
  });

  it("Character Continuity Lock + Location Visual Bible: the Lock's frozen images are unchanged, Location images follow", () => {
    const img = (id: string) => ({ id, type: "image", objectPath: `p/${id}`, checksum: "c" });
    const ids = [
      "canon-y",
      "live-id",
      "live-look",
      "lock-id",
      "lock-look",
      "view",
      "loc-canon",
      "loc-est",
      "loose",
    ];
    const pkg = (withBible: boolean, withLock: boolean) =>
      ({
        assets: Object.fromEntries(ids.map((id) => [id, img(id)])),
        characters: [
          {
            characterId: "y",
            name: "Yumeko",
            identityReferenceAssetIds: ["live-id"],
            look: { name: "Formal", referenceAssetIds: ["live-look"] },
            canonicalIdentityAssetId: "canon-y",
            ...(withLock ? { continuityLock: { lockId: "L", name: "Ep1", lockFingerprint: "f" } } : {}),
          },
        ],
        set: {
          name: "Lobby",
          referenceAssetIds: ["loose"],
          ...(withBible
            ? {
                visualReferences: [
                  { assetId: "loc-canon", kind: "canonical", label: "Lobby canonical location" },
                  { assetId: "loc-est", kind: "establishing", label: "Lobby establishing view" },
                ],
              }
            : {}),
        },
        references: {
          referenceAssetIds: [],
          locationView: { assetId: "view", name: "Entrance" },
          characterContinuity: withLock
            ? [
                {
                  characterId: "y",
                  characterName: "Yumeko",
                  lockId: "L",
                  name: "Ep1",
                  facts: { look: { name: "Formal" } },
                  references: [
                    { position: 0, role: "identity", identitySlot: "front", label: "f", assetId: "lock-id" },
                    { position: 1, role: "look", identitySlot: null, label: "l", assetId: "lock-look" },
                  ],
                },
              ]
            : undefined,
        },
        lighting: {},
      }) as unknown as GenerationPackage;
    const order = (p: GenerationPackage) => deriveProductionFrameReferenceCandidates(p).map((c) => c.assetId);
    // locked: frozen Character images exactly as before; the Location Visual Bible only adds AFTER the view
    expect(order(pkg(true, true))).toEqual(["lock-id", "lock-look", "view", "loc-canon", "loc-est", "loose"]);
    expect(order(pkg(false, true))).toEqual(["lock-id", "lock-look", "view", "loose"]);
    // unlocked: canonical identity → Look → other identity (5B-I4), then view → canonical location (5B-I5)
    expect(order(pkg(true, false))).toEqual([
      "canon-y",
      "live-look",
      "live-id",
      "view",
      "loc-canon",
      "loc-est",
      "loose",
    ]);
  });
});

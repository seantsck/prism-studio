import { describe, expect, it } from "vitest";
import { buildShotContext } from "../context";
import { approvalSnapshot } from "../fingerprint";
import { buildSeedProject } from "../../data/seed";
import { deriveReferenceCandidates } from "../generation/compatibility";
import type { GenerationPackage } from "../generation-package";
import {
  normalizeExpression,
  orderedIdentityRefs,
  visualBibleReadiness,
  visualRoleOf,
} from "../visual-bible";

/** Phase 5B-I4 (pure): roles, ordering and the "unchanged when unused" guarantees. */
const ref = (id: string, slot: string, metadata: Record<string, unknown> = {}) =>
  ({ id, characterId: "c", slot, assetId: id, label: id, metadata, locked: false }) as never;

describe("Visual Bible domain", () => {
  it("orders canonical first, ordinary refs in library order, then cutout, then expressions; unchanged without roles", () => {
    const plain = [ref("a", "front"), ref("b", "additional"), ref("c", "profile")];
    expect(orderedIdentityRefs(plain)).toEqual(plain);
    const mixed = [
      ref("e", "additional", { visualRole: "expression", expression: "happy" }),
      ref("f", "front"),
      ref("x", "additional", { visualRole: "cutout" }),
      ref("k", "additional", { visualRole: "canonical" }),
      ref("p", "profile"),
    ];
    expect(orderedIdentityRefs(mixed).map((r: { id: string }) => r.id)).toEqual(["k", "f", "p", "x", "e"]);
  });

  it("reads roles defensively and normalizes expression names", () => {
    expect(visualRoleOf(ref("a", "front", { visualRole: "nope" }))).toBeNull();
    expect(visualRoleOf(ref("a", "front", { visualRole: "canonical" }))).toBe("canonical");
    expect(normalizeExpression("  Quietly   FURIOUS ")).toBe("quietly furious");
    expect(normalizeExpression("   ")).toBeNull();
  });

  it("a project without Visual Bible roles keeps its Shot fingerprints byte-for-byte (no false staleness)", () => {
    const data = buildSeedProject();
    const shot = data.shots.find((s) => s.characters.length > 0)!;
    const before = approvalSnapshot(buildShotContext(data, shot.id)).fingerprint;
    // the same data, identity refs re-created with an empty metadata object: identical
    const same = {
      ...data,
      identityRefs: data.identityRefs.map((r) => ({ ...r, metadata: { ...r.metadata } })),
    };
    expect(approvalSnapshot(buildShotContext(same, shot.id)).fingerprint).toBe(before);
  });

  it("readiness is guidance: an empty Character has suggestions and nothing blocks", () => {
    const data = buildSeedProject();
    const c = data.characters[0]!;
    const vb = visualBibleReadiness({ ...data, identityRefs: [], assets: [] }, c.id);
    expect(vb.done).toBe(0);
    expect(vb.items.find((i) => i.key === "canonical")!.suggestion).toMatch(/defines this Character's face/);
    expect(vb.items.every((i) => i.suggestion !== null || i.done)).toBe(true);
  });
  it("a Continuity Lock is unchanged by a canonical identity: the frozen images are sent, in frozen order", () => {
    const img = (id: string) => ({ id, type: "image", objectPath: `p/${id}`, checksum: "c" });
    const pkg = (withCanonical: boolean, withLock: boolean) =>
      ({
        assets: Object.fromEntries(
          ["canon", "live-id", "live-look", "lock-id", "lock-look"].map((id) => [id, img(id)]),
        ),
        characters: [
          {
            characterId: "y",
            name: "Yumeko",
            identityReferenceAssetIds: ["live-id"],
            look: { name: "Formal Black", referenceAssetIds: ["live-look"] },
            ...(withCanonical ? { canonicalIdentityAssetId: "canon" } : {}),
            ...(withLock ? { continuityLock: { lockId: "L", name: "Ep1", lockFingerprint: "f" } } : {}),
          },
        ],
        references: {
          referenceAssetIds: [],
          characterContinuity: withLock
            ? [
                {
                  characterId: "y",
                  characterName: "Yumeko",
                  lockId: "L",
                  name: "Ep1",
                  facts: { look: { name: "Formal Black" } },
                  references: [
                    { position: 1, role: "look", identitySlot: null, label: "look", assetId: "lock-look" },
                    {
                      position: 0,
                      role: "identity",
                      identitySlot: "front",
                      label: "front",
                      assetId: "lock-id",
                    },
                  ],
                },
              ]
            : undefined,
        },
        lighting: {},
      }) as unknown as GenerationPackage;
    const ids = (p: GenerationPackage) => deriveReferenceCandidates(p).map((c) => c.assetId);
    // locked: canonical ignored, exactly as without one
    expect(ids(pkg(true, true))).toEqual(ids(pkg(false, true)));
    expect(ids(pkg(true, true))).toEqual(["lock-id", "lock-look"]);
    // unlocked: canonical → selected Look → other identity; without canonical the pre-I4 order
    expect(ids(pkg(true, false))).toEqual(["canon", "live-look", "live-id"]);
    expect(ids(pkg(false, false))).toEqual(["live-id", "live-look"]);
  });
});

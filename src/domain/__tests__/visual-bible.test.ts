import { describe, expect, it } from "vitest";
import { buildShotContext } from "../context";
import { approvalSnapshot } from "../fingerprint";
import { buildSeedProject } from "../../data/seed";
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
});

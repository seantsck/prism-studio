import { describe, expect, it } from "vitest";
import { planCharacterMerge } from "../character-merge";
import type { Asset, Character, IdentityRef, ProjectData } from "../schemas";
import { seed, uid } from "./helpers";

/** The seed's script Takumi (in Shots, a front placeholder) and a Takumi Saionji made on his own, with pictures. */
function world() {
  const data: ProjectData = seed();
  const takumi = data.characters.find((c) => c.name === "Takumi")!;
  const now = new Date().toISOString();
  const saionji: Character = {
    ...takumi,
    id: uid("char:saionji"),
    name: "Takumi Saionji",
    description: "",
    personality: "Cold, exacting, polite to a fault.",
    physicalDescription: "Japanese man in his mid-30s, jet-black hair swept back, tailored navy suit.",
    continuityRules: ["Always in a three-piece suit."],
    createdAt: now,
    updatedAt: now,
  };
  data.characters.push(saionji);
  const asset = (key: string): Asset => {
    const base = data.assets[0]!;
    const a = {
      ...base,
      id: uid(`asset:${key}`),
      type: "image" as const,
      objectPath: `p/${key}.png`,
      checksum: key,
    };
    data.assets.push(a);
    return a;
  };
  const ref = (who: Character, key: string, r: Partial<IdentityRef>): IdentityRef => {
    const x: IdentityRef = {
      id: uid(`ref:${who.id}:${key}`),
      characterId: who.id,
      slot: "additional",
      assetId: asset(`${who.id}:${key}`).id,
      label: key,
      metadata: {},
      locked: false,
      ...r,
    };
    data.identityRefs.push(x);
    return x;
  };
  const front = ref(saionji, "front", { slot: "front" });
  const threeQuarter = ref(saionji, "3q", { slot: "three_quarter" });
  const half = ref(saionji, "half", { metadata: { view: "half_body" } });
  const canonical = ref(saionji, "canonical", { metadata: { visualRole: "canonical" } });
  const photo = ref(saionji, "photo", { label: "Reference photo" });
  return { data, takumi, saionji, front, threeQuarter, half, canonical, photo };
}

describe("merging a Character into the same person", () => {
  it("keeps the one the story uses; the other's pictures fill it, its placeholder trades places, nothing is lost", () => {
    const { data, takumi, saionji, front, threeQuarter, half, canonical, photo } = world();
    const placeholder = data.identityRefs.find((r) => r.characterId === takumi.id && r.slot === "front")!;
    expect(
      placeholder.assetId === null || !data.assets.find((a) => a.id === placeholder.assetId)?.objectPath,
    ).toBe(true);
    const r = planCharacterMerge(data, saionji.id, takumi.id, { name: "Takumi Saionji", prefer: "merged" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // the front slot trades contents with the kept one's empty placeholder (one reference per slot and Character)
    expect(r.plan.refSwaps).toEqual([{ keptRefId: placeholder.id, mergedRefId: front.id }]);
    // the rest move to the kept Character
    expect(r.plan.refMoves.map((m) => m.refId).sort()).toEqual(
      [threeQuarter.id, half.id, canonical.id, photo.id].sort(),
    );
    expect(r.plan.refMoves.every((m) => m.toCharacterId === takumi.id)).toBe(true);
    // the name chosen; the merged one's wording first, the kept one's where it is empty
    expect(r.plan.character).toMatchObject({
      id: takumi.id,
      name: "Takumi Saionji",
      description: takumi.description,
      personality: "Cold, exacting, polite to a fault.",
      continuityRules: ["Always in a three-piece suit."],
    });
    expect(r.plan.summary[0]).toBe("5 pictures of Takumi Saionji move to Takumi");
  });

  it("where both have a picture, the side chosen wins and the other picture goes with the merged one", () => {
    const { data, takumi, saionji, threeQuarter } = world();
    const theirs: IdentityRef = {
      id: uid("ref:takumi:3q"),
      characterId: takumi.id,
      slot: "three_quarter",
      assetId: data.assets.find((a) => a.objectPath)!.id,
      label: "3/4",
      metadata: {},
      locked: false,
    };
    data.assets.find((a) => a.id === theirs.assetId)!.type = "image";
    data.identityRefs.push(theirs);
    const merged = planCharacterMerge(data, saionji.id, takumi.id, { name: "Takumi", prefer: "merged" });
    const kept = planCharacterMerge(data, saionji.id, takumi.id, { name: "Takumi", prefer: "kept" });
    if (!merged.ok || !kept.ok) throw new Error("refused");
    expect(merged.plan.refSwaps).toContainEqual({ keptRefId: theirs.id, mergedRefId: threeQuarter.id });
    expect(kept.plan.refSwaps.some((s) => s.mergedRefId === threeQuarter.id)).toBe(false);
    expect(kept.plan.refMoves.some((m) => m.refId === threeQuarter.id)).toBe(false);
    expect(kept.plan.summary).toContain(
      "1 picture where both had one goes to the Trash with Takumi Saionji (restorable)",
    );
    // the kept side's wording first
    expect(kept.plan.character.personality).toBe(takumi.personality);
  });

  it("refuses a Character the story uses (merge the other way), a locked reference, and a third name", () => {
    const { data, takumi, saionji, threeQuarter } = world();
    const other = planCharacterMerge(data, takumi.id, saionji.id, { name: "Takumi", prefer: "merged" });
    expect(other).toMatchObject({ ok: false, reason: expect.stringMatching(/^Takumi is used by the story/) });
    expect(
      planCharacterMerge(data, saionji.id, takumi.id, { name: "Someone else", prefer: "merged" }),
    ).toMatchObject({ ok: false, reason: "Choose one of the two names." });
    threeQuarter.locked = true;
    expect(
      planCharacterMerge(data, saionji.id, takumi.id, { name: "Takumi", prefer: "merged" }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/is locked/) });
  });
});

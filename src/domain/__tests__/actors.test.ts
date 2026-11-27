import { describe, expect, it } from "vitest";
import { seed } from "./helpers";
import { ACTOR_REFERENCES_MAX, isFromActor, planActorFrom, planActorReferences } from "../character-library";
import type { Asset, ProjectData } from "../schemas";

/**
 * Actors and the Characters they play: making an Actor from a Character copies its reference pictures only (the story
 * stays); linking lends a Character the Actor's pictures it does not have yet (photos first), never twice.
 */
let n = 0;
const ids = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`;
function picture(data: ProjectData, name: string, source: Asset["source"], sum: string): Asset {
  const a = {
    ...data.assets[0]!,
    id: ids(),
    projectId: data.project.id,
    type: "image",
    purpose: "identity_ref",
    source,
    name,
    objectPath: `p/${name}.jpg`,
    checksum: sum.padStart(64, "0"),
    metadata: {},
  } as Asset;
  data.assets.push(a);
  return a;
}
function library(): ProjectData {
  const data = seed();
  return {
    ...data,
    project: { ...data.project, id: ids(), slug: "your-library", purpose: "library" },
    characters: [],
    identityRefs: [],
    looks: [],
    voiceProfiles: [],
    assets: [],
  };
}

describe("Actors", () => {
  it("an Actor made from a Character takes its reference pictures, not its story", () => {
    const drama = seed();
    const sean = drama.characters.find((c) => c.name === "Sean")!;
    const photo = picture(drama, "sean-photo", "upload", "1");
    drama.identityRefs.find((r) => r.characterId === sean.id && r.slot === "front")!.assetId = photo.id;
    sean.role = "Lead — outsider";
    const lib = library();
    const plan = planActorFrom(drama, sean.id, lib, ids, "2026-11-27T00:00:00.000Z");
    expect(plan.character).toMatchObject({
      name: "Sean",
      role: "",
      relationshipNotes: "",
      projectId: lib.project.id,
    });
    expect(plan.looks).toEqual([]);
    expect(plan.voiceProfiles).toEqual([]);
    // stored pictures (placeholders with no file are copied as empty slots, as "Use in project" does)
    const stored = plan.assets.filter((a) => a.from.objectPath);
    expect(stored.map((a) => a.from.id)).toEqual([photo.id]);
    expect(plan.identityRefs.some((r) => r.assetId === stored[0]!.to.id)).toBe(true);
    // only what the reference pictures use: no Look or voice picture travels
    const refAssets = new Set(plan.identityRefs.map((r) => r.assetId));
    expect(plan.assets.every((a) => refAssets.has(a.to.id))).toBe(true);
  });

  it("linking lends the Character the Actor's pictures, photos first, each marked from the actor", () => {
    const drama = seed();
    const takumi = drama.characters.find((c) => c.name === "Takumi")!;
    const lib = library();
    const actorId = ids();
    lib.characters.push({ ...takumi, id: actorId, projectId: lib.project.id, name: "Ken" });
    const view = picture(lib, "ken-front", "provider_output", "a");
    const photo = picture(lib, "ken-photo", "upload", "b");
    lib.identityRefs.push(
      {
        id: ids(),
        characterId: actorId,
        slot: "front",
        assetId: view.id,
        label: "",
        metadata: {},
        locked: true,
      },
      {
        id: ids(),
        characterId: actorId,
        slot: "additional",
        assetId: photo.id,
        label: "",
        metadata: {},
        locked: false,
      },
    );
    const plan = planActorReferences(lib, actorId, drama, takumi.id, ids, "2026-11-27T00:00:00.000Z");
    expect(plan.assets.map((a) => a.from.id)).toEqual([photo.id, view.id]);
    expect(plan.assets.every((a) => a.to.projectId === drama.project.id && a.to.objectPath === null)).toBe(
      true,
    );
    expect(plan.identityRefs.map((r) => r.label)).toEqual(["Ken (actor): photo", "Ken (actor): front"]);
    expect(plan.identityRefs.every((r) => r.characterId === takumi.id && isFromActor(r))).toBe(true);
  });

  it("a picture the Character already has (same bytes, or copied before) is not copied again; at most six", () => {
    const drama = seed();
    const yumeko = drama.characters.find((c) => c.name === "Yumeko")!;
    const own = picture(drama, "yumeko-photo", "upload", "c");
    drama.identityRefs.find((r) => r.characterId === yumeko.id && r.slot === "front")!.assetId = own.id;
    const lib = library();
    const actorId = ids();
    lib.characters.push({ ...yumeko, id: actorId, projectId: lib.project.id });
    // the Actor made from her: the same photo, plus eight more
    for (const [i, sum] of ["c", ...Array.from({ length: 8 }, (_, k) => `d${k}`)].entries()) {
      const p = picture(lib, `p${i}`, "upload", sum);
      lib.identityRefs.push({
        id: ids(),
        characterId: actorId,
        slot: "additional",
        assetId: p.id,
        label: "",
        metadata: {},
        locked: false,
      });
    }
    const first = planActorReferences(lib, actorId, drama, yumeko.id, ids, "2026-11-27T00:00:00.000Z");
    expect(first.assets).toHaveLength(ACTOR_REFERENCES_MAX);
    expect(first.assets.some((a) => a.from.checksum === own.checksum)).toBe(false);
    // once written, linking again adds nothing new from those
    drama.assets.push(...first.assets.map((a) => ({ ...a.to, objectPath: "copied" })));
    drama.identityRefs.push(...first.identityRefs);
    const again = planActorReferences(lib, actorId, drama, yumeko.id, ids, "2026-11-27T00:00:00.000Z");
    expect(again.assets.map((a) => a.from.id)).not.toEqual(
      expect.arrayContaining(first.assets.map((a) => a.from.id)),
    );
    expect(again.assets).toHaveLength(2);
  });
});

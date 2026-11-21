import { describe, expect, it } from "vitest";
import { productionChecklist, projectAreas } from "../production-checklist";
import type { Asset, ProjectData } from "../schemas";
import { seed } from "./helpers";

let n = 0;
function image(data: ProjectData, name: string, source: Asset["source"] = "upload"): Asset {
  n += 1;
  const asset = {
    ...data.assets[0]!,
    id: `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
    type: "image",
    source,
    name,
    storageProvider: "local",
    objectPath: `p/${n}/${name}.png`,
    mime: "image/png",
    byteSize: 1000,
    checksum: String(n).padStart(64, "c"),
    width: 1024,
    height: 1536,
    metadata: {},
  } as Asset;
  data.assets.push(asset);
  return asset;
}

const episodeOf = (data: ProjectData) =>
  [...data.episodes].sort(
    (a, b) =>
      data.shots.filter((s) => s.episodeId === b.id).length -
      data.shots.filter((s) => s.episodeId === a.id).length,
  )[0]!;

describe("the Production checklist", () => {
  it("with nothing made yet, it asks for each person's photos first, and no Shot is ready", () => {
    const data = seed();
    const list = productionChecklist(data, episodeOf(data).id)!;
    const yumeko = list.people.find((p) => p.name === "Yumeko")!;
    expect(yumeko).toMatchObject({ photos: 0, locked: false, readyToApprove: false });
    expect(yumeko.views.every((v) => !v.filled)).toBe(true);
    expect(list.steps[0]).toMatchObject({ area: "people", action: "Open the Studio" });
    // a real person brings photos; a fictional one is described instead
    expect(list.steps.map((s) => s.title)).toContain("Add photos of Yumeko, or describe them");
    // a Shot with a person who has no face yet is not ready
    const withYumeko = list.shots.filter((s) => s.people.includes("Yumeko"));
    expect(withYumeko.length).toBeGreaterThan(0);
    expect(withYumeko.every((s) => s.light === "blocked")).toBe(true);
    expect(list.steps.some((s) => s.title.startsWith("Make the frame"))).toBe(false);
  });

  it("once a person's set and outfit picture exist, they can be approved and their Shots are ready for a frame", () => {
    const data = seed();
    const episode = episodeOf(data);
    const yumeko = data.characters.find((c) => c.name === "Yumeko")!;
    for (let i = 0; i < 4; i++) {
      const photo = image(data, `photo-${i}`);
      data.identityRefs.push({
        id: `photo-ref-${i}`,
        characterId: yumeko.id,
        slot: "additional",
        assetId: photo.id,
        label: "Reference photo",
        metadata: { source: "upload" },
        locked: false,
      });
    }
    const view = (slot: string, extra: Record<string, unknown> = {}) => {
      const a = image(data, `view-${slot}-${String(extra.view ?? "")}`, "provider_output");
      const existing = data.identityRefs.find(
        (r) => r.characterId === yumeko.id && r.slot === slot && !extra.view,
      );
      if (existing && slot !== "additional") Object.assign(existing, { assetId: a.id, metadata: {} });
      else
        data.identityRefs.push({
          id: `ref-${slot}-${String(extra.view ?? "x")}`,
          characterId: yumeko.id,
          slot: slot as never,
          assetId: a.id,
          label: slot,
          metadata: extra,
          locked: false,
        });
      return a;
    };
    const front = view("front");
    data.identityRefs.push({
      id: "canonical",
      characterId: yumeko.id,
      slot: "additional",
      assetId: front.id,
      label: "Canonical identity",
      metadata: { visualRole: "canonical" },
      locked: false,
    });
    view("three_quarter");
    view("profile");
    view("full_body");
    view("additional", { view: "right_profile" });
    view("additional", { view: "half_body" });
    let list = productionChecklist(data, episode.id)!;
    let p = list.people.find((x) => x.name === "Yumeko")!;
    expect(p.photos).toBe(4);
    expect(p.views.every((v) => v.filled)).toBe(true);
    // her outfit has no picture yet: that is the next thing for her, and she cannot be approved
    expect(p.readyToApprove).toBe(false);
    expect(list.steps.some((s) => s.area === "outfits" && s.title.includes("Yumeko"))).toBe(true);
    const outfit = list.outfits.find((o) => o.characterName === "Yumeko")!;
    expect(list.steps.find((s) => s.area === "outfits")!.href).toContain(
      `make=outfit_variant&look=${outfit.lookId}`,
    );

    const gown = image(data, "gown", "provider_output");
    data.looks.find((l) => l.id === outfit.lookId)!.referenceAssetIds = [gown.id];
    list = productionChecklist(data, episode.id)!;
    p = list.people.find((x) => x.name === "Yumeko")!;
    expect(p.readyToApprove).toBe(true);
    expect(list.steps.some((s) => s.title.includes("Yumeko") && s.area !== "shots")).toBe(false);
    // her Shots no longer wait on her; a Shot with only her and a pictured place would be ready
    for (const s of list.shots.filter((x) => x.people.join() === "Yumeko"))
      expect(s.missing.filter((m) => m.startsWith("Yumeko"))).toEqual([]);
  });
});

describe("Home's four areas", () => {
  it("each says where it stands and the one next thing, in any order", () => {
    const data = seed();
    const areas = projectAreas(data);
    expect(areas.map((a) => a.id)).toEqual(["story", "cast", "world", "shots"]);
    const [story, cast, world, shots] = areas;
    expect(story!.summary).toMatch(/Bible written · \d+ of \d+ episodes scripted/);
    // nobody has a face yet: every character is "not started", and Cast's next step is the first person step
    expect(cast!.summary).toContain("not started");
    expect(cast!.next!.href).toContain("/studio?subject=character:");
    expect(world!.summary).toBe(`0 of ${data.locations.length} places pictured`);
    expect(world!.next!.href).toContain("/studio?subject=location:");
    expect(shots!.summary).toBe(`${data.shots.length} shots · 0 frames`);
    // nothing in Shots can be done yet: it says what it is waiting on, and nothing is locked
    expect(shots!.next).toBeNull();
    expect(shots!.waiting).toMatch(/waiting on Cast or World/);
  });

  it("an empty project starts anywhere", () => {
    const data = seed();
    data.characters = [];
    data.locations = [];
    data.shots = [];
    const [, cast, world, shots] = projectAreas(data);
    expect(cast!.next).toMatchObject({ label: "Add a character" });
    expect(world!.next).toMatchObject({ label: "Add a place" });
    expect(shots!.waiting).toBeNull();
  });
});

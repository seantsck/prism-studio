import { describe, expect, it } from "vitest";
import { seed } from "../../__tests__/helpers";
import type { Asset, ProjectData } from "../../schemas";
import { buildSubjectImagePlan, SUBJECT_IMAGE_POLICY, SubjectImageError } from "../subject-image";

/**
 * Subject-image prompt policy v2 (the Reference Studio). What a Character / Location image request says, and which
 * images it carries, for the three things an image can be FOR: nothing sent (text), references reproduced in a new
 * picture (reference), one image changed (edit). Pure: built from Prism's own records, no provider involved.
 */
let n = 0;
/** A stored image of the project (a seed placeholder has no file, so it can never be sent). */
function image(data: ProjectData, name: string, source: Asset["source"] = "upload"): Asset {
  n += 1;
  const asset = {
    ...data.assets[0]!,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    type: "image",
    purpose: "identity_ref",
    source,
    name,
    storageProvider: "local",
    objectPath: `p/${n}/${name}.jpg`,
    mime: "image/jpeg",
    byteSize: 1000,
    checksum: String(n).padStart(64, "a"),
    width: 1200,
    height: 1600,
    metadata: {},
  } as Asset;
  data.assets.push(asset);
  return asset;
}

function world() {
  const data = seed();
  const yumeko = data.characters.find((c) => c.name === "Yumeko")!;
  const look = data.looks.find((l) => l.characterId === yumeko.id)!;
  const slot = (s: string) => data.identityRefs.find((r) => r.characterId === yumeko.id && r.slot === s)!;
  const photo = image(data, "photo-front");
  slot("front").assetId = photo.id;
  const canonical = image(data, "canonical", "provider_output");
  data.identityRefs.push({
    id: "canonical-ref",
    characterId: yumeko.id,
    slot: "additional",
    assetId: canonical.id,
    label: "Canonical identity",
    metadata: { visualRole: "canonical" },
    locked: false,
  });
  const lookRef = image(data, "gown");
  look.referenceAssetIds = [lookRef.id];
  const lobby = data.locations.find((l) => l.name === "Grand Celeste Lobby")!;
  const lobbyPhoto = image(data, "lobby");
  lobby.referenceAssetIds = [lobbyPhoto.id];
  return { data, yumeko, look, photo, canonical, lookRef, lobby, lobbyPhoto };
}
const lines = (plan: ReturnType<typeof buildSubjectImagePlan>, key: string) =>
  plan.plan.sections.find((s) => s.key === key)?.lines ?? [];

describe("subject-image policy v2: what the images are FOR", () => {
  it("TEXT: with no stored image, the written description is all the model has", () => {
    const data = seed();
    const sean = data.characters.find((c) => c.name === "Sean")!;
    const plan = buildSubjectImagePlan(data, {
      subject: { kind: "character", characterId: sean.id, intent: "portrait" },
      direction: "",
    });
    expect(plan.operation).toBe("text");
    expect(plan.references).toEqual([]);
    expect(lines(plan, "identity")[0]).toBe(sean.physicalDescription);
    expect(plan.positive).not.toMatch(/reference image/);
    expect(plan.packageSnapshot).toMatchObject({
      schema: "prism.subject-image-package.v2",
      policy: SUBJECT_IMAGE_POLICY,
      operation: "text",
    });
  });

  it("REFERENCE: the chosen photograph is reproduced in a NEW picture, and wins over the written notes", () => {
    const { data, yumeko, photo } = world();
    const plan = buildSubjectImagePlan(data, {
      subject: { kind: "character", characterId: yumeko.id, intent: "three_quarter" },
      direction: "",
      sourceAssetIds: [photo.id],
    });
    expect(plan.operation).toBe("reference");
    // what is chosen is what is sent: the generated canonical image is NOT added behind the creator's back
    expect(plan.references).toEqual([
      { assetId: photo.id, role: "identity", order: 0, label: "Yumeko reference photo (front)" },
    ]);
    expect(lines(plan, "identity")[0]).toBe(
      "The same person as in the identity reference image: keep the face, facial features, skin tone, hair, apparent age and build exactly as shown. Do not beautify, restyle or change them.",
    );
    expect(lines(plan, "identity")[1]).toMatch(
      /^Written notes \(the reference image wins where they differ\): /,
    );
    expect(lines(plan, "wardrobe")).toEqual([
      "Clothing and hair styling as in the reference image, unless the direction says otherwise.",
    ]);
    expect(lines(plan, "composition")[0]).toMatch(/^Three-quarter view: /);
    expect(lines(plan, "hard_constraints")).toEqual([
      "Keep the rendering style of the reference image: a photograph stays a photograph.",
    ]);
  });

  it("SEVERAL photographs: every one is sent, in the creator's order, and the prompt speaks of them together", () => {
    const { data, yumeko, photo } = world();
    // the hosted case: photographs the creator added in the Studio are extra identity references of the Character
    const more = ["side", "smile", "full"].map((name, n) => {
      const asset = image(data, `photo-${name}`);
      data.identityRefs.push({
        id: `extra-ref-${n}`,
        characterId: yumeko.id,
        slot: "additional",
        assetId: asset.id,
        label: "Reference photo",
        metadata: {},
        locked: false,
      });
      return asset;
    });
    const chosen = [more[1]!.id, photo.id, more[0]!.id, more[2]!.id];
    const plan = buildSubjectImagePlan(data, {
      subject: { kind: "character", characterId: yumeko.id, intent: "three_quarter" },
      direction: "",
      sourceAssetIds: chosen,
    });
    expect(plan.operation).toBe("reference");
    expect(plan.references.map((r) => [r.order, r.assetId, r.role, r.label])).toEqual([
      [0, more[1]!.id, "identity", "Yumeko reference photo"],
      [1, photo.id, "identity", "Yumeko reference photo (front)"],
      [2, more[0]!.id, "identity", "Yumeko reference photo"],
      [3, more[2]!.id, "identity", "Yumeko reference photo"],
    ]);
    expect(plan.packageSnapshot).toMatchObject({ sourceAssetIds: chosen });
    expect(lines(plan, "identity")[0]).toBe(
      "The same person as in the identity reference images: keep the face, facial features, skin tone, hair, apparent age and build exactly as shown. Do not beautify, restyle or change them.",
    );
    expect(lines(plan, "identity")[1]).toMatch(
      /^Written notes \(the reference images win where they differ\): /,
    );
    expect(lines(plan, "wardrobe")).toEqual([
      "Clothing and hair styling as in the reference images, unless the direction says otherwise.",
    ]);
    expect(lines(plan, "hard_constraints")).toEqual([
      "Keep the rendering style of the reference images: a photograph stays a photograph.",
    ]);
  });

  it("a generated picture is named as generated, never as a photograph", () => {
    const { data, yumeko, canonical } = world();
    const plan = buildSubjectImagePlan(data, {
      subject: { kind: "character", characterId: yumeko.id, intent: "portrait" },
      direction: "",
      sourceAssetIds: [canonical.id],
    });
    expect(plan.references[0]!.label).toBe("Yumeko generated reference (canonical identity)");
  });

  it("an EMPTY choice means the written description: no identity image is sent, though one exists", () => {
    const { data, yumeko } = world();
    const plan = buildSubjectImagePlan(data, {
      subject: { kind: "character", characterId: yumeko.id, intent: "portrait" },
      direction: "",
      sourceAssetIds: [],
    });
    expect(plan.operation).toBe("text");
    expect(plan.references).toEqual([]);
    expect(plan.packageSnapshot).toMatchObject({ sourceAssetIds: [] });
  });

  it("with no choice stated (the older panels), Prism's own order is unchanged: canonical, the Look, the rest", () => {
    const { data, yumeko, look, photo, canonical, lookRef } = world();
    const plan = buildSubjectImagePlan(data, {
      subject: { kind: "character", characterId: yumeko.id, intent: "full_body", lookId: look.id },
      direction: "",
    });
    expect(plan.references.map((r) => [r.assetId, r.role])).toEqual([
      [canonical.id, "identity"],
      [lookRef.id, "character_look"],
      [photo.id, "identity"],
    ]);
    expect(plan.packageSnapshot).not.toHaveProperty("sourceAssetIds");
  });

  it("a Look brings its own wardrobe images and words; its hair styling replaces the reference's hair", () => {
    const { data, yumeko, look, canonical, lookRef } = world();
    // starting from a generated picture (no photograph of the creator's chosen): the Look picture rides along
    const plan = buildSubjectImagePlan(data, {
      subject: { kind: "character", characterId: yumeko.id, intent: "outfit_variant", lookId: look.id },
      direction: "",
      sourceAssetIds: [canonical.id],
    });
    expect(plan.references.map((r) => r.assetId)).toEqual([canonical.id, lookRef.id]);
    expect(lines(plan, "identity")[0]).not.toMatch(/hair/);
    expect(lines(plan, "wardrobe")[0]).toMatch(/^Outfit: /);
    expect(lines(plan, "wardrobe").at(-1)).toBe(
      "Match the Look reference image: the same garments, colours, hair styling and accessories.",
    );
  });

  it("with the creator's own photos chosen, a Look is sent as words only: its picture would replace their face", () => {
    const { data, yumeko, look, photo, canonical, lookRef } = world();
    const plan = buildSubjectImagePlan(data, {
      subject: { kind: "character", characterId: yumeko.id, intent: "portrait", lookId: look.id },
      direction: "",
      sourceAssetIds: [photo.id],
    });
    expect(plan.references.map((r) => [r.assetId, r.role])).toEqual([[photo.id, "identity"]]);
    expect(lines(plan, "wardrobe")[0]).toMatch(/^Outfit: /);
    expect(lines(plan, "wardrobe").join(" ")).not.toMatch(/Look reference image/);
    // a photo beside a generated picture is still a photo chosen
    const mixed = buildSubjectImagePlan(data, {
      subject: { kind: "character", characterId: yumeko.id, intent: "portrait", lookId: look.id },
      direction: "",
      sourceAssetIds: [canonical.id, photo.id],
    });
    expect(mixed.references.map((r) => r.assetId)).toEqual([canonical.id, photo.id]);
    // the creator can still send the Look picture: by choosing it
    const asked = buildSubjectImagePlan(data, {
      subject: { kind: "character", characterId: yumeko.id, intent: "portrait", lookId: look.id },
      direction: "",
      sourceAssetIds: [photo.id, lookRef.id],
    });
    expect(asked.references.map((r) => [r.assetId, r.role])).toEqual([
      [photo.id, "identity"],
      [lookRef.id, "character_look"],
    ]);
  });

  it("left and right profiles are screen directions, and a half body is its own framing", () => {
    const { data, yumeko, photo } = world();
    const of = (intent: "profile_left" | "profile_right" | "half_body") =>
      lines(
        buildSubjectImagePlan(data, {
          subject: { kind: "character", characterId: yumeko.id, intent },
          direction: "",
          sourceAssetIds: [photo.id],
        }),
        "composition",
      )[0]!;
    expect(of("profile_left")).toMatch(/faces the LEFT edge of the picture.*side-on \(90 degrees\)/);
    expect(of("profile_right")).toMatch(/faces the RIGHT edge of the picture/);
    expect(of("half_body")).toMatch(/from the top of the head to the hips/);
  });

  it("only what describes the PICTURE is sent: no story canon, no software guardrails, no scene lighting on a studio reference", () => {
    const { data, yumeko, photo } = world();
    expect(data.bible.guardrails.length, "the seed has guardrails to leave out").toBeGreaterThan(0);
    for (const sourceAssetIds of [[photo.id], []]) {
      const plan = buildSubjectImagePlan(data, {
        subject: { kind: "character", characterId: yumeko.id, intent: "portrait" },
        direction: "",
        sourceAssetIds,
      });
      expect(plan.positive).not.toMatch(/Guardrails|Canon|vehicle door|Never /);
      // every reference is made on one plain, solid, neutral background
      expect(lines(plan, "composition").join(" ")).toMatch(
        /Background: one plain, solid, neutral light-grey colour, evenly lit, with no scenery/,
      );
      expect(lines(plan, "negative_constraints").join(" ")).toMatch(/busy or patterned background/);
      // made from images: their surroundings are never copied
      expect(lines(plan, "composition").join(" ").includes("Do not copy the surroundings")).toBe(
        sourceAssetIds.length > 0,
      );
    }
    // words only: the project's style names the rendering medium, and the studio setup stays
    const text = buildSubjectImagePlan(data, {
      subject: { kind: "character", characterId: yumeko.id, intent: "portrait" },
      direction: "",
      sourceAssetIds: [],
    });
    expect(lines(text, "hard_constraints")[0]).toMatch(
      /^Project visual style, for the rendering medium only \(the studio setup above stays\): /,
    );
  });

  it("a scene variation and a Location carry the project's visual style: they are the film's world", () => {
    const { data, yumeko, photo, lobby } = world();
    const scene = buildSubjectImagePlan(data, {
      subject: { kind: "character", characterId: yumeko.id, intent: "scene_variation" },
      direction: "Scene: standing by the elevators in a hotel lobby at night.",
      sourceAssetIds: [photo.id],
    });
    expect(lines(scene, "hard_constraints")[0]).toMatch(/^Visual style: /);
    expect(lines(scene, "composition").join(" ")).not.toMatch(/studio background/);
    const place = buildSubjectImagePlan(data, {
      subject: { kind: "location", locationId: lobby.id, intent: "alternate_angle" },
      direction: "",
    });
    expect(place.operation).toBe("reference");
    expect(lines(place, "environment")[0]).toBe(
      "The same place as in the reference image: keep its architecture, layout, materials, fixtures and colours. Only what is described here changes.",
    );
    expect(lines(place, "hard_constraints")[0]).toMatch(/^Visual style: /);
    expect(place.positive).not.toMatch(/Guardrails|Canon/);
  });
});

describe("subject-image policy v2: an EDIT changes one thing and keeps the rest", () => {
  it("carries only the change and the keep rule: no composition, no written appearance, no other image", () => {
    const { data, yumeko, photo } = world();
    const plan = buildSubjectImagePlan(
      data,
      { subject: { kind: "character", characterId: yumeko.id, intent: "portrait" }, direction: "" },
      { edit: { sourceAssetId: photo.id, instruction: "Change the hair colour to auburn." } },
    );
    expect(plan.operation).toBe("edit");
    expect(plan.references).toEqual([
      { assetId: photo.id, role: "identity", order: 0, label: "the image to edit" },
    ]);
    expect(plan.plan.sections.map((s) => s.key)).toEqual([
      "subject",
      "action",
      "hard_constraints",
      "negative_constraints",
    ]);
    expect(lines(plan, "action")).toEqual([
      "Change only this in the image being edited: Change the hair colour to auburn.",
    ]);
    expect(lines(plan, "hard_constraints")[0]).toMatch(
      /^Keep everything else exactly as it is: the same person .*hair, clothing, background and lighting unless the change above is about them\.$/,
    );
    // the Bible says "black hair": an edit to auburn must not be sent beside it, nor a portrait's framing
    expect(plan.positive).not.toMatch(/black hair|Head-and-shoulders|Front portrait|studio background/);
  });

  it("a wardrobe change with a Look carries that Look's description and images", () => {
    const { data, yumeko, look, photo, lookRef } = world();
    const plan = buildSubjectImagePlan(
      data,
      {
        subject: { kind: "character", characterId: yumeko.id, intent: "portrait", lookId: look.id },
        direction: "",
      },
      { edit: { sourceAssetId: photo.id, instruction: `Change the clothing to the Look "${look.name}".` } },
    );
    expect(plan.references.map((r) => [r.assetId, r.label])).toEqual([
      [photo.id, "the image to edit"],
      [lookRef.id, `Yumeko Look "${look.name}"`],
    ]);
    expect(lines(plan, "wardrobe")[0]).toMatch(/^Outfit: /);
  });

  it("a Location edit keeps the place", () => {
    const { data, lobby, lobbyPhoto } = world();
    const plan = buildSubjectImagePlan(
      data,
      { subject: { kind: "location", locationId: lobby.id, intent: "location_concept" }, direction: "" },
      { edit: { sourceAssetId: lobbyPhoto.id, instruction: "Remove every person." } },
    );
    expect(plan.references).toEqual([
      { assetId: lobbyPhoto.id, role: "location", order: 0, label: "the image to edit" },
    ]);
    expect(lines(plan, "hard_constraints")[0]).toMatch(
      /^Keep everything else exactly as it is: the same place/,
    );
  });
});

describe("subject-image policy v2: what fits the model, and what is refused", () => {
  it("writes the plan for what the model will actually receive, and counts what did not fit", () => {
    const { data, yumeko, look, canonical } = world();
    const auto = {
      subject: {
        kind: "character" as const,
        characterId: yumeko.id,
        intent: "full_body" as const,
        lookId: look.id,
      },
      direction: "",
    };
    const one = buildSubjectImagePlan(data, auto, { maxReferences: 1 });
    expect(one.references.map((r) => r.assetId)).toEqual([canonical.id]);
    expect(one.referencesNotSent).toBe(2);
    // the Look's image was not sent, so the plan does not tell the model to match it
    expect(lines(one, "wardrobe").join(" ")).not.toMatch(/Look reference image/);
    const none = buildSubjectImagePlan(data, auto, { maxReferences: 0 });
    expect(none.operation).toBe("text");
    expect(lines(none, "identity")[0]).toBe(yumeko.physicalDescription);
  });

  it("refuses an image that is not stored, an empty edit, and an edit the model cannot take", () => {
    const { data, yumeko, photo } = world();
    const subject = { kind: "character" as const, characterId: yumeko.id, intent: "portrait" as const };
    const placeholder = data.identityRefs.find((r) => r.characterId === yumeko.id && r.slot === "profile")!;
    expect(() =>
      buildSubjectImagePlan(data, { subject, direction: "", sourceAssetIds: [placeholder.assetId!] }),
    ).toThrow(new SubjectImageError("That image no longer exists in this project."));
    expect(() =>
      buildSubjectImagePlan(
        data,
        { subject, direction: "" },
        { edit: { sourceAssetId: photo.id, instruction: " " } },
      ),
    ).toThrow(/Describe the edit/);
    expect(() =>
      buildSubjectImagePlan(
        data,
        { subject, direction: "" },
        { maxReferences: 0, edit: { sourceAssetId: photo.id, instruction: "brighter" } },
      ),
    ).toThrow(/cannot take the image to edit/);
  });
});

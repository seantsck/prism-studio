import { fingerprint } from "../hash";
import { locationBibleOf } from "../location-visual-bible";
import { expressionOf, orderedIdentityRefs, visualRoleOf } from "../visual-bible";
import type { Asset, Character, CharacterLook, IdentityRef, Location, ProjectData } from "../schemas";
import { referenceOrigin } from "./reference-integrity";
import type { GenerationReference, PromptPlan } from "./schemas";

/**
 * Phase 5B-I1: images whose SUBJECT is a Character or a Location (not a Shot). This module is pure: it turns Prism's
 * own records into the same frozen artefacts a Shot generation produces (a PromptPlan, a reference list and a frozen
 * package), so the existing request / worker / ingest pipeline runs them unchanged.
 *
 * Prism writes the prompt from the Bible; the creator adds direction; the human chooses the model.
 *
 * PROMPT POLICY v2 (the Reference Studio). v1 described the subject in words and attached whatever references
 * existed, without telling the model what they were for. It also sent the project's scene-lighting style, story canon
 * and software guardrails with every reference, and gave an edit the composition of an unrelated portrait. v2 says what
 * the image is FOR:
 *
 *   text       no image is sent: the written description is all the model has
 *   reference  images are sent to be REPRODUCED (the same person, the same wardrobe, the same place) in a NEW picture
 *              whose pose, framing and background are described here. The reference wins over the written notes.
 *   edit       ONE image is sent to be CHANGED; only the instruction changes, everything else stays as it is
 *
 * and sends only lines that describe the picture. The policy and operation are frozen on the attempt.
 */
export const SUBJECT_IMAGE_POLICY = { id: "subject-image", version: 2 } as const;
export type SubjectImageOperation = "text" | "reference" | "edit";

export const CHARACTER_IMAGE_INTENTS = [
  "portrait",
  "character_reference",
  // Phase 5B-I4: Visual Bible presets (angles), fed into the same pipeline
  "three_quarter",
  "profile",
  "full_body",
  "look_sheet",
  "outfit_variant",
  "expression_variant",
  // Reference Studio: the angles a face or portrait reference is turned into
  "profile_left",
  "profile_right",
  "half_body",
  // a Character placed in a scene named by the creator: a cinematic still, not a neutral studio reference
  "scene_variation",
] as const;
export const LOCATION_IMAGE_INTENTS = [
  "location_concept",
  "background",
  "establishing_view",
  "alternate_angle",
  // Phase 5B-I5: Location Visual Bible presets over the same pipeline
  "interior_view",
  "exterior_view",
  "time_variant",
] as const;
export type CharacterImageIntent = (typeof CHARACTER_IMAGE_INTENTS)[number];
export type LocationImageIntent = (typeof LOCATION_IMAGE_INTENTS)[number];
export type SubjectImageIntent = CharacterImageIntent | LocationImageIntent;

export const SUBJECT_IMAGE_INTENT_LABEL: Record<SubjectImageIntent, string> = {
  portrait: "Portrait",
  character_reference: "Character reference",
  three_quarter: "3/4 view",
  profile: "Profile",
  full_body: "Full body",
  look_sheet: "Look sheet",
  outfit_variant: "Outfit variant",
  expression_variant: "Expression variant",
  profile_left: "Left profile",
  profile_right: "Right profile",
  half_body: "Half body",
  scene_variation: "Scene variation",
  location_concept: "Location concept",
  background: "Background",
  establishing_view: "Establishing view",
  alternate_angle: "Alternate angle",
  interior_view: "Interior view",
  exterior_view: "Exterior view",
  time_variant: "Time-of-day variant",
};

/** A reference is a neutral studio picture: the project's scene lighting is for Shots, not for references. */
const STUDIO = "Plain light-grey studio background, soft even light, natural colour, sharp focus.";
const SOLO = "One person only. No text, watermark or border.";
const EMPTY_PLACE = "No text, watermark or border.";

/**
 * What the image is asked to show, per intent (composition only; the subject's facts come from the Bible or from the
 * reference images). Left and right are SCREEN directions, so a profile is unambiguous.
 */
const COMPOSITION: Record<SubjectImageIntent, string[]> = {
  portrait: [
    "Front portrait: head and shoulders, facing the camera squarely at eye level, neutral relaxed expression, face clearly readable.",
    STUDIO,
    SOLO,
  ],
  character_reference: [
    "Full-body character reference: front view, neutral standing pose, arms relaxed at the sides.",
    "The whole figure is visible from head to shoes, with space above and below; nothing cropped.",
    STUDIO,
    SOLO,
  ],
  three_quarter: [
    "Three-quarter view: the head and shoulders turned about 45 degrees away from the camera, framed from the head to the waist, neutral relaxed expression.",
    STUDIO,
    SOLO,
  ],
  profile: [
    "Side profile: the head and shoulders seen exactly side-on (90 degrees), neutral relaxed expression.",
    STUDIO,
    SOLO,
  ],
  profile_left: [
    "Left profile: the person faces the LEFT edge of the picture, head and shoulders seen exactly side-on (90 degrees), neutral relaxed expression.",
    STUDIO,
    SOLO,
  ],
  profile_right: [
    "Right profile: the person faces the RIGHT edge of the picture, head and shoulders seen exactly side-on (90 degrees), neutral relaxed expression.",
    STUDIO,
    SOLO,
  ],
  half_body: [
    "Half-body view: from the top of the head to the hips, facing the camera, arms relaxed and visible, neutral standing pose.",
    STUDIO,
    SOLO,
  ],
  full_body: [
    "Full-body view: front, neutral standing pose, arms relaxed at the sides; head to shoes with space above and below, nothing cropped.",
    STUDIO,
    SOLO,
  ],
  look_sheet: [
    "Look sheet: the same person shown full-body three times side by side on one picture: front, three-quarter and side.",
    "Wardrobe, hair and accessories clearly visible and identical in all three.",
    STUDIO,
    "No text, watermark or border.",
  ],
  outfit_variant: [
    "Wardrobe reference: full-body front view showing the complete outfit clearly from head to shoes.",
    STUDIO,
    SOLO,
  ],
  expression_variant: [
    "Expression reference: head and shoulders, facing the camera; the expression named in the direction, clearly readable.",
    STUDIO,
    SOLO,
  ],
  scene_variation: [
    "The same person placed in the scene named in the direction, framed as a cinematic still of that moment.",
    "No text, watermark or border.",
  ],
  location_concept: [
    "Wide concept image of the location, no people, readable layout and materials.",
    EMPTY_PLACE,
  ],
  background: [
    "Clean background plate of the location: no people, no foreground subject, steady eye-level view.",
    EMPTY_PLACE,
  ],
  establishing_view: [
    "Establishing wide shot of the location as an audience first sees it; no people in focus.",
    EMPTY_PLACE,
  ],
  alternate_angle: [
    "The same location from a different camera angle than its existing views; no people.",
    EMPTY_PLACE,
  ],
  interior_view: [
    "Interior view of the location, wide, eye level, readable layout and materials; no people in focus.",
    EMPTY_PLACE,
  ],
  exterior_view: [
    "Exterior view of the location, wide, as approached from outside; no people in focus.",
    EMPTY_PLACE,
  ],
  time_variant: [
    "The same place, same layout and materials, shown in the time of day or state named in the direction; no people in focus.",
    EMPTY_PLACE,
  ],
};

export type ImageSubject =
  | { kind: "character"; characterId: string; intent: CharacterImageIntent; lookId?: string | null }
  | { kind: "location"; locationId: string; intent: LocationImageIntent };

export interface SubjectImageInputs {
  subject: ImageSubject;
  /** The creator's own direction, added to Prism's description (may be empty). */
  direction: string;
  /**
   * Reference Studio: the exact images to start from, in the order they are sent. Each must be a stored image of this
   * project; the caller checks that it belongs to the subject. What is chosen is what is sent, so an EMPTY list means
   * "from the written description": no identity image is sent (a selected Look still brings its own references).
   * Absent = Prism's automatic selection (canonical identity, then the Look, then the other references).
   */
  sourceAssetIds?: readonly string[];
}

export interface SubjectImagePlanOptions {
  /** How many images the chosen model will receive (0 = none: text only). Absent = every reference. */
  maxReferences?: number;
  /** Change ONE stored image (sent first) instead of making a new picture. */
  edit?: { sourceAssetId: string; instruction: string } | null;
}

export const MAX_SUBJECT_DIRECTION_CHARS = 2_000;

const line = (label: string, value: string | null | undefined) => {
  const v = (value ?? "").trim();
  return v ? [`${label}: ${v}`] : [];
};
const bare = (value: string | null | undefined) => {
  const v = (value ?? "").trim();
  return v ? [v] : [];
};
const plural = (n: number) => (n === 1 ? "" : "s");

/** An Asset can be sent to a provider only when it has a stored file (a seed record without bytes never is). */
export const hasStoredImage = (a: Asset | undefined): a is Asset =>
  !!a && a.type === "image" && !!a.objectPath && !!a.checksum;

export interface SubjectImagePlan {
  plan: PromptPlan;
  positive: string;
  negative: string;
  /** Exactly the images the request sends, in order (already within the model's limit). */
  references: GenerationReference[];
  /** Images Prism assembled that the chosen model has no room for. */
  referencesNotSent: number;
  /** What the images are for: nothing sent, reproduced in a new picture, or one image changed. */
  operation: SubjectImageOperation;
  /** Frozen BY VALUE on the attempt, like a Shot's GenerationPackage. */
  packageSnapshot: Record<string, unknown>;
  packageFingerprint: string;
}

export class SubjectImageError extends Error {}

type Candidate = Pick<GenerationReference, "assetId" | "role" | "label">;

/** How a stored image is named to the model: what it shows and whether it is a photograph or a generated picture. */
function imageKind(asset: Asset | undefined): string {
  const origin = referenceOrigin(asset);
  return origin === "uploaded"
    ? "reference photo"
    : origin === "generated"
      ? "generated reference"
      : "reference image";
}

const KEEP_PERSON =
  "Keep everything else exactly as it is: the same person (face, features, skin tone, apparent age), expression, pose, framing and crop; and the hair, clothing, background and lighting unless the change above is about them.";
const KEEP_PLACE =
  "Keep everything else exactly as it is: the same place, architecture, layout, materials, camera position and framing, unless the change above is about them.";

export function buildSubjectImagePlan(
  data: ProjectData,
  input: SubjectImageInputs,
  options: SubjectImagePlanOptions = {},
): SubjectImagePlan {
  const direction = input.direction.trim().slice(0, MAX_SUBJECT_DIRECTION_CHARS);
  const edit = options.edit
    ? {
        sourceAssetId: options.edit.sourceAssetId,
        instruction: options.edit.instruction.trim().slice(0, MAX_SUBJECT_DIRECTION_CHARS),
      }
    : null;
  const max = options.maxReferences ?? Number.POSITIVE_INFINITY;
  const sections: PromptPlan["sections"] = [];
  const assetOf = (id: string | null | undefined) => (id ? data.assets.find((a) => a.id === id) : undefined);
  const explicit = input.sourceAssetIds ? [...new Set(input.sourceAssetIds)] : null;
  for (const id of [...(explicit ?? []), ...(edit ? [edit.sourceAssetId] : [])])
    if (!hasStoredImage(assetOf(id)))
      throw new SubjectImageError("That image no longer exists in this project.");
  if (edit && !edit.instruction) throw new SubjectImageError("Describe the edit.");

  /** Deduplicated, in order, cut to what the model takes. */
  const candidates: Candidate[] = [];
  const add = (c: Candidate) => {
    if (!candidates.some((x) => x.assetId === c.assetId)) candidates.push(c);
  };
  let sent: Candidate[] = [];
  let subjectSnapshot: Record<string, unknown>;
  let operation: SubjectImageOperation;
  const settle = () => {
    sent = candidates.slice(0, Math.max(0, max));
    if (edit && sent[0]?.assetId !== edit.sourceAssetId)
      throw new SubjectImageError("That model cannot take the image to edit.");
    operation = edit ? "edit" : sent.length > 0 ? "reference" : "text";
    return operation;
  };

  if (input.subject.kind === "character") {
    const s = input.subject;
    const character: Character | undefined = data.characters.find((c) => c.id === s.characterId);
    if (!character) throw new SubjectImageError("That character no longer exists.");
    const look: CharacterLook | undefined = s.lookId
      ? data.looks.find((l) => l.id === s.lookId && l.characterId === character.id)
      : undefined;
    if (s.lookId && !look) throw new SubjectImageError("That Look does not belong to this character.");
    const ownRefs = data.identityRefs.filter((r: IdentityRef) => r.characterId === character.id);
    const ownLooks = data.looks.filter((l) => l.characterId === character.id);
    const lookRefs: Candidate[] = (look?.referenceAssetIds ?? [])
      .filter((id) => hasStoredImage(assetOf(id)))
      .map((id) => ({
        assetId: id,
        role: "character_look",
        label: `${character.name} Look "${look!.name}"`,
      }));

    if (edit) {
      add({ assetId: edit.sourceAssetId, role: "identity", label: "the image to edit" });
      for (const r of lookRefs) add(r);
    } else if (explicit) {
      // the creator's own choice of images, in their order: what is shown is what is sent
      for (const id of explicit) {
        const asset = assetOf(id);
        const ref = ownRefs.find((r) => r.assetId === id);
        const inLook = ownLooks.find((l) => l.referenceAssetIds.includes(id));
        const kind = imageKind(asset);
        if (!ref && inLook) {
          add({
            assetId: id,
            role: "character_look",
            label: `${character.name} Look "${inLook.name}" ${kind}`,
          });
          continue;
        }
        const role = ref ? visualRoleOf(ref) : null;
        const what =
          role === "canonical"
            ? " (canonical identity)"
            : role === "expression"
              ? ` (expression: ${expressionOf(ref!) ?? "expression"})`
              : role === "cutout"
                ? " (cutout)"
                : ref && ref.slot !== "additional"
                  ? ` (${ref.slot.replace("_", " ")})`
                  : "";
        add({ assetId: id, role: "identity", label: `${character.name} ${kind}${what}` });
      }
      for (const r of lookRefs) add(r);
    } else {
      // Phase 5B-I4 priority: canonical identity → selected Look → the other identity references (deterministic; the
      // list is cut from the END, so the highest-priority images always survive)
      const identityAll = orderedIdentityRefs(ownRefs.filter((r) => hasStoredImage(assetOf(r.assetId)))).map(
        (r) => ({
          assetId: r.assetId!,
          canonical: visualRoleOf(r) === "canonical",
          label:
            visualRoleOf(r) === "canonical"
              ? `${character.name} canonical identity`
              : visualRoleOf(r) === "cutout"
                ? `${character.name} cutout`
                : visualRoleOf(r) === "expression"
                  ? `${character.name} expression — ${expressionOf(r) ?? "expression"}`
                  : `${character.name} identity — ${r.slot.replace("_", " ")}`,
        }),
      );
      for (const r of identityAll.filter((x) => x.canonical))
        add({ assetId: r.assetId, role: "identity", label: r.label });
      for (const r of lookRefs) add(r);
      for (const r of identityAll.filter((x) => !x.canonical))
        add({ assetId: r.assetId, role: "identity", label: r.label });
    }
    settle();
    const sentIdentity = sent.filter((r) => r.role === "identity").length;
    const sentLook = sent.filter((r) => r.role === "character_look").length;
    const lookLines = look
      ? [
          ...line("Outfit", look.wardrobe),
          ...line("Shoes", look.shoes),
          ...line("Jewelry", look.jewelry),
          ...line("Hair", look.hair),
          ...line("Makeup", look.makeup),
          ...line("Grooming", look.grooming),
          ...line("Accessories", look.accessories),
          ...(sentLook > 0
            ? [
                `Match the Look reference image${plural(sentLook)}: the same garments, colours, hair styling and accessories.`,
              ]
            : []),
        ]
      : [];

    sections.push({
      key: "subject",
      title: "Subject",
      lines: [edit ? character.name : `${character.name}${character.role ? ` (${character.role})` : ""}`],
    });
    if (edit) {
      sections.push({
        key: "action",
        title: "Edit",
        lines: [
          `Change only this in the image being edited: ${edit.instruction}`,
          ...(direction ? [`Also: ${direction}`] : []),
        ],
      });
      if (look)
        sections.push({ key: "wardrobe", title: `Dress them in the Look: ${look.name}`, lines: lookLines });
      sections.push({ key: "hard_constraints", title: "Keep", lines: [KEEP_PERSON] });
    } else {
      // a Look names its own hair styling, so the reference's hair is kept only when no Look is applied
      const keepHair = !look?.hair?.trim();
      sections.push({
        key: "identity",
        title: "Identity",
        lines:
          sentIdentity > 0
            ? [
                `The same person as in the identity reference image${plural(sentIdentity)}: keep the face, facial features, skin tone, ${keepHair ? "hair, " : ""}apparent age and build exactly as shown. Do not beautify, restyle or change them.`,
                ...line(
                  "Written notes (the reference image wins where they differ)",
                  character.physicalDescription,
                ),
              ]
            : [
                // bare: the section is already rendered under its own "Appearance" label
                ...bare(character.physicalDescription),
                ...line("Description", character.description),
              ],
      });
      if (look) sections.push({ key: "wardrobe", title: `Look: ${look.name}`, lines: lookLines });
      else if (sentIdentity > 0)
        sections.push({
          key: "wardrobe",
          title: "Wardrobe",
          lines: [
            "Clothing and hair styling as in the reference image, unless the direction says otherwise.",
          ],
        });
    }
    subjectSnapshot = {
      kind: "character",
      characterId: character.id,
      name: character.name,
      physicalDescription: character.physicalDescription,
      description: character.description,
      look: look
        ? { id: look.id, name: look.name, updatedAt: (look as { updatedAt?: string }).updatedAt ?? null }
        : null,
    };
  } else {
    const s = input.subject;
    const location: Location | undefined = data.locations.find((l) => l.id === s.locationId);
    if (!location) throw new SubjectImageError("That location no longer exists.");
    if (edit) {
      add({ assetId: edit.sourceAssetId, role: "location", label: "the image to edit" });
    } else if (explicit) {
      for (const id of explicit)
        add({ assetId: id, role: "location", label: `${location.name} ${imageKind(assetOf(id))}` });
    } else {
      // Phase 5B-I5: the canonical location leads, then establishing views and plates, then the other references
      const bible = locationBibleOf(location);
      const ordered: Array<[string, string]> = [
        ...(bible.canonicalAssetId
          ? [[bible.canonicalAssetId, `${location.name} canonical location`] as [string, string]]
          : []),
        ...bible.entries
          .filter((e) => e.role === "establishing")
          .map((e) => [e.assetId, `${location.name} establishing view`] as [string, string]),
        ...bible.entries
          .filter((e) => e.role === "plate")
          .map((e) => [e.assetId, `${location.name} background plate`] as [string, string]),
        ...(location.referenceAssetIds ?? []).map(
          (id) => [id, `${location.name} reference`] as [string, string],
        ),
      ];
      for (const [id, label] of ordered)
        if (hasStoredImage(assetOf(id))) add({ assetId: id, role: "location", label });
    }
    settle();
    sections.push({ key: "subject", title: "Location", lines: [location.name] });
    if (edit) {
      sections.push({
        key: "action",
        title: "Edit",
        lines: [
          `Change only this in the image being edited: ${edit.instruction}`,
          ...(direction ? [`Also: ${direction}`] : []),
        ],
      });
      sections.push({ key: "hard_constraints", title: "Keep", lines: [KEEP_PLACE] });
    } else {
      sections.push({
        key: "environment",
        title: "Environment",
        lines: [
          ...(sent.length > 0
            ? [
                `The same place as in the reference image${plural(sent.length)}: keep its architecture, layout, materials, fixtures and colours. Only what is described here changes.`,
              ]
            : []),
          ...line("Description", location.description),
          ...line("Geography", location.geography),
          ...line("Lighting", location.lighting),
          ...(location.recurringProps?.length
            ? [`Recurring props: ${location.recurringProps.join(", ")}`]
            : []),
        ],
      });
    }
    subjectSnapshot = {
      kind: "location",
      locationId: location.id,
      name: location.name,
      description: location.description,
    };
  }

  if (!edit) {
    sections.push({
      key: "composition",
      title: SUBJECT_IMAGE_INTENT_LABEL[input.subject.intent],
      lines: COMPOSITION[input.subject.intent],
    });
    if (direction) sections.push({ key: "action", title: "Direction", lines: [direction] });
    // Only what describes the PICTURE. The project's story canon and software guardrails are rules for Prism and its
    // Shots, not image content, so a reference never carries them. A Location and a scene keep the project's visual
    // style (it is the look of the film's world); a Character reference is a neutral studio picture, so the style
    // names the medium only, and a reference image, when one is sent, decides it.
    const style = (data.bible?.visualStyle ?? "").trim();
    const rendering =
      input.subject.kind === "location" || input.subject.intent === "scene_variation"
        ? line("Visual style", style)
        : operation! === "reference"
          ? ["Keep the rendering style of the reference image: a photograph stays a photograph."]
          : line("Project visual style, for the rendering medium only (the studio setup above stays)", style);
    if (rendering.length) sections.push({ key: "hard_constraints", title: "Rendering", lines: rendering });
  }
  const negative = ["text, captions, watermark, logo, extra limbs, duplicated person"];
  sections.push({ key: "negative_constraints", title: "Avoid", lines: negative });

  const plan: PromptPlan = { version: 1, sections: sections.filter((x) => x.lines.length > 0) };
  const positive = plan.sections
    .filter((x) => x.key !== "negative_constraints")
    .flatMap((x) => x.lines)
    .join("\n");
  const sentIds = new Set(sent.map((r) => r.assetId));
  const packageSnapshot = {
    schema: "prism.subject-image-package.v2",
    policy: SUBJECT_IMAGE_POLICY,
    operation: operation!,
    subject: subjectSnapshot,
    intent: input.subject.intent,
    direction,
    ...(edit ? { edit } : {}),
    ...(explicit ? { sourceAssetIds: explicit } : {}),
    references: candidates.map((r) => ({
      assetId: r.assetId,
      role: r.role,
      checksum: assetOf(r.assetId)?.checksum ?? null,
      sent: sentIds.has(r.assetId),
    })),
  };
  return {
    plan,
    positive,
    negative: negative.join(", "),
    references: sent.map((r, i) => ({ ...r, order: i })),
    referencesNotSent: candidates.length - sent.length,
    operation: operation!,
    packageSnapshot,
    packageFingerprint: fingerprint(packageSnapshot),
  };
}

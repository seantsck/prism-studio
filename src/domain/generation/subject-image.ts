import { fingerprint } from "../hash";
import { expressionOf, orderedIdentityRefs, visualRoleOf } from "../visual-bible";
import type { Asset, Character, CharacterLook, IdentityRef, Location, ProjectData } from "../schemas";
import type { GenerationReference, PromptPlan } from "./schemas";

/**
 * Phase 5B-I1: images whose SUBJECT is a Character or a Location (not a Shot). This module is pure: it turns Prism's
 * own records into the same frozen artefacts a Shot generation produces (a PromptPlan, a reference list and a frozen
 * package), so the existing request / worker / ingest pipeline runs them unchanged.
 *
 * Prism writes the prompt from the Bible; the creator adds direction; the human chooses the model.
 */
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
] as const;
export const LOCATION_IMAGE_INTENTS = [
  "location_concept",
  "background",
  "establishing_view",
  "alternate_angle",
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
  location_concept: "Location concept",
  background: "Background",
  establishing_view: "Establishing view",
  alternate_angle: "Alternate angle",
};

/** What the image is asked to show, per intent (composition only; the subject's facts come from the Bible). */
const COMPOSITION: Record<SubjectImageIntent, string[]> = {
  portrait: [
    "Head-and-shoulders portrait, eye level, neutral background, soft even light, face clearly readable.",
  ],
  character_reference: [
    "Full-body character reference, front view, neutral pose, plain neutral background, even light.",
    "The whole figure is visible from head to shoes; nothing cropped.",
  ],
  three_quarter: [
    "Three-quarter view of the character (face turned about 45 degrees), head to waist, plain neutral background, even light.",
  ],
  profile: ["Side profile of the character, head and shoulders, plain neutral background, even light."],
  full_body: [
    "Full-body view, front, neutral standing pose, plain neutral background, even light; head to shoes, nothing cropped.",
  ],
  look_sheet: [
    "Character look sheet: the same person shown full-body from the front, three-quarter and side on one sheet.",
    "Plain neutral background; wardrobe, hair and accessories clearly visible.",
  ],
  outfit_variant: ["Full-body view showing the outfit clearly, plain neutral background, even light."],
  expression_variant: ["Head-and-shoulders, clear facial expression, neutral background, even light."],
  location_concept: ["Wide concept image of the location, no people, readable layout and materials."],
  background: [
    "Clean background plate of the location: no people, no foreground subject, steady eye-level view.",
  ],
  establishing_view: [
    "Establishing wide shot of the location as an audience first sees it; no people in focus.",
  ],
  alternate_angle: ["The same location from a different camera angle than its existing views; no people."],
};

export type ImageSubject =
  | { kind: "character"; characterId: string; intent: CharacterImageIntent; lookId?: string | null }
  | { kind: "location"; locationId: string; intent: LocationImageIntent };

export interface SubjectImageInputs {
  subject: ImageSubject;
  /** The creator's own direction, added to Prism's description (may be empty). */
  direction: string;
}

const line = (label: string, value: string | null | undefined) => {
  const v = (value ?? "").trim();
  return v ? [`${label}: ${v}`] : [];
};

/** An Asset can be sent to a provider only when it has a stored file (a seed record without bytes never is). */
export const hasStoredImage = (a: Asset | undefined): a is Asset =>
  !!a && a.type === "image" && !!a.objectPath && !!a.checksum;

export interface SubjectImagePlan {
  plan: PromptPlan;
  positive: string;
  negative: string;
  /** Every reference Prism WOULD send (the request trims to the chosen model's limit). */
  references: GenerationReference[];
  /** Frozen BY VALUE on the attempt, like a Shot's GenerationPackage. */
  packageSnapshot: Record<string, unknown>;
  packageFingerprint: string;
}

export class SubjectImageError extends Error {}

export function buildSubjectImagePlan(data: ProjectData, input: SubjectImageInputs): SubjectImagePlan {
  const direction = input.direction.trim().slice(0, 2000);
  const sections: PromptPlan["sections"] = [];
  const refs: GenerationReference[] = [];
  const assetOf = (id: string | null | undefined) => (id ? data.assets.find((a) => a.id === id) : undefined);
  let subjectSnapshot: Record<string, unknown>;

  if (input.subject.kind === "character") {
    const s = input.subject;
    const character: Character | undefined = data.characters.find((c) => c.id === s.characterId);
    if (!character) throw new SubjectImageError("That character no longer exists.");
    const look: CharacterLook | undefined = s.lookId
      ? data.looks.find((l) => l.id === s.lookId && l.characterId === character.id)
      : undefined;
    if (s.lookId && !look) throw new SubjectImageError("That Look does not belong to this character.");
    sections.push({
      key: "subject",
      title: "Subject",
      lines: [`${character.name}${character.role ? ` (${character.role})` : ""}`],
    });
    sections.push({
      key: "identity",
      title: "Identity",
      lines: [
        ...line("Appearance", character.physicalDescription),
        ...line("Description", character.description),
      ],
    });
    if (look)
      sections.push({
        key: "wardrobe",
        title: `Look: ${look.name}`,
        lines: [
          ...line("Wardrobe", look.wardrobe),
          ...line("Shoes", look.shoes),
          ...line("Jewelry", look.jewelry),
          ...line("Hair", look.hair),
          ...line("Makeup", look.makeup),
          ...line("Grooming", look.grooming),
          ...line("Accessories", look.accessories),
        ],
      });
    // Phase 5B-I4 priority: canonical identity → selected Look → the other identity references (deterministic; the
    // request trims to the model's limit from the END, so the highest-priority images always survive)
    const identityAll = orderedIdentityRefs(
      data.identityRefs.filter(
        (r: IdentityRef) => r.characterId === character.id && hasStoredImage(assetOf(r.assetId)),
      ),
    ).map((r) => ({
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
    }));
    const canonicalFirst = identityAll.filter((r) => r.canonical);
    const identity = identityAll.filter((r) => !r.canonical);
    const lookRefs = (look?.referenceAssetIds ?? [])
      .filter((id) => hasStoredImage(assetOf(id)))
      .map((id) => ({ assetId: id, label: `${character.name} Look "${look!.name}"` }));
    const seen = new Set<string>();
    for (const [role, list] of [
      ["identity", canonicalFirst],
      ["character_look", lookRefs],
      ["identity", identity],
    ] as const)
      for (const r of list)
        if (!seen.has(r.assetId)) {
          seen.add(r.assetId);
          refs.push({ assetId: r.assetId, role, order: refs.length, label: r.label });
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
    sections.push({ key: "subject", title: "Location", lines: [location.name] });
    sections.push({
      key: "environment",
      title: "Environment",
      lines: [
        ...line("Description", location.description),
        ...line("Geography", location.geography),
        ...line("Lighting", location.lighting),
        ...(location.recurringProps?.length
          ? [`Recurring props: ${location.recurringProps.join(", ")}`]
          : []),
      ],
    });
    for (const id of location.referenceAssetIds ?? [])
      if (hasStoredImage(assetOf(id)))
        refs.push({ assetId: id, role: "location", order: refs.length, label: `${location.name} reference` });
    subjectSnapshot = {
      kind: "location",
      locationId: location.id,
      name: location.name,
      description: location.description,
    };
  }

  sections.push({
    key: "composition",
    title: SUBJECT_IMAGE_INTENT_LABEL[input.subject.intent],
    lines: COMPOSITION[input.subject.intent],
  });
  if (direction) sections.push({ key: "action", title: "Direction", lines: [direction] });
  const bible = data.bible;
  const listOrText = (v: unknown) =>
    Array.isArray(v) ? v.filter(Boolean).join("; ") : typeof v === "string" ? v : "";
  const hard = [
    ...line("Visual style", bible?.visualStyle),
    ...line("Canon", listOrText(bible?.canonFacts)),
    ...line("Guardrails", listOrText(bible?.guardrails)),
  ];
  if (hard.length) sections.push({ key: "hard_constraints", title: "Project rules", lines: hard });
  const negative = ["text, captions, watermark, logo, extra limbs, duplicated person"];
  sections.push({ key: "negative_constraints", title: "Avoid", lines: negative });

  const plan: PromptPlan = { version: 1, sections: sections.filter((x) => x.lines.length > 0) };
  const positive = plan.sections
    .filter((x) => x.key !== "negative_constraints")
    .flatMap((x) => x.lines)
    .join("\n");
  const packageSnapshot = {
    schema: "prism.subject-image-package.v1",
    subject: subjectSnapshot,
    intent: input.subject.intent,
    direction,
    references: refs.map((r) => ({
      assetId: r.assetId,
      role: r.role,
      checksum: assetOf(r.assetId)?.checksum ?? null,
    })),
  };
  return {
    plan,
    positive,
    negative: negative.join(", "),
    references: refs,
    packageSnapshot,
    packageFingerprint: fingerprint(packageSnapshot),
  };
}

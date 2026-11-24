import { fingerprint } from "../hash";
import { partSizeOf } from "../character-ai";
import type { ProjectData } from "../schemas";
import { locationBibleOf } from "../location-visual-bible";
import { canonicalRefOf } from "../visual-bible";
import type { GenerationReference, PromptPlan } from "./schemas";
import { hasStoredImage, MAX_SUBJECT_DIRECTION_CHARS, type SubjectImagePlan } from "./subject-image";

/**
 * Cover art for a project: one poster or key-art image of the series or film, made from its title, premise, tone and
 * visual style, with the main cast's canonical pictures so the faces match. The picture carries NO lettering: image
 * models misspell text (Japanese above all), so Prism lays the title over it when it is shown.
 */
export const COVER_ART_POLICY = { id: "cover-art", version: 1 } as const;

/** The shapes a cover can take, most usual first (a model offers some of them). */
export const COVER_SHAPES = [
  { ratio: "2:3", label: "Poster (2:3)" },
  { ratio: "3:4", label: "Portrait (3:4)" },
  { ratio: "9:16", label: "Tall (9:16)" },
  { ratio: "1:1", label: "Square (1:1)" },
  { ratio: "4:3", label: "Landscape (4:3)" },
  { ratio: "16:9", label: "Wide (16:9)" },
  { ratio: "21:9", label: "Banner (21:9)" },
] as const;

/** The most cast members a cover shows by name and picture. */
export const COVER_CAST_MAX = 4;

export class CoverArtError extends Error {}

export interface CoverArtInputs {
  /** The creator's own direction (may be empty). */
  direction: string;
  /** The Characters to feature, in order; absent = the leads Prism picks (leads first, then the rest). */
  castIds?: readonly string[];
  /** The Location it is set in (its canonical picture is sent after the cast's); absent or null = none. */
  locationId?: string | null;
}

/** A Location's picture for a cover: its canonical view, else its first reference picture. */
export function coverPictureOfLocation(data: ProjectData, locationId: string): string | null {
  const l = data.locations.find((x) => x.id === locationId);
  if (!l) return null;
  const ids = [locationBibleOf(l).canonicalAssetId, ...l.referenceAssetIds].filter((x): x is string => !!x);
  return ids.find((id) => hasStoredImage(data.assets.find((a) => a.id === id))) ?? null;
}

/** The Characters a cover features by default: leads first, then supporting parts, never extras. */
export function defaultCoverCast(data: ProjectData): string[] {
  const rank = { lead: 0, supporting: 1, minor: 2 } as const;
  return [...data.characters]
    .filter((c) => !c.trashedAt && partSizeOf(c) !== "minor")
    .sort((a, b) => rank[partSizeOf(a)] - rank[partSizeOf(b)])
    .slice(0, COVER_CAST_MAX)
    .map((c) => c.id);
}

export function buildCoverArtPlan(
  data: ProjectData,
  input: CoverArtInputs,
  options: { maxReferences?: number } = {},
): SubjectImagePlan {
  const direction = input.direction.trim().slice(0, MAX_SUBJECT_DIRECTION_CHARS);
  const max = options.maxReferences ?? Number.POSITIVE_INFINITY;
  const castIds = [...new Set(input.castIds ?? defaultCoverCast(data))].slice(0, COVER_CAST_MAX);
  const cast = castIds.map((id) => {
    const c = data.characters.find((x) => x.id === id && !x.trashedAt);
    if (!c) throw new CoverArtError("One of the characters chosen is no longer in this project.");
    return c;
  });
  // each featured character's canonical identity picture, in cast order, within what the model takes
  const candidates: Array<Pick<GenerationReference, "assetId" | "role" | "label">> = [];
  for (const c of cast) {
    const ref = canonicalRefOf(data, c.id);
    const asset = ref?.assetId ? data.assets.find((a) => a.id === ref.assetId) : undefined;
    if (hasStoredImage(asset)) candidates.push({ assetId: asset.id, role: "identity", label: `${c.name}` });
  }
  const location = input.locationId
    ? (data.locations.find((l) => l.id === input.locationId && !l.trashedAt) ?? null)
    : null;
  if (input.locationId && !location) throw new CoverArtError("That location is no longer in this project.");
  const placeId = location ? coverPictureOfLocation(data, location.id) : null;
  if (placeId) candidates.push({ assetId: placeId, role: "location", label: location!.name });
  const sent = candidates.slice(0, Math.max(0, max));
  const pictured = new Set(sent.filter((r) => r.role === "identity").map((r) => r.label));
  const placePictured = sent.some((r) => r.role === "location");

  const project = data.project;
  const bible = data.bible;
  const kind =
    project.projectType === "film" ? "film" : project.projectType === "short" ? "short film" : "series";
  const line = (label: string, v: string | null | undefined) => (v?.trim() ? [`${label}: ${v.trim()}`] : []);
  const sections: PromptPlan["sections"] = [
    {
      key: "subject",
      title: "Cover art",
      lines: [
        `Key art for the ${kind} "${project.title}": one striking poster image that tells what it is about at a glance.`,
        ...line("Premise", bible.premise?.slice(0, 1200)),
        ...line("Genre", project.genre),
        ...line("Tone", project.tone),
      ],
    },
    {
      key: "identity",
      title: "Cast",
      lines: cast.length
        ? cast.map((c) =>
            pictured.has(c.name)
              ? `${c.name}: the same person as in the reference image labelled ${c.name}; keep the face, features, skin tone, hair and apparent age exactly.`
              : `${c.name}${c.physicalDescription ? `: ${c.physicalDescription}` : ""}`,
          )
        : [],
    },
    ...(location
      ? [
          {
            key: "environment" as const,
            title: "Setting",
            lines: [
              placePictured
                ? `Set in ${location.name}: the same place as in the reference image labelled ${location.name} (its architecture, materials and mood).`
                : `Set in ${location.name}${location.description ? `: ${location.description}` : ""}`,
            ],
          },
        ]
      : []),
    {
      key: "composition",
      title: "Composition",
      lines: [
        "Cinematic, professional poster composition with a clear focal point and dramatic, motivated lighting.",
        "Leave calm, uncluttered space in the upper third for a title that is added later.",
        "No lettering of any kind in the image.",
      ],
    },
    ...(bible.visualStyle?.trim()
      ? [
          {
            key: "hard_constraints" as const,
            title: "Rendering",
            lines: [`Visual style: ${bible.visualStyle.trim()}`],
          },
        ]
      : []),
    ...(direction ? [{ key: "action" as const, title: "Direction", lines: [direction] }] : []),
  ];
  const negative = [
    "text, letters, title, credits, captions, watermark, logo, signature, extra limbs, duplicated person, distorted faces",
  ];
  sections.push({ key: "negative_constraints", title: "Avoid", lines: negative });
  const plan: PromptPlan = { version: 1, sections: sections.filter((x) => x.lines.length > 0) };
  const positive = plan.sections
    .filter((x) => x.key !== "negative_constraints")
    .flatMap((x) => x.lines)
    .join("\n");
  const packageSnapshot = {
    schema: "prism.cover-art-package.v1",
    policy: COVER_ART_POLICY,
    project: { id: project.id, title: project.title, projectType: project.projectType },
    cast: cast.map((c) => ({ id: c.id, name: c.name })),
    location: location ? { id: location.id, name: location.name } : null,
    direction,
    references: candidates.map((r) => ({
      assetId: r.assetId,
      role: r.role,
      checksum: data.assets.find((a) => a.id === r.assetId)?.checksum ?? null,
      sent: sent.some((x) => x.assetId === r.assetId),
    })),
  };
  return {
    plan,
    positive,
    negative: negative.join(", "),
    references: sent.map((r, i) => ({ ...r, order: i })),
    referencesNotSent: candidates.length - sent.length,
    operation: sent.length > 0 ? "reference" : "text",
    packageSnapshot,
    packageFingerprint: fingerprint(packageSnapshot),
  };
}

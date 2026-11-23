import { isTurned, swapsSides } from "@/lib/image-size";
import { SUGGESTED_LOCATION_VARIANTS } from "../location-visual-bible";
import type { Asset, CharacterLook, IdentityRef } from "../schemas";
import { SUGGESTED_EXPRESSIONS } from "../visual-bible";
import { parseUploadCopy, uploadCopySentence } from "./reference-upload";
import type { CharacterImageIntent, LocationImageIntent, SubjectImageIntent } from "./subject-image";

/**
 * The Reference Studio: one screen that turns a limited or imperfect reference photograph into a consistent set of
 * production references. Everything here is pure: the catalogue of what can be made, the ways an image can be changed,
 * what an uploaded file is good for, which picture format suits what, and what similar images really cost.
 *
 * It adds no pipeline. A preset is an intent of the existing Character / Location image path; an edit preset is an
 * instruction for the existing "edit one image" path. The human still chooses the model, and nothing is promoted to
 * the Visual Bible without an explicit "Use as…".
 */

// ───────────────────────── what to make ─────────────────────────

export interface PresetParam {
  label: string;
  placeholder: string;
  suggestions: readonly string[];
}

export interface ReferencePreset {
  /** The existing image intent this preset feeds. */
  intent: SubjectImageIntent;
  label: string;
  /** One short line under the label: what the picture will show. */
  hint: string;
  group: "angles" | "wardrobe" | "expression" | "scene" | "place";
  /** Picture formats in order of preference; the first one the chosen model offers is used. */
  ratios: readonly string[];
  /** Where a result usually goes when it is promoted (a suggestion; the creator chooses). */
  slot?: IdentityRef["slot"];
  /** A short value the creator must supply (an expression, a time of day, a scene). */
  param?: PresetParam;
  /** The picture is of a wardrobe, so it needs a Look to describe. */
  needsLook?: boolean;
}

const TALL = ["2:3", "9:16", "1:1", "3:2", "16:9", "21:9"] as const;
const WIDE = ["16:9", "3:2", "21:9", "1:1", "2:3", "9:16"] as const;
const SHEET = ["3:2", "16:9", "1:1", "21:9", "2:3", "9:16"] as const;

export const CHARACTER_PRESETS: readonly (ReferencePreset & { intent: CharacterImageIntent })[] = [
  {
    intent: "portrait",
    label: "Front portrait",
    hint: "Head and shoulders, facing the camera",
    group: "angles",
    ratios: TALL,
    slot: "front",
  },
  {
    intent: "three_quarter",
    label: "3/4 view",
    hint: "Turned about 45°, head to waist",
    group: "angles",
    ratios: TALL,
    slot: "three_quarter",
  },
  {
    intent: "profile_left",
    label: "Left profile",
    hint: "Side-on, facing the left edge",
    group: "angles",
    ratios: TALL,
    slot: "profile",
  },
  {
    intent: "profile_right",
    label: "Right profile",
    hint: "Side-on, facing the right edge",
    group: "angles",
    ratios: TALL,
    slot: "additional",
  },
  {
    intent: "half_body",
    label: "Half body",
    hint: "Head to hips, facing the camera",
    group: "angles",
    ratios: TALL,
    slot: "additional",
  },
  {
    intent: "full_body",
    label: "Full body",
    hint: "Head to shoes, nothing cropped",
    group: "angles",
    ratios: TALL,
    slot: "full_body",
  },
  {
    intent: "outfit_variant",
    label: "Wardrobe reference",
    hint: "Full body in the chosen Look",
    group: "wardrobe",
    ratios: TALL,
    needsLook: true,
  },
  {
    intent: "look_sheet",
    label: "Look sheet",
    hint: "Front, 3/4 and side on one picture",
    group: "wardrobe",
    ratios: SHEET,
    needsLook: true,
  },
  {
    intent: "expression_variant",
    label: "Expression",
    hint: "Head and shoulders with a named expression",
    group: "expression",
    ratios: TALL,
    slot: "additional",
    param: { label: "Expression", placeholder: "concerned", suggestions: SUGGESTED_EXPRESSIONS },
  },
  {
    intent: "scene_variation",
    label: "Scene variation",
    hint: "The same person in a scene you describe",
    group: "scene",
    ratios: WIDE,
    param: {
      label: "Scene",
      placeholder: "standing by the elevators in a hotel lobby at night",
      suggestions: [],
    },
  },
];

export const LOCATION_PRESETS: readonly (ReferencePreset & { intent: LocationImageIntent })[] = [
  {
    intent: "location_concept",
    label: "Concept",
    hint: "A wide first look at the place",
    group: "place",
    ratios: WIDE,
  },
  {
    intent: "establishing_view",
    label: "Establishing view",
    hint: "As the audience first sees it",
    group: "place",
    ratios: WIDE,
  },
  {
    intent: "interior_view",
    label: "Interior view",
    hint: "Inside, wide, eye level",
    group: "place",
    ratios: WIDE,
  },
  {
    intent: "exterior_view",
    label: "Exterior view",
    hint: "From outside, as approached",
    group: "place",
    ratios: WIDE,
  },
  {
    intent: "alternate_angle",
    label: "Alternate angle",
    hint: "The same place from another camera position",
    group: "place",
    ratios: WIDE,
  },
  {
    intent: "background",
    label: "Background plate",
    hint: "Empty, steady, for compositing",
    group: "place",
    ratios: WIDE,
  },
  {
    intent: "time_variant",
    label: "Time of day",
    hint: "The same place at another time or state",
    group: "place",
    ratios: WIDE,
    param: { label: "Time or state", placeholder: "rainy night", suggestions: SUGGESTED_LOCATION_VARIANTS },
  },
];

export const referencePresets = (kind: "character" | "location"): readonly ReferencePreset[] =>
  kind === "character" ? CHARACTER_PRESETS : LOCATION_PRESETS;

export function referencePreset(kind: "character" | "location", intent: string): ReferencePreset | null {
  return referencePresets(kind).find((p) => p.intent === intent) ?? null;
}

export const MAX_PRESET_VALUE_CHARS = 300;
export const MAX_CUSTOM_EDIT_CHARS = 2_000;

/**
 * The creator's direction for a preset that takes a value: the value leads ("Expression: concerned."), their own words
 * follow. A preset without a value passes the direction through.
 */
export function presetDirection(preset: ReferencePreset | null, value: string, direction: string): string {
  const v = value.trim().replace(/\s+/g, " ").slice(0, MAX_PRESET_VALUE_CHARS);
  const d = direction.trim();
  if (!preset?.param || !v) return d;
  return [`${preset.param.label}: ${v.replace(/[.\s]+$/, "")}.`, d].filter(Boolean).join(" ");
}

// ───────────────────────── how to change one image ─────────────────────────

export const EDIT_PRESET_IDS = [
  "hair_color",
  "wardrobe",
  "lighting_quality",
  "clean_background",
  "replace_background",
  "remove_people",
  "custom",
] as const;
export type EditPresetId = (typeof EDIT_PRESET_IDS)[number];

export interface EditPreset {
  id: EditPresetId;
  for: "character" | "location" | "both";
  label: string;
  hint: string;
  /** The value the creator supplies; `required: false` means the preset works without one. */
  param?: PresetParam & { required: boolean };
  /** Wardrobe may come from one of the Character's Looks instead of typed words. */
  usesLook?: boolean;
}

export const EDIT_PRESETS: readonly EditPreset[] = [
  {
    id: "hair_color",
    for: "character",
    label: "Change hair colour",
    hint: "Same hairstyle, new colour",
    param: {
      label: "New hair colour",
      placeholder: "auburn",
      suggestions: ["black", "dark brown", "auburn", "blonde", "silver"],
      required: true,
    },
  },
  {
    id: "wardrobe",
    for: "character",
    label: "Change clothing",
    hint: "Describe it, or apply a Look",
    param: {
      label: "New clothing",
      placeholder: "charcoal wool overcoat over a white shirt",
      suggestions: [],
      required: false,
    },
    usesLook: true,
  },
  {
    id: "lighting_quality",
    for: "both",
    label: "Improve lighting and quality",
    hint: "Exposure, colour, noise and blur; nothing else",
  },
  {
    id: "clean_background",
    for: "character",
    label: "Clean studio background",
    hint: "Plain white behind the person",
  },
  {
    id: "replace_background",
    for: "character",
    label: "Replace background",
    hint: "Put the person somewhere else",
    param: {
      label: "New background",
      placeholder: "a rain-wet Tokyo street at night, out of focus",
      suggestions: [],
      required: true,
    },
  },
  {
    id: "remove_people",
    for: "location",
    label: "Remove people",
    hint: "An empty place, nothing else changed",
  },
  {
    id: "custom",
    for: "both",
    label: "Your own change",
    hint: "Describe exactly what should change",
    param: {
      label: "What to change",
      placeholder: "add thin gold-rimmed glasses",
      suggestions: [],
      required: true,
    },
  },
];

export const editPresets = (kind: "character" | "location"): EditPreset[] =>
  EDIT_PRESETS.filter((p) => p.for === "both" || p.for === kind);

export const editPreset = (id: string): EditPreset | null => EDIT_PRESETS.find((p) => p.id === id) ?? null;

export type EditInstruction = { ok: true; instruction: string } | { ok: false; reason: string };

/**
 * The instruction for an edit preset. It names the ONE thing that changes; the prompt policy adds "keep everything
 * else". A wardrobe change takes typed words or a Look (whose description and reference images the request carries).
 */
export function editInstruction(
  presetId: string,
  value: string,
  look?: Pick<CharacterLook, "name"> | null,
): EditInstruction {
  const preset = editPreset(presetId);
  if (!preset) return { ok: false, reason: "Choose what to change." };
  const v = value.trim().replace(/\s+/g, " ").slice(0, MAX_PRESET_VALUE_CHARS);
  const bare = v.replace(/[.\s]+$/, "");
  if (preset.param?.required && !bare)
    return { ok: false, reason: `${preset.param.label}: say what it should be.` };
  switch (preset.id) {
    case "hair_color":
      return {
        ok: true,
        instruction: `Change the hair colour to ${bare}. Keep the same hairstyle, length and hairline.`,
      };
    case "wardrobe":
      if (look)
        return {
          ok: true,
          instruction: `Change the clothing, hair styling and accessories to the Look "${look.name}" described below.${bare ? ` ${bare}.` : ""} Keep the body, pose and proportions.`,
        };
      if (!bare) return { ok: false, reason: "Describe the new clothing, or choose a Look." };
      return {
        ok: true,
        instruction: `Change the clothing to: ${bare}. Keep the body, pose and proportions.`,
      };
    case "lighting_quality":
      return {
        ok: true,
        instruction:
          "Improve the technical quality only: correct the exposure and white balance, even out harsh light and shadow, remove noise, blur and compression artefacts, and restore natural detail. Do not change the content of the picture.",
      };
    case "clean_background":
      return {
        ok: true,
        instruction:
          "Replace the background with a plain, solid white studio backdrop with soft even light. Keep the person, and the edge of their hair, exactly as they are.",
      };
    case "replace_background":
      return {
        ok: true,
        instruction: `Replace the background with: ${bare}. Light the person to match the new background naturally; do not change the person.`,
      };
    case "remove_people":
      return {
        ok: true,
        instruction:
          "Remove every person and moving vehicle so the place is empty, and fill in what they covered naturally.",
      };
    case "custom":
      // the creator's own words, in full
      return { ok: true, instruction: value.trim().slice(0, MAX_CUSTOM_EDIT_CHARS) };
  }
}

// ───────────────────────── picture format ─────────────────────────

export const FORMAT_LABEL: Record<string, string> = {
  "1:1": "Square",
  "2:3": "Portrait",
  "3:2": "Landscape",
  "16:9": "Wide",
  "9:16": "Tall",
  "21:9": "Cinema",
};

export const formatLabel = (ratio: string) =>
  FORMAT_LABEL[ratio] ? `${FORMAT_LABEL[ratio]} ${ratio}` : ratio;

const ratioValue = (ratio: string): number | null => {
  const [w, h] = ratio.split(":").map(Number);
  return w && h && Number.isFinite(w / h) ? w / h : null;
};

/** The first of the preset's preferred formats that the model offers; otherwise the model's own first. */
export function preferredFormat(preferred: readonly string[], offered: readonly string[]): string | null {
  return preferred.find((r) => offered.includes(r)) ?? offered[0] ?? null;
}

/**
 * The offered format closest to a picture's own shape. An edit should come back in the shape of the image it started
 * from: a different shape would make the model re-frame it.
 */
export function closestFormat(
  width: number | null | undefined,
  height: number | null | undefined,
  offered: readonly string[],
): string | null {
  if (!width || !height) return offered[0] ?? null;
  const target = Math.log(width / height);
  let best: string | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const r of offered) {
    const v = ratioValue(r);
    if (v == null) continue;
    const d = Math.abs(Math.log(v) - target);
    if (d < distance - 1e-9) {
      best = r;
      distance = d;
    }
  }
  return best ?? offered[0] ?? null;
}

// ───────────────────────── a Character's reference set ─────────────────────────

/**
 * A Character's reference set: the views every Production Frame of that Character is made from. Prism sends ALL of a
 * Character's identity references with a Shot (the canonical identity first, then the others), so the set is what
 * "canonical from several angles" means here: the front view IS the canonical identity, and the other views stand
 * beside it. Each view is one identity slot; the right profile and the half body, which have no slot of their own,
 * are extra references marked with their view (`metadata.view`). The profile slot holds the LEFT profile.
 */
export const REFERENCE_SET_VIEWS = [
  { id: "front", label: "Front", slot: "front", intent: "portrait", canonical: true },
  {
    id: "three_quarter",
    label: "3/4 view",
    slot: "three_quarter",
    intent: "three_quarter",
    canonical: false,
  },
  { id: "profile", label: "Left profile", slot: "profile", intent: "profile_left", canonical: false },
  {
    id: "right_profile",
    label: "Right profile",
    slot: "additional",
    intent: "profile_right",
    canonical: false,
  },
  { id: "half_body", label: "Half body", slot: "additional", intent: "half_body", canonical: false },
  { id: "full_body", label: "Full body", slot: "full_body", intent: "full_body", canonical: false },
] as const;

export type ReferenceSetViewId = (typeof REFERENCE_SET_VIEWS)[number]["id"];

export const isReferenceSetView = (v: string): v is ReferenceSetViewId =>
  REFERENCE_SET_VIEWS.some((x) => x.id === v);

/** The view a picture made with this preset belongs in, or null (a Look sheet, an expression, a scene …). */
export function referenceSetViewOf(intent: string | null | undefined): ReferenceSetViewId | null {
  switch (intent) {
    case "portrait":
      return "front";
    case "three_quarter":
      return "three_quarter";
    case "profile_left":
      return "profile";
    case "profile_right":
      return "right_profile";
    case "half_body":
      return "half_body";
    case "full_body":
      return "full_body";
    default:
      return null;
  }
}

/** What makes a strong set, in the creator's words (shown beside the set). */
export const REFERENCE_SET_GUIDANCE = [
  "Your own photos are the ground truth: 4 to 8 good ones, the face large, sharp and evenly lit, from slightly different angles. Crop full-phone screenshots first.",
  "Make each view from those photos, judge it beside them, and add only the ones that are clearly the same person. A wrong view is copied into every Shot.",
  "Six views are enough: front, 3/4, left and right profile, half body, full body. Past that, more pictures blur the likeness rather than sharpen it, and each one sent costs more.",
  "Add a Look for each outfit, and an expression only when a scene needs it.",
] as const;

// ───────────────────────── test models ─────────────────────────

/**
 * Whether the Studio offers test models, and shows what they made. A test model draws a coloured pattern: it is there
 * to exercise the workflow where nothing real can run. Beside a real model that can be used it is only a way to make a
 * pattern by mistake (the owner made two on the hosted review site), so it is left out there, with its results,
 * unless the deployment asks for it (`PRISM_STUDIO_SHOW_TEST_MODELS=1`: a test server that needs both).
 */
export function offersTestModels(
  models: readonly { test: boolean; available: boolean }[],
  askedFor: boolean,
): boolean {
  return askedFor || !models.some((m) => !m.test && m.available);
}

// ───────────────────────── which pictures a generation starts from ─────────────────────────

/** What the Studio needs to know about a stored picture to choose starting images. */
export interface StartCandidate {
  assetId: string;
  /** "uploaded": the creator's own picture. Anything else was made by Prism or a model. */
  origin: string | null;
  /** true: the picture only shows a Look's wardrobe. It says what is worn, not who the Character is. */
  wardrobeOnly: boolean;
  /** true: the picture that currently stands for the subject (canonical identity or canonical location). */
  canonical: boolean;
  /** When the picture was stored (ISO), where that is known. */
  addedAt?: string | null;
}

const ownPhoto = (c: StartCandidate) => c.origin === "uploaded" && !c.wardrobeOnly;

/**
 * The starting images a freshly opened Studio offers. The creator's own photographs of the subject come first, ALL of
 * them: they are the ground truth, and several views of one person describe that person better than one. Only when
 * there is none does the picture that currently stands for the subject (often a generated one) take their place.
 */
export function defaultStartingImages(images: readonly StartCandidate[]): string[] {
  const photos = images.filter(ownPhoto).map((i) => i.assetId);
  if (photos.length > 0) return photos;
  const canonical = images.find((i) => i.canonical);
  return canonical ? [canonical.assetId] : [];
}

/**
 * The starting images after the creator added photographs: every photograph just added is selected (they were added to
 * be used), after whatever was selected before. A generated picture that was only selected by default gives way to the
 * creator's own photographs; one the creator chose themselves stays.
 */
export function startingImagesAfterUpload(args: {
  selected: readonly string[];
  images: readonly StartCandidate[];
  added: readonly string[];
  /** true: the creator changed the selection themselves, so all of it is kept. */
  chosenByCreator: boolean;
}): string[] {
  const present = new Set(args.images.map((i) => i.assetId));
  const added = [...new Set(args.added)].filter((id) => present.has(id));
  if (added.length === 0) return [...args.selected];
  const own = new Set(args.images.filter(ownPhoto).map((i) => i.assetId));
  const kept = args.selected.filter((id) => present.has(id) && (args.chosenByCreator || own.has(id)));
  return [...new Set([...kept, ...added])];
}

/**
 * true: the stage opens on the starting images instead of on the newest take. A photograph the creator added AFTER the
 * newest picture was made has not been used for anything yet: it is what they are about to work from, and an older
 * result in its place reads as if the photograph had been ignored.
 */
export function opensOnStartingImages(
  images: readonly StartCandidate[],
  newestTakeAt: string | null,
): boolean {
  const photos = images.filter(ownPhoto);
  if (photos.length === 0) return false;
  if (!newestTakeAt) return true;
  const made = Date.parse(newestTakeAt);
  return photos.some((p) => !!p.addedAt && Date.parse(p.addedAt) > made);
}

// ───────────────────────── what an uploaded file is good for ─────────────────────────

/** What the image models here take as an INPUT image (the stored original is kept whatever its format). */
export const MODEL_INPUT_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MODEL_INPUT_MAX_BYTES = 25 * 1024 * 1024;
/** Guidance thresholds on the shorter side, in pixels. They describe detail available to a model, nothing more. */
export const REFERENCE_SHORT_SIDE = { low: 512, good: 1024 } as const;
/** Longer than this (long side over short side) and the subject is probably small in the frame. */
export const ELONGATED_RATIO = 2.2;

export type ReferenceVerdict = "good" | "usable" | "low" | "unknown";

export interface ReferenceInspection {
  width: number | null;
  height: number | null;
  megapixels: number | null;
  shortSide: number | null;
  /** "JPEG", "PNG", …: read from the stored bytes at upload, never from the file name. */
  format: string;
  bytes: number | null;
  orientation: "portrait" | "landscape" | "square" | null;
  hasAlpha: boolean;
  /**
   * true: a camera stored this photograph turned, with a rotation flag (EXIF), and it was stored that way. Width and
   * height are given as the picture is DISPLAYED; a tool that ignores the flag sees it sideways.
   */
  turned: boolean;
  /** true: a very long shape (a full phone screenshot, a banner): the subject is probably small in the frame. */
  elongated: boolean;
  verdict: ReferenceVerdict;
  /** One line: the verdict in words. */
  summary: string;
  /** false: an image model cannot be given this file (format or size); it stays a stored reference. */
  usableAsInput: boolean;
  notes: string[];
}

const FORMAT_NAME: Record<string, string> = {
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/webp": "WebP",
  "image/gif": "GIF",
  "image/avif": "AVIF",
};

/**
 * What Prism can honestly say about a reference image from its stored facts: size, format and shape. It does NOT look
 * at the picture: sharpness, lighting, expression and whether the face is visible are for the creator's eye, and the
 * notes say so.
 */
export function inspectReferenceImage(
  asset: Pick<Asset, "width" | "height" | "mime" | "byteSize" | "metadata">,
): ReferenceInspection {
  const meta = asset.metadata as
    { hasAlpha?: unknown; exifOrientation?: unknown; uploadCopy?: unknown } | undefined;
  const flag = typeof meta?.exifOrientation === "number" ? meta.exifOrientation : null;
  const turned = isTurned(flag);
  // a photograph stored on its side is described the way it is shown, not the way its bytes are laid out
  const width = (swapsSides(flag) ? asset.height : asset.width) ?? null;
  const height = (swapsSides(flag) ? asset.width : asset.height) ?? null;
  const mime = (asset.mime ?? "").toLowerCase().replace("image/jpg", "image/jpeg");
  const format = FORMAT_NAME[mime] ?? (mime ? mime.replace("image/", "").toUpperCase() : "Unknown format");
  const bytes = asset.byteSize ?? null;
  const hasAlpha = meta?.hasAlpha === true;
  const shortSide = width && height ? Math.min(width, height) : null;
  const megapixels = width && height ? Math.round((width * height) / 10_000) / 100 : null;
  const orientation =
    width && height
      ? Math.abs(width - height) / Math.max(width, height) < 0.04
        ? "square"
        : width > height
          ? "landscape"
          : "portrait"
      : null;
  const notes: string[] = [];
  let verdict: ReferenceVerdict;
  let summary: string;
  if (!shortSide) {
    verdict = "unknown";
    summary = "Size unknown";
    notes.push("Prism could not read this image's dimensions.");
  } else if (shortSide < REFERENCE_SHORT_SIDE.low) {
    verdict = "low";
    summary = "Small image";
    notes.push(
      `The shorter side is ${shortSide} px. Below about ${REFERENCE_SHORT_SIDE.low} px a face has little detail to preserve; use a larger original if you have one.`,
    );
  } else if (shortSide < REFERENCE_SHORT_SIDE.good) {
    verdict = "usable";
    summary = "Usable";
    notes.push(
      `The shorter side is ${shortSide} px. ${REFERENCE_SHORT_SIDE.good} px or more keeps finer facial detail.`,
    );
  } else {
    verdict = "good";
    summary = "Good size";
  }
  const elongated = !!width && !!height && Math.max(width / height, height / width) > ELONGATED_RATIO;
  if (elongated)
    notes.push("A very long shape: the subject may be small in the frame. A tighter crop helps.");
  const typeOk = (MODEL_INPUT_MIMES as readonly string[]).includes(mime);
  const sizeOk = bytes == null || bytes <= MODEL_INPUT_MAX_BYTES;
  if (!typeOk)
    notes.push(
      `${format} is kept as your original, but the image models here take JPEG, PNG or WebP. Save a copy in one of those to generate from it.`,
    );
  if (!sizeOk) notes.push("Larger than 25 MB: too large to give to an image model.");
  if (hasAlpha) notes.push("Has a transparent background.");
  if (turned)
    notes.push(
      "The camera stored this photo turned, with a rotation flag. It is shown upright here, but a tool that ignores the flag sees it sideways. Add the photo again in the Reference Studio: an upright copy is uploaded.",
    );
  const copy = parseUploadCopy(meta?.uploadCopy);
  if (copy) notes.push(uploadCopySentence(copy));
  notes.push("Sharpness, lighting and expression are not measured: judge them by eye.");
  return {
    width,
    height,
    megapixels,
    shortSide,
    format,
    bytes,
    orientation,
    hasAlpha,
    turned,
    elongated,
    verdict,
    summary,
    usableAsInput: typeOk && sizeOk,
    notes,
  };
}

// ───────────────────────── the price, and exactly what will be sent ─────────────────────────

/** What a "Generate" with the composer's current choices would send and cost (a read; nothing is queued). */
export type ReferenceQuote =
  | {
      ok: true;
      /** true: this request spends money, and the amount must be confirmed */
      paid: boolean;
      /** The server's upper bound for this exact request; null for a model that costs nothing. */
      estimateUsd: number | null;
      basis: string;
      /** nothing sent / references reproduced in a new picture / one image changed */
      operation: "text" | "reference" | "edit";
      /** The images that will be sent, in order. */
      sending: Array<{ assetId: string; label: string }>;
      /** Images Prism assembled that the model has no room for. */
      notSent: number;
      /** The text the provider receives. */
      prompt: string;
      endpoint: string;
      notes: string[];
    }
  | { ok: false; reasons: string[] };

// ───────────────────────── what similar images really cost ─────────────────────────

export interface CostSample {
  provider: string;
  model: string;
  /** null = the model's default quality */
  quality: string | null;
  /** images sent with the request */
  references: number;
  actualUsd: number;
}

export interface TypicalCost {
  /** The median of what matching images were actually billed. */
  usd: number;
  samples: number;
  /** true when the match is on a different number of sent images (the nearest one), so it is a looser guide */
  nearest: boolean;
}

/** The median, to a hundredth of a cent (the precision costs are recorded at). */
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return Math.round(m * 10_000) / 10_000;
};

/**
 * What images like this one have really cost in this project: the median billed amount of finished images made with
 * the same model and quality and the same number of sent images, or failing that the nearest number. A pre-spend
 * estimate is an upper bound (it must never be too low); this is the honest "what it usually comes to" beside it.
 * Null when the project has no comparable image yet: nothing is guessed.
 */
export function typicalCost(
  history: readonly CostSample[],
  want: Pick<CostSample, "provider" | "model" | "quality" | "references">,
): TypicalCost | null {
  const same = history.filter(
    (h) =>
      h.provider === want.provider &&
      h.model === want.model &&
      (h.quality ?? null) === (want.quality ?? null) &&
      Number.isFinite(h.actualUsd) &&
      h.actualUsd >= 0,
  );
  if (same.length === 0) return null;
  const exact = same.filter((h) => h.references === want.references);
  if (exact.length > 0)
    return { usd: median(exact.map((h) => h.actualUsd)), samples: exact.length, nearest: false };
  const gap = Math.min(...same.map((h) => Math.abs(h.references - want.references)));
  const near = same.filter((h) => Math.abs(h.references - want.references) === gap);
  return { usd: median(near.map((h) => h.actualUsd)), samples: near.length, nearest: true };
}

/** Dollars as the Studio shows them: cents for ordinary amounts, more digits only below one cent. */
export function usd(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "unknown";
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3).replace(/0$/, "")}`;
  return `$${amount.toFixed(2)}`;
}

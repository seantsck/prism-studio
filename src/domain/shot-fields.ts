import { DURATION_MODES, MODALITIES, SHOT_STATUSES, type Shot } from "./schemas";

/**
 * Declarative field specs for the Shot Prep inspector. Business rules stay in the domain;
 * components only render these specs and server actions apply them with schema validation.
 */

export type FieldKind =
  | "text"
  | "textarea"
  | "lines" // string[] edited one-per-line
  | "number"
  | "seconds" // stored as ms
  | "bool"
  | "select"
  | "ref:location"
  | "ref:shot"
  | "ref:asset";

export interface FieldSpec {
  path: string;
  label: string;
  kind: FieldKind;
  options?: readonly string[];
  hint?: string;
  wide?: boolean;
}

export type EditableSectionKey =
  | "story"
  | "set"
  | "lighting"
  | "camera"
  | "composition"
  | "blocking"
  | "action"
  | "continuity"
  | "audio"
  | "generation";

export interface SectionSpec {
  key: EditableSectionKey;
  label: string;
  fields: FieldSpec[];
}

export const SHOT_SECTION_SPECS: SectionSpec[] = [
  {
    key: "story",
    label: "Story",
    fields: [
      { path: "title", label: "Title", kind: "text" },
      { path: "storyBeat", label: "Story beat", kind: "textarea", wide: true },
      { path: "dramaticPurpose", label: "Dramatic purpose", kind: "textarea", wide: true },
      { path: "status", label: "Status", kind: "select", options: SHOT_STATUSES },
      {
        path: "durationMode",
        label: "Duration mode",
        kind: "select",
        options: DURATION_MODES,
        hint: "derived_from_performance uses selected takes",
      },
      {
        path: "targetDurationMs",
        label: "Target duration (s)",
        kind: "seconds",
        hint: "Manual duration / fallback",
      },
    ],
  },
  {
    key: "set",
    label: "Location / set",
    fields: [
      { path: "spatial.locationId", label: "Location / set", kind: "ref:location" },
      { path: "spatial.setZone", label: "Set zone", kind: "text" },
      { path: "spatial.backgroundActivity", label: "Background activity", kind: "textarea", wide: true },
    ],
  },
  {
    key: "lighting",
    label: "Lighting",
    fields: [
      { path: "lighting.keyDirection", label: "Key direction", kind: "text" },
      { path: "lighting.fill", label: "Fill", kind: "text" },
      { path: "lighting.practicals", label: "Practicals", kind: "text" },
      { path: "lighting.colorTemperature", label: "Color temperature", kind: "text" },
      { path: "lighting.mood", label: "Mood", kind: "text" },
    ],
  },
  {
    key: "composition",
    label: "Composition",
    fields: [
      { path: "composition.framing", label: "Framing", kind: "text" },
      { path: "composition.shotSize", label: "Shot size", kind: "text" },
      { path: "composition.aspectRatio", label: "Aspect ratio", kind: "text" },
      { path: "composition.notes", label: "Composition notes", kind: "textarea", wide: true },
    ],
  },
  {
    key: "camera",
    label: "Camera",
    fields: [
      { path: "composition.cameraPosition", label: "Camera position", kind: "text" },
      { path: "composition.cameraHeight", label: "Camera height", kind: "text" },
      { path: "composition.cameraAngle", label: "Camera angle", kind: "text" },
      { path: "composition.lens", label: "Lens / focal length", kind: "text" },
      { path: "composition.aperture", label: "Aperture / DoF intent", kind: "text" },
      { path: "composition.movement", label: "Movement", kind: "text" },
      { path: "composition.movementSpeed", label: "Movement speed", kind: "text" },
    ],
  },
  {
    key: "blocking",
    label: "Blocking",
    fields: [
      { path: "spatial.subjectBlocking", label: "Subject blocking", kind: "textarea", wide: true },
      { path: "spatial.facingDirection", label: "Facing direction", kind: "text" },
      { path: "spatial.eyelines", label: "Eyelines", kind: "text" },
      { path: "spatial.screenDirection", label: "Screen direction", kind: "text" },
      { path: "spatial.entryPoint", label: "Entry point", kind: "text" },
      { path: "spatial.exitPoint", label: "Exit point", kind: "text" },
    ],
  },
  {
    key: "action",
    label: "Action timing",
    fields: [
      { path: "action.beginningPose", label: "Beginning pose", kind: "text" },
      { path: "action.endingPose", label: "Ending pose", kind: "text" },
    ],
  },
  {
    key: "continuity",
    label: "Continuity",
    fields: [
      { path: "continuity.previousShotId", label: "Previous shot", kind: "ref:shot" },
      { path: "continuity.weather", label: "Weather", kind: "text" },
      { path: "continuity.timeOfDay", label: "Time of day", kind: "text" },
      {
        path: "continuity.characterCount",
        label: "Named character count",
        kind: "number",
        hint: "0 for empty frames",
      },
      { path: "continuity.vehicleInPlay", label: "Vehicle in shot", kind: "bool" },
      { path: "continuity.vehicleOrientation", label: "Vehicle orientation / door side", kind: "text" },
      { path: "continuity.wardrobe", label: "Wardrobe continuity", kind: "text" },
      { path: "continuity.hair", label: "Hair continuity", kind: "text" },
      { path: "continuity.makeup", label: "Makeup continuity", kind: "text" },
      { path: "continuity.jewelry", label: "Jewelry continuity", kind: "text" },
      { path: "continuity.props", label: "Prop continuity", kind: "text" },
      { path: "continuity.lighting", label: "Lighting continuity", kind: "text" },
      { path: "continuity.geography", label: "Geography notes", kind: "textarea", wide: true },
    ],
  },
  {
    key: "audio",
    label: "Audio",
    fields: [
      { path: "audio.preRollMs", label: "Pre-roll (s)", kind: "seconds" },
      { path: "audio.postRollMs", label: "Post-roll (s)", kind: "seconds" },
      { path: "audio.interLineGapMs", label: "Gap between lines (s)", kind: "seconds" },
      { path: "audio.ambience", label: "Ambience", kind: "text" },
      { path: "audio.foley", label: "Foley / SFX", kind: "text" },
      { path: "audio.musicCue", label: "Music cue", kind: "text" },
      { path: "audio.silenceRequirements", label: "Silence requirements", kind: "text" },
    ],
  },
  {
    key: "generation",
    label: "Generation",
    fields: [
      { path: "generation.modality", label: "Intended modality", kind: "select", options: MODALITIES },
      { path: "generation.provider", label: "Preferred provider", kind: "text" },
      { path: "generation.model", label: "Preferred model", kind: "text" },
      { path: "generation.resolution", label: "Target resolution", kind: "text" },
      { path: "generation.fps", label: "Target FPS", kind: "number" },
      { path: "constraints.hard", label: "Hard constraints", kind: "lines", wide: true },
      { path: "constraints.negative", label: "Negative constraints", kind: "lines", wide: true },
      { path: "constraints.forbiddenObjects", label: "Forbidden objects", kind: "lines" },
      { path: "constraints.forbiddenPeople", label: "Forbidden people", kind: "lines" },
      { path: "constraints.forbiddenActions", label: "Forbidden actions", kind: "lines" },
      { path: "constraints.generatorNotes", label: "Generator-specific notes", kind: "textarea", wide: true },
    ],
  },
];

// ───────────────────────── Path helpers ─────────────────────────

export function getByPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      obj,
    );
}

export function setByPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split(".");
  const root = structuredClone(obj) as Record<string, unknown>;
  let cursor = root;
  for (const k of keys.slice(0, -1)) cursor = cursor[k] as Record<string, unknown>;
  cursor[keys[keys.length - 1]] = value;
  return root as T;
}

/** Coerce one FormData entry into the stored value for a field. */
export function coerceField(spec: FieldSpec, form: FormData): unknown {
  const raw = form.get(spec.path);
  const str = typeof raw === "string" ? raw : "";
  switch (spec.kind) {
    case "bool":
      return form.get(spec.path) === "on";
    case "number": {
      if (str.trim() === "") return spec.path === "continuity.characterCount" ? null : 0;
      return Number(str);
    }
    case "seconds": {
      if (str.trim() === "") return spec.path === "targetDurationMs" ? null : 0;
      return Math.round(Number(str) * 1000);
    }
    case "lines":
      return str
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    case "ref:location":
    case "ref:shot":
    case "ref:asset":
      return str === "" ? null : str;
    case "text":
      return spec.path === "generation.provider" || spec.path === "generation.model"
        ? str.trim() || null
        : str.trim();
    default:
      return str.trim();
  }
}

export function applySection(shot: Shot, spec: SectionSpec, form: FormData): Shot {
  let next = shot;
  for (const field of spec.fields) next = setByPath(next, field.path, coerceField(field, form));
  return { ...next, updatedAt: new Date().toISOString() };
}

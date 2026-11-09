import { createHash } from "node:crypto";
import { z } from "zod";
import { buildShotContext } from "@/domain/context";
import type { ProjectData, Shot } from "@/domain/schemas";
import { CAMERA_ANGLES, label, sceneSnapshot, SHOT_SIZES } from "./shot-list";

/**
 * Phase 5B-S5: approved Shot → Storyboard Direction Proposal. Pure.
 *
 * S4 decided WHAT Shots exist; S5 proposes HOW one plays: framing, lens intent, camera, blocking, lighting, depth,
 * emotional intent, continuity and a storyboard description. The model never changes a Shot: deterministic code writes
 * the reviewed direction into the Shot's EXISTING fields (composition, spatial, lighting), which the I6 Production Frame
 * package already reads. No parallel S5-only Shot fields.
 */
export const SHOT_DIRECTION_SCHEMA_VERSION = "prism.shot-direction.v1" as const;

export const CAMERA_HEIGHTS = ["ground", "low", "waist", "chest", "eye_level", "high", "overhead"] as const;
export const MOVEMENTS = [
  "static",
  "handheld",
  "dolly",
  "pan",
  "tilt",
  "push_in",
  "pull_out",
  "track",
  "crane",
] as const;
export const SIDES = ["left", "centre", "right"] as const;
export const DEPTHS = ["foreground", "midground", "background"] as const;
export type Side = (typeof SIDES)[number];

const t = (max = 600) => z.string().max(max);
export const blockingEntrySchema = z
  .object({
    characterKey: z.string(),
    position: t(),
    screenSide: z.enum(SIDES),
    depth: z.enum(DEPTHS),
    facing: t(),
    eyeline: t(),
    relation: t(),
    entryExit: t(),
  })
  .strict();
export const shotDirectionSchema = z
  .object({
    summary: t(1000),
    framing: z
      .object({ shotSize: z.enum(SHOT_SIZES), composition: t(), subjectPlacement: t(), headroom: t() })
      .strict(),
    lens: z.object({ intent: t(200), focalRange: t(60), rationale: t() }).strict(),
    camera: z
      .object({
        height: z.enum(CAMERA_HEIGHTS),
        angle: z.enum(CAMERA_ANGLES),
        position: t(),
        perspective: t(),
        movement: z.enum(MOVEMENTS),
        movementRationale: t(),
      })
      .strict(),
    blocking: z.array(blockingEntrySchema).max(12),
    lighting: z
      .object({
        key: t(),
        practicals: t(),
        contrast: t(),
        mood: t(200),
        timeOfDay: t(200),
        motivatedSources: t(),
      })
      .strict(),
    depth: z.object({ foreground: t(), midground: t(), background: t(), cues: t() }).strict(),
    emotionalIntent: t(),
    continuity: z
      .object({
        screenDirection: t(),
        eyelines: t(),
        constraints: z.array(t(300)).max(10),
        breaksPattern: z.boolean(),
        breakJustification: t().nullable(),
      })
      .strict(),
    locationView: z
      .object({ usesSelectedView: z.boolean(), conflict: t().nullable(), suggestedNewView: t().nullable() })
      .strict(),
    storyboardDescription: t(1200),
    confidence: z.enum(["high", "medium", "low"]),
    ambiguity: t().nullable(),
  })
  .strict();
export type ShotDirection = z.infer<typeof shotDirectionSchema>;
export type BlockingEntry = z.infer<typeof blockingEntrySchema>;

const O = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const S = { type: "string" };
const NS = { type: ["string", "null"] };
const E = (v: readonly string[]) => ({ type: "string", enum: [...v] });
/** Strict JSON Schema for Structured Outputs (lockstep with `shotDirectionSchema`; a test walks both). */
export const SHOT_DIRECTION_JSON_SCHEMA = O({
  summary: S,
  framing: O({ shotSize: E(SHOT_SIZES), composition: S, subjectPlacement: S, headroom: S }),
  lens: O({ intent: S, focalRange: S, rationale: S }),
  camera: O({
    height: E(CAMERA_HEIGHTS),
    angle: E(CAMERA_ANGLES),
    position: S,
    perspective: S,
    movement: E(MOVEMENTS),
    movementRationale: S,
  }),
  blocking: {
    type: "array",
    maxItems: 12,
    items: O({
      characterKey: S,
      position: S,
      screenSide: E(SIDES),
      depth: E(DEPTHS),
      facing: S,
      eyeline: S,
      relation: S,
      entryExit: S,
    }),
  },
  lighting: O({ key: S, practicals: S, contrast: S, mood: S, timeOfDay: S, motivatedSources: S }),
  depth: O({ foreground: S, midground: S, background: S, cues: S }),
  emotionalIntent: S,
  continuity: O({
    screenDirection: S,
    eyelines: S,
    constraints: { type: "array", items: S, maxItems: 10 },
    breaksPattern: { type: "boolean" },
    breakJustification: NS,
  }),
  locationView: O({ usesSelectedView: { type: "boolean" }, conflict: NS, suggestedNewView: NS }),
  storyboardDescription: S,
  confidence: E(["high", "medium", "low"]),
  ambiguity: NS,
});

// ───────────────────────── the frozen Shot snapshot ─────────────────────────

export interface AdjacentShot {
  code: string;
  title: string;
  relation: "previous" | "next";
  shotSize: string;
  cameraAngle: string;
  framing: string;
  characters: string[];
  /** Screen side per Character name, from the Shot's blocking marks (what is already established on screen). */
  sides: Record<string, Side>;
  screenDirection: string;
  eyelines: string;
}

export interface DirectionContext {
  aspectRatio: string;
  shot: {
    id: string;
    code: string;
    title: string;
    storyBeat: string;
    purpose: string;
    planNotes: string;
    shotSize: string;
    cameraAngle: string;
    framing: string;
    lens: string;
    dialogue: Array<{ speaker: string; text: string }>;
  };
  scene: { heading: string; intExt: string; timeOfDay: string; summary: string };
  characters: Array<{
    key: string;
    id: string;
    name: string;
    look: string | null;
    wardrobe: string;
    continuityLock: string | null;
    notes: string;
  }>;
  location: { name: string; description: string; lighting: string; geography: string } | null;
  /** The Shot's selected Location View: a HARD spatial constraint when present. */
  locationView: {
    name: string;
    kind: string;
    viewpoint: string;
    orientation: string;
    cameraPosition: string;
    cameraHeight: string;
    cameraAngle: string;
    shotSize: string;
    framing: string;
    lens: string;
  } | null;
  /** Other Views of the Location (for a recommendation only; nothing is created or selected). */
  otherViews: Array<{ name: string; kind: string; viewpoint: string }>;
  adjacent: AdjacentShot[];
  /** The screen side each Character already holds in this Scene's coverage (adjacent Shots first, then S4's plan). */
  established: Record<string, Side>;
}

export interface ShotSnapshot {
  sceneFingerprint: string;
  shotFingerprint: string;
  context: DirectionContext;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sideOf = (x: number): Side => (x < 0.34 ? "left" : x > 0.66 ? "right" : "centre");
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Everything about a Shot a direction depends on: planning + direction fields, Characters, Looks, Location, View. */
export function shotDirectionFingerprint(data: ProjectData, shot: Shot): string {
  const ctx = buildShotContext(data, shot.id);
  return sha({
    title: shot.title,
    storyBeat: shot.storyBeat,
    dramaticPurpose: shot.dramaticPurpose,
    composition: shot.composition,
    spatial: shot.spatial,
    lighting: shot.lighting,
    characters: shot.characters.map((c) => [c.characterId, c.lookId]),
    dialogue: shot.audio.dialogueLineIds,
    looks: ctx.characters.map((c) => [c.character?.id ?? null, c.look ?? null, c.continuityLock?.id ?? null]),
    view: ctx.selectedLocationView?.id ?? null,
  });
}

const sidesOf = (data: ProjectData, s: Shot): Record<string, Side> => {
  const out: Record<string, Side> = {};
  for (const m of s.spatial.marks) {
    const c = data.characters.find((x) => x.name.trim().toLowerCase() === m.label.trim().toLowerCase());
    if (c) out[c.name] = sideOf(m.x);
  }
  return out;
};

/** The frozen input of a direction request (textual only: no image pixels). */
export function shotSnapshot(data: ProjectData, shotId: string): ShotSnapshot | null {
  const shot = data.shots.find((s) => s.id === shotId);
  if (!shot) return null;
  const scene = data.scenes.find((s) => s.id === shot.sceneId);
  const episode = data.episodes.find((e) => e.id === shot.episodeId);
  if (!scene || !episode) return null;
  const snap = sceneSnapshot(data, episode, scene);
  if (!snap) return null;
  const ctx = buildShotContext(data, shot.id);
  const characters = ctx.characters
    .filter((c): c is typeof c & { character: NonNullable<typeof c.character> } => Boolean(c.character))
    .map((c, i) => ({
      key: `c${i + 1}`,
      id: c.character.id,
      name: c.character.name,
      look: c.look?.name ?? null,
      wardrobe: clip([c.look?.wardrobe, c.look?.hair, c.look?.jewelry].filter(Boolean).join("; "), 300),
      continuityLock: c.continuityLock?.name ?? null,
      notes: clip(
        [c.character.personality, c.character.continuityRules.join("; ")].filter(Boolean).join(" — "),
        300,
      ),
    }));
  const loc = ctx.location;
  const view = ctx.selectedLocationView;
  const siblings = data.shots.filter((s) => s.sceneId === scene.id).sort((a, b) => a.order - b.order);
  const at = siblings.findIndex((s) => s.id === shot.id);
  const adjacent: AdjacentShot[] = [
    ...siblings.slice(Math.max(0, at - 2), at).map((s) => ({ s, relation: "previous" as const })),
    ...siblings.slice(at + 1, at + 3).map((s) => ({ s, relation: "next" as const })),
  ].map(({ s, relation }) => ({
    code: s.shotCode,
    title: clip(s.title, 80),
    relation,
    shotSize: s.composition.shotSize,
    cameraAngle: s.composition.cameraAngle,
    framing: clip(s.composition.framing, 200),
    characters: s.characters.map((c) => data.characters.find((x) => x.id === c.characterId)?.name ?? "?"),
    sides: sidesOf(data, s),
    screenDirection: clip(s.spatial.screenDirection, 200),
    eyelines: clip(s.spatial.eyelines, 200),
  }));
  // what the audience has already seen, nearest first; then S4's "Keep X screen-left and Y screen-right" note
  const established: Record<string, Side> = {};
  for (const a of [...adjacent].sort((x, y) => Number(x.relation === "next") - Number(y.relation === "next")))
    for (const [n, side] of Object.entries(a.sides)) established[n] ??= side;
  for (const [n, side] of Object.entries(sidesOf(data, shot))) established[n] ??= side;
  const note = siblings.map((s) => s.composition.notes).join("\n") + shot.composition.notes;
  const m = note.match(/Keep (.+?) screen-left and (.+?) screen-right/);
  if (m) {
    established[m[1]!] ??= "left";
    established[m[2]!] ??= "right";
  }
  const context: DirectionContext = {
    aspectRatio: shot.composition.aspectRatio || data.bible.aspectRatio,
    shot: {
      id: shot.id,
      code: shot.shotCode,
      title: shot.title,
      storyBeat: clip(shot.storyBeat, 600),
      purpose: clip(shot.dramaticPurpose, 600),
      planNotes: clip(shot.composition.notes, 600),
      shotSize: shot.composition.shotSize,
      cameraAngle: shot.composition.cameraAngle,
      framing: clip(shot.composition.framing, 300),
      lens: shot.composition.lens,
      dialogue: ctx.lines.map((l) => ({
        speaker: l.line.speakerLabel,
        text: clip(l.line.originalText, 300),
      })),
    },
    scene: {
      heading: scene.slugline,
      intExt: scene.intExt,
      timeOfDay: scene.timeOfDay,
      summary: clip(scene.summary, 400),
    },
    characters,
    location: loc
      ? {
          name: loc.name,
          description: clip(loc.description, 400),
          lighting: clip(loc.lighting, 300),
          geography: clip(loc.geography, 300),
        }
      : null,
    locationView: view
      ? {
          name: view.name,
          kind: view.kind,
          viewpoint: view.viewSpec.viewpointDescription,
          orientation: view.viewSpec.orientation,
          cameraPosition: view.viewSpec.cameraPosition,
          cameraHeight: view.viewSpec.cameraHeight,
          cameraAngle: view.viewSpec.cameraAngle,
          shotSize: view.viewSpec.shotSize,
          framing: view.viewSpec.framing,
          lens: view.viewSpec.lens,
        }
      : null,
    otherViews: ctx.locationViews
      .filter((v) => v.id !== view?.id)
      .slice(0, 6)
      .map((v) => ({ name: v.name, kind: v.kind, viewpoint: clip(v.viewSpec.viewpointDescription, 200) })),
    adjacent,
    established,
  };
  return {
    sceneFingerprint: snap.sceneFingerprint,
    shotFingerprint: shotDirectionFingerprint(data, shot),
    context,
  };
}

// ───────────────────────── validation ─────────────────────────

/**
 * The ONE gate every director answer passes before it is stored: JSON → strict schema → the Shot's Characters exactly
 * (every visible Character blocked once, nobody added) → the selected Location View is used or the conflict is named →
 * screen sides match what the coverage already established, unless the answer explicitly breaks the pattern and says
 * why.
 */
export function validateShotDirection(
  raw: unknown,
  ctx: DirectionContext,
): { ok: true; direction: ShotDirection } | { ok: false; errors: string[] } {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ["The answer is not valid JSON."] };
    }
  }
  const parsed = shotDirectionSchema.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "answer"}: ${i.message}`),
    };
  const d = parsed.data;
  const errors: string[] = [];
  const keys = ctx.characters.map((c) => c.key).sort();
  const blocked = d.blocking.map((b) => b.characterKey).sort();
  if (JSON.stringify(keys) !== JSON.stringify(blocked))
    errors.push(`Block exactly the Shot's Characters (${keys.join(", ") || "none"}), each once.`);
  if (!d.storyboardDescription.trim()) errors.push("storyboardDescription must not be empty.");
  if (ctx.locationView) {
    if (!d.locationView.usesSelectedView && !d.locationView.conflict?.trim())
      errors.push(`Use the selected Location View "${ctx.locationView.name}", or name the conflict.`);
  } else if (d.locationView.usesSelectedView) errors.push("There is no selected Location View to use.");
  if (d.continuity.breaksPattern && !d.continuity.breakJustification?.trim())
    errors.push("Breaking the established screen direction needs a justification.");
  if (!d.continuity.breaksPattern)
    for (const b of d.blocking) {
      const name = ctx.characters.find((c) => c.key === b.characterKey)?.name ?? "";
      const est = ctx.established[name];
      if (est && est !== "centre" && b.screenSide !== "centre" && b.screenSide !== est)
        errors.push(`${name} is established screen-${est}; keep that side or justify breaking the pattern.`);
    }
  return errors.length ? { ok: false, errors } : { ok: true, direction: d };
}

/** Output budget for a direction request: modest, never the model maximum. */
export const directionOutputTokens = (ctx: DirectionContext, modelMax: number) =>
  Math.min(modelMax, 2200 + ctx.characters.length * 300);

// ───────────────────────── review + apply ─────────────────────────

export const DIRECTION_SECTIONS = [
  "camera",
  "blocking",
  "lighting",
  "composition",
  "continuity",
  "storyboard",
] as const;
export type DirectionSection = (typeof DIRECTION_SECTIONS)[number];

export const SECTION_LABEL: Record<DirectionSection, string> = {
  camera: "Camera",
  blocking: "Blocking",
  lighting: "Lighting",
  composition: "Composition",
  continuity: "Continuity",
  storyboard: "Storyboard Description",
};

/** The text fields a creator may edit, by dotted path (enum fields are validated on use). */
export const EDITABLE_PATHS = [
  "framing.composition",
  "framing.subjectPlacement",
  "framing.headroom",
  "framing.shotSize",
  "lens.intent",
  "lens.focalRange",
  "camera.position",
  "camera.perspective",
  "camera.height",
  "camera.angle",
  "camera.movement",
  "lighting.key",
  "lighting.practicals",
  "lighting.contrast",
  "lighting.mood",
  "depth.foreground",
  "depth.midground",
  "depth.background",
  "emotionalIntent",
  "continuity.screenDirection",
  "continuity.eyelines",
  "storyboardDescription",
] as const;
export type EditablePath = (typeof EDITABLE_PATHS)[number];

export interface DirectionReview {
  version: 1;
  /** Each section is applied only when accepted (all accepted by default). */
  sections: Record<DirectionSection, boolean>;
  edits: Partial<Record<EditablePath, string>>;
  /** Per-Character blocking edits (position / facing / eyeline). */
  blockingEdits: Record<string, Partial<Record<"position" | "facing" | "eyeline", string>>>;
  rejected: boolean;
  savedAlternate: boolean;
}

export const defaultDirectionReview = (): DirectionReview => ({
  version: 1,
  sections: Object.fromEntries(DIRECTION_SECTIONS.map((s) => [s, true])) as Record<DirectionSection, boolean>,
  edits: {},
  blockingEdits: {},
  rejected: false,
  savedAlternate: false,
});

const ENUMS: Partial<Record<EditablePath, readonly string[]>> = {
  "framing.shotSize": SHOT_SIZES,
  "camera.height": CAMERA_HEIGHTS,
  "camera.angle": CAMERA_ANGLES,
  "camera.movement": MOVEMENTS,
};

export function getPath(d: ShotDirection, path: EditablePath): string {
  const [a, b] = path.split(".") as [keyof ShotDirection, string?];
  const v = b ? (d[a] as Record<string, unknown>)[b] : d[a];
  return String(v ?? "");
}

/** The direction as the creator will apply it: the proposal plus edits (an invalid enum edit is ignored). */
export function effectiveDirection(d: ShotDirection, r: DirectionReview): ShotDirection {
  const out = structuredClone(d);
  for (const [path, value] of Object.entries(r.edits) as Array<[EditablePath, string]>) {
    if (ENUMS[path] && !ENUMS[path]!.includes(value)) continue;
    const [a, b] = path.split(".");
    if (b) (out[a as keyof ShotDirection] as Record<string, unknown>)[b] = value;
    else (out as Record<string, unknown>)[a!] = value;
  }
  out.blocking = out.blocking.map((x) => ({ ...x, ...(r.blockingEdits[x.characterKey] ?? {}) }));
  return out;
}

const X: Record<Side, number> = { left: 0.2, centre: 0.5, right: 0.8 };
const Y: Record<(typeof DEPTHS)[number], number> = { foreground: 0.8, midground: 0.55, background: 0.3 };
const sentence = (s: string) => s.trim().replace(/\s*\.?$/, ".");

/**
 * APPLY: the reviewed direction into the Shot's EXISTING fields. Only accepted sections are written. The Shot keeps its
 * id, code, order, Characters, Location, story fields, dialogue, generations, frames and approvals; S4's coverage and
 * "Source: lines …" traceability lines in the camera notes are preserved.
 */
export function applyShotDirection(args: {
  shot: Shot;
  direction: ShotDirection;
  review: DirectionReview;
  context: DirectionContext;
  proposalVersion: number;
  now: string;
}): Shot {
  const { shot, review: r, context: ctx } = args;
  const d = effectiveDirection(args.direction, r);
  const on = r.sections;
  const name = (k: string) => ctx.characters.find((c) => c.key === k)?.name ?? k;
  const composition = { ...shot.composition };
  const spatial = { ...shot.spatial };
  const lighting = { ...shot.lighting };
  if (on.camera) {
    composition.shotSize = label(d.framing.shotSize);
    composition.lens = [d.lens.focalRange, d.lens.intent].filter((x) => x.trim()).join(" — ");
    composition.cameraHeight = label(d.camera.height);
    composition.cameraAngle = label(d.camera.angle);
    composition.cameraPosition = [d.camera.position, d.camera.perspective].filter((x) => x.trim()).join("; ");
    composition.movement = d.camera.movement === "static" ? "Static" : label(d.camera.movement);
  }
  if (on.composition)
    composition.framing = [d.framing.composition, d.framing.subjectPlacement, d.framing.headroom]
      .filter((x) => x.trim())
      .map(sentence)
      .join(" ");
  if (on.blocking) {
    spatial.subjectBlocking = d.blocking
      .map((b) =>
        b.position.toLowerCase().startsWith(name(b.characterKey).toLowerCase())
          ? sentence(b.position)
          : `${name(b.characterKey)}: ${sentence(b.position)}`,
      )
      .join(" ");
    spatial.marks = d.blocking.map((b) => ({
      label: name(b.characterKey),
      x: X[b.screenSide],
      y: Y[b.depth],
      notes: [b.depth, b.facing && `facing ${b.facing}`].filter(Boolean).join(", "),
    }));
    spatial.facingDirection = d.blocking.map((b) => `${name(b.characterKey)} ${b.facing}`).join("; ");
    const moves = d.blocking.filter((b) => b.entryExit.trim() && !/^none\b/i.test(b.entryExit.trim()));
    spatial.entryPoint = moves.map((b) => `${name(b.characterKey)}: ${b.entryExit}`).join("; ");
    spatial.backgroundActivity = d.depth.background;
  }
  if (on.continuity) {
    spatial.screenDirection = d.continuity.screenDirection;
    spatial.eyelines = [d.continuity.eyelines, ...(on.blocking ? [] : [])].filter(Boolean).join(" ");
  }
  if (on.lighting) {
    lighting.keyDirection = d.lighting.key;
    lighting.practicals = d.lighting.practicals;
    lighting.fill = d.lighting.contrast;
    lighting.mood = d.lighting.mood;
  }
  // camera notes: the storyboard description and intent, keeping S4's coverage + source lines
  const kept = shot.composition.notes
    .split("\n")
    .filter((l) => /^Source: /.test(l) || /^[A-Z][\w-]*( [\w-]+)? · .+ · .+$/.test(l));
  composition.notes = [
    on.storyboard ? `Storyboard: ${d.storyboardDescription}` : "",
    on.composition
      ? `Depth: ${[d.depth.foreground, d.depth.midground, d.depth.background].filter(Boolean).join(" / ")}`
      : "",
    on.composition && d.emotionalIntent ? `Emotional intent: ${d.emotionalIntent}` : "",
    on.continuity && d.continuity.constraints.length
      ? `Continuity: ${d.continuity.constraints.join("; ")}`
      : "",
    on.lighting && d.lighting.motivatedSources ? `Motivated light: ${d.lighting.motivatedSources}` : "",
    ...kept,
    `Direction: Storyboard Direction v${args.proposalVersion}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { ...shot, composition, spatial, lighting, updatedAt: args.now };
}

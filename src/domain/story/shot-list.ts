import { z } from "zod";
import { parseScreenplay, syncScript } from "@/domain/script";
import type { Episode, ProjectData, Scene } from "@/domain/schemas";
import { sceneRanges } from "./revisions";
import { sourceFingerprint } from "./source";
import { canonical } from "./writing";

/**
 * Phase 5B-S4: Scene → Shot List Proposal. Pure.
 *
 * Prism proposes a camera plan for ONE accepted screenplay Scene; the creator reviews it; deterministic code applies
 * it. The model never writes Shot rows. Everything the model may reference (Characters, the Location, dialogue and
 * action blocks) is given to it as short KEYS in a frozen context, so every reference in the answer is checkable.
 */
export const SHOT_LIST_SCHEMA_VERSION = "prism.shot-list.v1" as const;

export const COVERAGE = [
  "establishing",
  "master",
  "two_shot",
  "single",
  "over_the_shoulder",
  "reaction",
  "insert",
  "cutaway",
  "pov",
  "other",
] as const;
export const SHOT_SIZES = [
  "extreme_wide",
  "wide",
  "full",
  "medium_wide",
  "medium",
  "medium_close",
  "close_up",
  "extreme_close_up",
] as const;
export const CAMERA_ANGLES = [
  "eye_level",
  "high",
  "low",
  "overhead",
  "dutch",
  "over_the_shoulder",
  "pov",
] as const;
export const CONFIDENCE = ["high", "medium", "low"] as const;

export const COVERAGE_LABEL: Record<(typeof COVERAGE)[number], string> = {
  establishing: "Establishing",
  master: "Master",
  two_shot: "Two-shot",
  single: "Single",
  over_the_shoulder: "Over-the-shoulder",
  reaction: "Reaction",
  insert: "Insert",
  cutaway: "Cutaway",
  pov: "POV",
  other: "Other",
};
export const label = (s: string) => s.replace(/_/g, " ");

export const SHOT_LIMITS = {
  shots: 30,
  title: 80,
  text: 600,
  sources: 12,
  keys: 20,
} as const;

const t = (max: number) => z.string().max(max);
const range = z.object({ startLine: z.number().int().min(1), endLine: z.number().int().min(1) }).strict();
export const plannedShotSchema = z
  .object({
    key: z.string().regex(/^sh\d{1,3}$/),
    order: z.number().int().min(1),
    title: t(SHOT_LIMITS.title),
    coverage: z.enum(COVERAGE),
    purpose: t(SHOT_LIMITS.text),
    beat: t(SHOT_LIMITS.text),
    characterKeys: z.array(z.string()).max(SHOT_LIMITS.keys),
    locationKey: z.string().nullable(),
    dialogueKeys: z.array(z.string()).max(SHOT_LIMITS.keys),
    actionKeys: z.array(z.string()).max(SHOT_LIMITS.keys),
    shotSize: z.enum(SHOT_SIZES),
    cameraAngle: z.enum(CAMERA_ANGLES),
    framing: t(SHOT_LIMITS.text),
    emotionalIntention: t(SHOT_LIMITS.text),
    continuityNotes: t(SHOT_LIMITS.text),
    sources: z.array(range).min(1).max(SHOT_LIMITS.sources),
    confidence: z.enum(CONFIDENCE),
    ambiguity: t(SHOT_LIMITS.text).nullable(),
  })
  .strict();
export const shotPlanSchema = z
  .object({ summary: t(1200), shots: z.array(plannedShotSchema).min(1).max(SHOT_LIMITS.shots) })
  .strict();
export type ShotPlan = z.infer<typeof shotPlanSchema>;
export type PlannedShot = z.infer<typeof plannedShotSchema>;

const O = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const S = { type: "string" };
const NS = { type: ["string", "null"] };
const E = (v: readonly string[]) => ({ type: "string", enum: [...v] });
const A = (items: unknown, maxItems: number) => ({ type: "array", items, maxItems });
/** Strict JSON Schema for Structured Outputs (lockstep with `shotPlanSchema`; a test walks both). */
export const SHOT_PLAN_JSON_SCHEMA = O({
  summary: S,
  shots: A(
    O({
      key: S,
      order: { type: "integer", minimum: 1 },
      title: S,
      coverage: E(COVERAGE),
      purpose: S,
      beat: S,
      characterKeys: A(S, SHOT_LIMITS.keys),
      locationKey: NS,
      dialogueKeys: A(S, SHOT_LIMITS.keys),
      actionKeys: A(S, SHOT_LIMITS.keys),
      shotSize: E(SHOT_SIZES),
      cameraAngle: E(CAMERA_ANGLES),
      framing: S,
      emotionalIntention: S,
      continuityNotes: S,
      sources: A(
        O({ startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }),
        SHOT_LIMITS.sources,
      ),
      confidence: E(CONFIDENCE),
      ambiguity: NS,
    }),
    SHOT_LIMITS.shots,
  ),
});

// ───────────────────────── the frozen Scene snapshot (canon only) ─────────────────────────

export interface ShotPlanningContext {
  project: string;
  aspectRatio: string;
  scene: {
    id: string;
    number: string;
    heading: string;
    intExt: string;
    timeOfDay: string;
    summary: string;
    purpose: string;
    entering: string;
    leaving: string;
    startLine: number;
    endLine: number;
  };
  characters: Array<{ key: string; id: string; name: string; role: string; description: string }>;
  locations: Array<{ key: string; id: string; name: string; description: string }>;
  dialogue: Array<{
    key: string;
    id: string | null;
    speaker: string;
    characterKey: string | null;
    parenthetical: string;
    text: string;
    startLine: number;
    endLine: number;
  }>;
  actions: Array<{ key: string; id: string | null; text: string; startLine: number; endLine: number }>;
  /** The Scene's Shots at planning time (so the model knows what already exists; it never edits them). */
  existingShots: Array<{ code: string; title: string }>;
}

export interface SceneSnapshot {
  /** The canonical Episode screenplay and its fingerprint. */
  episodeFingerprint: string;
  /** The Scene's own text (headings included) and its fingerprint: a plan is STALE when this changes. */
  sceneText: string;
  sceneFingerprint: string;
  context: ShotPlanningContext;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The frozen input of a planning request: ONLY the Episode's current accepted screenplay (`episodes.script_text`) —
 * never a writing proposal — the Scene's text, and keyed references to its Characters, Location, dialogue and action.
 */
export function sceneSnapshot(data: ProjectData, episode: Episode, scene: Scene): SceneSnapshot | null {
  const text = canonical(episode.scriptText);
  const r = sceneRanges(text, data, episode.id).get(scene.id);
  if (!r) return null;
  const sceneText = text.slice(r.start, r.end);
  const epScenes = data.scenes.filter((s) => s.episodeId === episode.id);
  const epLines = data.dialogueLines.filter((l) => l.episodeId === episode.id);
  const nameOf = (l: (typeof epLines)[number]) =>
    l.characterId
      ? (data.characters.find((c) => c.id === l.characterId)?.name.toUpperCase() ?? l.speakerLabel)
      : l.speakerLabel;
  const sync = syncScript(
    parseScreenplay(text),
    epScenes,
    epLines,
    nameOf,
    data.actionBlocks.filter((a) => a.episodeId === episode.id),
  );
  const synced = sync.scenes.find((s) => s.existingId === scene.id);

  // Characters: the Scene's own, plus anyone who speaks or is named in its action
  const upper = sceneText.toUpperCase();
  const present = data.characters.filter(
    (c) =>
      scene.characterIds.includes(c.id) ||
      synced?.lines.some((l) => l.parsed.speaker.toUpperCase() === c.name.toUpperCase()) ||
      new RegExp(`\\b${c.name.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(upper),
  );
  const characters = present.map((c, i) => ({
    key: `c${i + 1}`,
    id: c.id,
    name: c.name,
    role: clip(c.role, 120),
    description: clip([c.description, c.physicalDescription].filter((x) => x.trim()).join(" "), 300),
  }));
  const keyOfSpeaker = (speaker: string) =>
    characters.find((c) => c.name.toUpperCase() === speaker.replace(/\s*\(.*\)$/, "").toUpperCase())?.key ??
    null;
  const loc = data.locations.find((l) => l.id === scene.locationId);
  const locations = loc
    ? [{ key: "l1", id: loc.id, name: loc.name, description: clip(loc.description, 300) }]
    : [];

  return {
    episodeFingerprint: sourceFingerprint(text),
    sceneText,
    sceneFingerprint: sourceFingerprint(sceneText),
    context: {
      project: clip(data.project.title, 200),
      aspectRatio: data.bible.aspectRatio,
      scene: {
        id: scene.id,
        number: scene.sceneNumber,
        heading: scene.slugline,
        intExt: scene.intExt,
        timeOfDay: scene.timeOfDay,
        summary: clip(scene.summary, 600),
        purpose: clip(scene.dramaticPurpose, 400),
        entering: clip(scene.emotionEntering, 200),
        leaving: clip(scene.emotionLeaving, 200),
        startLine: r.startLine,
        endLine: r.endLine,
      },
      characters,
      locations,
      dialogue: (synced?.lines ?? []).map((l, i) => ({
        key: `d${i + 1}`,
        id: l.existingId,
        speaker: l.parsed.speaker,
        characterKey: keyOfSpeaker(l.parsed.speaker),
        parenthetical: l.parsed.parenthetical,
        text: clip(l.parsed.text, 600),
        startLine: l.parsed.line,
        endLine: l.parsed.endLine,
      })),
      actions: (synced?.actions ?? []).map((a, i) => ({
        key: `a${i + 1}`,
        id: a.existingId,
        text: clip(a.parsed.text, 600),
        startLine: a.parsed.line,
        endLine: a.parsed.endLine,
      })),
      existingShots: data.shots
        .filter((s) => s.sceneId === scene.id)
        .sort((a, b) => a.order - b.order)
        .map((s) => ({ code: s.shotCode, title: clip(s.title, 80) })),
    },
  };
}

// ───────────────────────── validation ─────────────────────────

export type ShotPlanScope = { kind: "full" } | { kind: "shot"; key: string; note: string };

/**
 * The ONE gate every planner answer passes before it is stored: JSON → strict schema → references (every key the
 * answer uses exists in the frozen context; shot keys unique; order 1..n) → traceability (every source range lies
 * inside the Scene) → for a one-Shot regeneration, every OTHER Shot is returned unchanged.
 */
export function validateShotPlan(
  raw: unknown,
  ctx: ShotPlanningContext,
  scope: ShotPlanScope = { kind: "full" },
  base: ShotPlan | null = null,
): { ok: true; plan: ShotPlan } | { ok: false; errors: string[] } {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ["The answer is not valid JSON."] };
    }
  }
  const parsed = shotPlanSchema.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "answer"}: ${i.message}`),
    };
  const plan = parsed.data;
  const errors: string[] = [];
  const chars = new Set(ctx.characters.map((c) => c.key));
  const locs = new Set(ctx.locations.map((l) => l.key));
  const lines = new Set(ctx.dialogue.map((d) => d.key));
  const acts = new Set(ctx.actions.map((a) => a.key));
  const keys = new Set<string>();
  plan.shots.forEach((s, i) => {
    const at = `shots.${i} (${s.key})`;
    if (keys.has(s.key)) errors.push(`${at}: duplicate key.`);
    keys.add(s.key);
    if (!s.title.trim()) errors.push(`${at}: title must not be empty.`);
    for (const k of s.characterKeys) if (!chars.has(k)) errors.push(`${at}: unknown Character key ${k}.`);
    if (s.locationKey !== null && !locs.has(s.locationKey))
      errors.push(`${at}: unknown Location key ${s.locationKey}.`);
    for (const k of s.dialogueKeys) if (!lines.has(k)) errors.push(`${at}: unknown dialogue key ${k}.`);
    for (const k of s.actionKeys) if (!acts.has(k)) errors.push(`${at}: unknown action key ${k}.`);
    for (const r of s.sources)
      if (r.startLine > r.endLine || r.startLine < ctx.scene.startLine || r.endLine > ctx.scene.endLine)
        errors.push(
          `${at}: source lines ${r.startLine}–${r.endLine} are outside the Scene (${ctx.scene.startLine}–${ctx.scene.endLine}).`,
        );
  });
  const orders = plan.shots.map((s) => s.order).sort((a, b) => a - b);
  if (orders.some((o, i) => o !== i + 1)) errors.push("Shot order must be 1, 2, 3… without gaps.");
  if (scope.kind === "shot" && base) {
    const before = new Map(base.shots.map((s) => [s.key, s]));
    if (plan.shots.length !== base.shots.length || plan.shots.some((s) => !before.has(s.key)))
      errors.push("A one-Shot regeneration returns the same Shots (same keys).");
    for (const s of plan.shots)
      if (s.key !== scope.key && JSON.stringify(s) !== JSON.stringify(before.get(s.key)))
        errors.push(`Only ${scope.key} may change; ${s.key} must be returned exactly as it was.`);
    if (!before.has(scope.key)) errors.push(`The Shot to regenerate (${scope.key}) is not in the plan.`);
  }
  return errors.length ? { ok: false, errors: errors.slice(0, 12) } : { ok: true, plan };
}

/** Output budget (tokens) for a planning request: proportional to the Scene, never the model maximum. */
export function planningOutputTokens(ctx: ShotPlanningContext, modelMax: number): number {
  const expected = Math.min(SHOT_LIMITS.shots, 2 + ctx.dialogue.length + Math.ceil(ctx.actions.length / 2));
  return Math.min(modelMax, 1200 + expected * 450);
}

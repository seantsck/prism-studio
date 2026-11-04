import { z } from "zod";
import { fingerprint } from "../hash";
import type { PrevisDocument } from "./types";

/**
 * Shot Lighting (Phase 4B): the Shot's spatial lighting implementation, an overlay on the Location's set. It never
 * enters `location_scene_documents` or `sceneFingerprint`, and it never writes the authored `shot.lighting` text.
 *
 * Every number is what the renderer actually consumes (Three.js engine values): no lumens, no Kelvin, no area-light
 * softness, no shadows. Pure domain: no Three.js here.
 */

export const SHOT_LIGHTING_SCHEMA = "prism.shot-lighting.v1" as const;
export const RENDER_LIGHTING_SCHEMA = "prism.render-lighting.v1" as const;
export const SHOT_LIGHTING_REFERENCE_SCHEMA_VERSION = 1 as const;

export const MAX_SHOT_LIGHTS = 16;
/** Well above the engine's own base rig (3.0 + 2.0); point and spot lights fall off with distance, so need more. */
export const MAX_LIGHT_INTENSITY = 1000;
/** `PointLight.distance` / `SpotLight.distance`: 0 means unbounded in Three.js. */
export const MAX_LIGHT_RANGE = 1000;
/** `SpotLight.angle` is the half-angle from the spot's axis; Three.js documents PI/2 as its upper bound. */
export const MIN_SPOT_CONE_DEG = 1;
export const MAX_SPOT_CONE_DEG = 90;
export const MAX_LIGHT_COORDINATE = 10_000;
export const MAX_LIGHT_LABEL = 80;

export const LIGHT_TYPES = ["directional", "point", "spot", "ambient"] as const;
export const LIGHT_ROLES = ["key", "fill", "rim", "practical", "background", "other"] as const;
export const BASE_MODES = ["engine_default", "replace"] as const;

const coordinate = z.number().finite().min(-MAX_LIGHT_COORDINATE).max(MAX_LIGHT_COORDINATE);
const point3 = z.strictObject({ x: coordinate, y: coordinate, z: coordinate });
const range = z.number().finite().min(0).max(MAX_LIGHT_RANGE);

const common = {
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  role: z.enum(LIGHT_ROLES),
  label: z.string().max(MAX_LIGHT_LABEL),
  enabled: z.boolean(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .transform((c) => c.toLowerCase()),
  intensity: z.number().finite().min(0).max(MAX_LIGHT_INTENSITY),
  // v1 simulates no authored shadows: `true` is refused, and an explicit `false` carries no information
  castShadow: z.literal(false).optional(),
};

// strict: a field that does not apply to a light type is refused, so it can never reach a fingerprint
const shotLightSchema = z
  .discriminatedUnion("type", [
    z.strictObject({ type: z.literal("ambient"), ...common }),
    z.strictObject({ type: z.literal("point"), ...common, position: point3, range }),
    z.strictObject({ type: z.literal("directional"), ...common, position: point3, target: point3 }),
    z.strictObject({
      type: z.literal("spot"),
      ...common,
      position: point3,
      target: point3,
      range,
      coneAngleDeg: z.number().finite().min(MIN_SPOT_CONE_DEG).max(MAX_SPOT_CONE_DEG),
      penumbra: z.number().finite().min(0).max(1),
    }),
  ])
  .refine(
    (l) =>
      !("target" in l) ||
      l.position.x !== l.target.x ||
      l.position.y !== l.target.y ||
      l.position.z !== l.target.z,
    { message: "A light cannot aim at its own position." },
  );
export type ShotLight = z.infer<typeof shotLightSchema>;
export type ShotLightType = (typeof LIGHT_TYPES)[number];
export type ShotLightRole = (typeof LIGHT_ROLES)[number];
export type BaseMode = (typeof BASE_MODES)[number];

const rigShape = {
  schema: z.literal(SHOT_LIGHTING_SCHEMA),
  base: z.strictObject({ mode: z.enum(BASE_MODES) }),
  lights: z
    .array(shotLightSchema)
    .max(MAX_SHOT_LIGHTS)
    .refine((ls) => new Set(ls.map((l) => l.id)).size === ls.length, {
      message: "Light ids must be unique.",
    }),
};

/** What the browser may send. `authoredIntent` is not in it: the server reads that from the Shot itself. */
export const shotLightingDraftSchema = z.strictObject(rigShape);
export type ShotLightingDraft = z.infer<typeof shotLightingDraftSchema>;

export const authoredLightingIntentSchema = z.strictObject({
  /** the Shot's structured `lighting` block, plus its `continuity.lighting` note */
  lighting: z.strictObject({
    keyDirection: z.string(),
    fill: z.string(),
    practicals: z.string(),
    colorTemperature: z.string(),
    mood: z.string(),
    referenceAssetId: z.string().nullable(),
    continuity: z.string(),
  }),
  timeOfDay: z.string(),
  weather: z.string(),
});
export type AuthoredLightingIntent = z.infer<typeof authoredLightingIntentSchema>;

export const shotLightingRigSchema = z.strictObject({
  ...rigShape,
  authoredIntent: authoredLightingIntentSchema,
});
export type ShotLightingRig = z.infer<typeof shotLightingRigSchema>;

/** Removes the `castShadow: false` that means nothing, so one state has one stored shape. */
function normalizeLights(lights: readonly ShotLight[]): ShotLight[] {
  return lights.map((l) => {
    const rest = { ...l };
    delete rest.castShadow;
    return rest;
  });
}

/** Parses browser input; throws on anything v1 refuses (`castShadow: true`, a stray field, a spoofed intent). */
export function parseShotLightingDraft(input: unknown): ShotLightingDraft {
  const d = shotLightingDraftSchema.parse(input);
  return { ...d, lights: normalizeLights(d.lights) };
}

/** Parses a complete stored rig (repositories and readers). */
export function parseShotLightingRig(input: unknown): ShotLightingRig {
  const r = shotLightingRigSchema.parse(input);
  return { ...r, lights: normalizeLights(r.lights) };
}

/** The authored intent a rig is frozen against, read server-side from the Shot itself. */
export function authoredLightingIntent(shot: {
  lighting: Omit<AuthoredLightingIntent["lighting"], "continuity">;
  continuity: { lighting: string; timeOfDay: string; weather: string };
}): AuthoredLightingIntent {
  const l = shot.lighting;
  return {
    lighting: {
      keyDirection: l.keyDirection,
      fill: l.fill,
      practicals: l.practicals,
      colorTemperature: l.colorTemperature,
      mood: l.mood,
      referenceAssetId: l.referenceAssetId,
      continuity: shot.continuity.lighting,
    },
    timeOfDay: shot.continuity.timeOfDay,
    weather: shot.continuity.weather,
  };
}

const r5 = (v: number) => Math.round(v * 1e5) / 1e5 + 0; // + 0 normalises -0
const rv = (v: { x: number; y: number; z: number }) => ({ x: r5(v.x), y: r5(v.y), z: r5(v.z) });

/** The pixel-affecting state of one light. `role`, `label` and the rig's `authoredIntent` are deliberately absent. */
function canonicalLight(l: ShotLight) {
  const shared = { id: l.id, type: l.type, enabled: l.enabled, color: l.color, intensity: r5(l.intensity) };
  switch (l.type) {
    case "ambient":
      return shared;
    case "point":
      return { ...shared, position: rv(l.position), range: r5(l.range) };
    case "directional":
      return { ...shared, position: rv(l.position), target: rv(l.target) };
    case "spot":
      return {
        ...shared,
        position: rv(l.position),
        target: rv(l.target),
        range: r5(l.range),
        coneAngleDeg: r5(l.coneAngleDeg),
        penumbra: r5(l.penumbra),
      };
  }
}

/** Identity of what a rig can do to pixels. A disabled light stays in it; relabelling never changes it. */
export function lightingFingerprint(rig: Pick<ShotLightingRig, "schema" | "base" | "lights">): string {
  return fingerprint({
    schema: rig.schema,
    base: rig.base.mode,
    lights: [...rig.lights].sort((a, b) => (a.id < b.id ? -1 : 1)).map(canonicalLight),
  });
}

export function emptyShotLightingDraft(): ShotLightingDraft {
  return { schema: SHOT_LIGHTING_SCHEMA, base: { mode: "engine_default" }, lights: [] };
}

/** What a new light of each type starts as; every number is a plain starting point the user then edits. */
export function newShotLight(type: ShotLightType, id: string): ShotLight {
  const shared = { id, role: "key" as const, label: "", enabled: true, color: "#ffffff" };
  const position = { x: 2, y: 3, z: 2 };
  const target = { x: 0, y: 1, z: 0 };
  switch (type) {
    case "ambient":
      return { type, ...shared, role: "fill", intensity: 0.5 };
    case "point":
      return { type, ...shared, intensity: 20, position, range: 0 };
    case "directional":
      return { type, ...shared, intensity: 2, position, target };
    case "spot":
      return { type, ...shared, intensity: 40, position, target, range: 0, coneAngleDeg: 30, penumbra: 0.2 };
  }
}

// ───────────────────────── render provenance ─────────────────────────

/** The engine lighting a render ran on, beyond the rig: what the scene fingerprint does not capture. */
const baseEnvironmentSchema = z.strictObject({
  upstreamCommit: z.string().min(1),
  /** the saved scene's skybox id, which decides which built-in lights exist; null when the scene names none */
  skybox: z.string().nullable(),
});
export type BaseEnvironment = z.infer<typeof baseEnvironmentSchema>;

export function baseEnvironmentOf(doc: Pick<PrevisDocument, "scene" | "upstreamCommit">): BaseEnvironment {
  const skybox = (doc.scene as { skybox?: unknown }).skybox;
  return { upstreamCommit: doc.upstreamCommit, skybox: typeof skybox === "string" ? skybox : null };
}

export const renderLightingSchema = z.strictObject({
  schema: z.literal(RENDER_LIGHTING_SCHEMA),
  rigId: z.string().min(1),
  rigRevision: z.number().int().min(1),
  rigFingerprint: z.string().length(64),
  rig: shotLightingRigSchema,
  baseEnvironment: baseEnvironmentSchema,
});
/** Frozen with a render: exactly the lighting it used, re-derived by the server from saved truth. */
export type RenderLighting = z.infer<typeof renderLightingSchema>;

export function buildRenderLighting(args: {
  rig: { id: string; revision: number; lightingFingerprint: string; rig: ShotLightingRig };
  scene: Pick<PrevisDocument, "scene" | "upstreamCommit">;
}): RenderLighting {
  return renderLightingSchema.parse({
    schema: RENDER_LIGHTING_SCHEMA,
    rigId: args.rig.id,
    rigRevision: args.rig.revision,
    rigFingerprint: args.rig.lightingFingerprint,
    rig: args.rig.rig,
    baseEnvironment: baseEnvironmentOf(args.scene),
  });
}

/** Lighting a render recorded, versus the Shot's lighting now. */
export interface RenderedLightingState {
  lightingFingerprint: string | null;
  lighting: Pick<RenderLighting, "baseEnvironment"> | null;
}
export interface CurrentLightingState {
  /** null = the Shot has no rig now */
  lightingFingerprint: string | null;
  baseEnvironment: BaseEnvironment | null;
}

/**
 * True when the render no longer shows the Shot's lighting: the rig differs, was added or was removed, or (where the
 * render recorded it) the base environment under the same rig changed. A render with no rig, on a Shot with no rig, is
 * not stale: history is not condemned merely because rigs now exist.
 */
export function isRenderLightingStale(rendered: RenderedLightingState, now: CurrentLightingState): boolean {
  if (rendered.lightingFingerprint !== now.lightingFingerprint) return true;
  if (!rendered.lighting || !now.baseEnvironment) return false;
  const a = rendered.lighting.baseEnvironment;
  const b = now.baseEnvironment;
  return a.skybox !== b.skybox || a.upstreamCommit !== b.upstreamCommit;
}

export type MasterFrameStaleReason = "scene" | "blocking" | "lighting";

/**
 * What changed since a Master Frame was captured, using only provenance the frame really holds. There is no camera
 * reason: frames record a bookmark pointer, not a camera fingerprint (Phase 4C adds that).
 */
export function masterFrameStaleReasons(i: {
  frame: {
    sceneFingerprint: string;
    blockingFingerprint: string | null;
  } & RenderedLightingState;
  currentSceneFingerprint: string | null;
  currentBlockingFingerprint: string | null;
  currentLighting: CurrentLightingState;
}): MasterFrameStaleReason[] {
  const reasons: MasterFrameStaleReason[] = [];
  if (i.frame.sceneFingerprint !== i.currentSceneFingerprint) reasons.push("scene");
  if (i.frame.blockingFingerprint !== i.currentBlockingFingerprint) reasons.push("blocking");
  if (isRenderLightingStale(i.frame, i.currentLighting)) reasons.push("lighting");
  return reasons;
}

export const MASTER_FRAME_STALE_LABEL: Record<MasterFrameStaleReason, string> = {
  scene: "STALE SCENE — the set changed after this frame.",
  blocking: "STALE BLOCKING — the character blocking changed after this frame.",
  lighting: "STALE LIGHTING — the Shot's lighting changed after this frame.",
};

// ───────────────────────── review (never blocking, never rewriting) ─────────────────────────

export type LightingReviewCode = "authored_intent_changed" | "set_changed";

/** Conditions for a person to look at. They delete nothing, rewrite nothing and block nothing. */
export function lightingReview(args: {
  rig: Pick<ShotLightingRig, "authoredIntent">;
  rigSceneFingerprint: string;
  currentIntent: AuthoredLightingIntent;
  currentSceneFingerprint: string | null;
}): LightingReviewCode[] {
  const out: LightingReviewCode[] = [];
  // canonical comparison: a stored jsonb object does not keep its key order
  if (fingerprint(args.rig.authoredIntent) !== fingerprint(args.currentIntent))
    out.push("authored_intent_changed");
  if (args.currentSceneFingerprint !== null && args.rigSceneFingerprint !== args.currentSceneFingerprint)
    out.push("set_changed");
  return out;
}

export const LIGHTING_REVIEW_LABEL: Record<LightingReviewCode, string> = {
  authored_intent_changed: "REVIEW: authored lighting changed since this rig was saved.",
  set_changed: "REVIEW: the set changed since this rig was authored.",
};

// ───────────────────────── GenerationPackage ─────────────────────────

/** The Shot's lighting frozen into a package by value. Omitted from `SpatialReference` when the Shot has no rig. */
export interface ShotLightingReference {
  schemaVersion: typeof SHOT_LIGHTING_REFERENCE_SCHEMA_VERSION;
  rigId: string;
  rigRevision: number;
  lightingFingerprint: string;
  /** the set state the rig was authored against (differs from live when the set has moved on) */
  sceneRevision: number;
  sceneFingerprint: string;
  rig: ShotLightingRig;
  /**
   * The lighting the Master Frame behind the CURRENTLY SELECTED Production Frame rendered. Null when that frame did
   * not come from a Master Frame, or came from one that recorded no rig. A mismatch with `lightingFingerprint` is
   * reported here, not corrected.
   */
  productionFrameLightingFingerprint: string | null;
}

export function buildShotLightingReference(args: {
  rig: {
    id: string;
    revision: number;
    lightingFingerprint: string;
    sceneRevision: number;
    sceneFingerprint: string;
    rig: ShotLightingRig;
  };
  productionFrameLightingFingerprint: string | null;
}): ShotLightingReference {
  return {
    schemaVersion: SHOT_LIGHTING_REFERENCE_SCHEMA_VERSION,
    rigId: args.rig.id,
    rigRevision: args.rig.revision,
    lightingFingerprint: args.rig.lightingFingerprint,
    sceneRevision: args.rig.sceneRevision,
    sceneFingerprint: args.rig.sceneFingerprint,
    rig: structuredClone(args.rig.rig),
    productionFrameLightingFingerprint: args.productionFrameLightingFingerprint,
  };
}

/**
 * Resolves `productionFrameLightingFingerprint` through the exact chain: selected frame, its source, that frame's
 * `source_master_frame_id`, that Master Frame's own record. Never the newest, latest or adopted Master Frame.
 */
export function selectedProductionFrameLighting(args: {
  selected: { source: string; sourceMasterFrameId: string | null } | null;
  masterFrameLighting: (masterFrameId: string) => string | null | undefined;
}): string | null {
  const s = args.selected;
  if (!s || s.source !== "previs_master" || !s.sourceMasterFrameId) return null;
  return args.masterFrameLighting(s.sourceMasterFrameId) ?? null;
}

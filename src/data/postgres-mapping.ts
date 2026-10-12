import type { ZodType } from "zod";
import { emptyShot } from "@/domain/shot-defaults";
import {
  assetSchema,
  characterSchema,
  continuityCheckSchema,
  dialogueLineSchema,
  episodeSchema,
  generationAttemptSchema,
  identityRefSchema,
  locationSchema,
  lookSchema,
  performanceDirectionSchema,
  performanceTakeSchema,
  propSchema,
  sceneSchema,
  shotSchema,
  storyboardFrameSchema,
  voiceProfileSchema,
  type CollectionName,
  type Collections,
  type Shot,
} from "@/domain/schemas";

/**
 * Pure mapping between domain entities (camelCase, nested) and SQL rows (snake_case, normalised).
 * No database access here, so it is unit-testable. See docs/domain-model.md for the mapping table.
 */

export type Row = Record<string, unknown>;

const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toCamel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export interface CollectionSpec {
  table: string;
  schema: ZodType;
  /** Domain keys stored as JSONB (arrays/objects must be stringified for node-postgres). */
  json: string[];
  /** Columns that Postgres returns as strings (numeric) and the domain wants as numbers. */
  numeric: string[];
  /** Whether the table has a project_id column that the repository must fill. */
  projectScoped: boolean;
  /** Domain keys that do not exist as columns (or are stored in join tables). */
  virtual: string[];
}

const spec = (
  table: string,
  schema: ZodType,
  o: Partial<Omit<CollectionSpec, "table" | "schema">> = {},
): CollectionSpec => ({
  table,
  schema,
  json: [],
  numeric: [],
  projectScoped: true,
  virtual: [],
  ...o,
});

export const COLLECTIONS: Record<CollectionName, CollectionSpec> = {
  assets: spec("assets", assetSchema, { json: ["metadata"] }),
  characters: spec("characters", characterSchema),
  identityRefs: spec("character_identity_refs", identityRefSchema, { json: ["metadata"] }),
  looks: spec("character_looks", lookSchema),
  voiceProfiles: spec("voice_profiles", voiceProfileSchema),
  locations: spec("locations", locationSchema, { json: ["zones", "entrances"], virtual: ["set3d"] }),
  props: spec("props", propSchema),
  episodes: spec("episodes", episodeSchema),
  scenes: spec("scenes", sceneSchema, { virtual: ["scriptRange", "characterIds", "propIds"] }),
  shots: spec("shots", shotSchema, { virtual: ["*"] }),
  dialogueLines: spec("dialogue_lines", dialogueLineSchema),
  directions: spec("performance_directions", performanceDirectionSchema),
  takes: spec("performance_takes", performanceTakeSchema, { json: ["waveform"] }),
  frames: spec("storyboard_frames", storyboardFrameSchema),
  attempts: spec("generation_attempts", generationAttemptSchema, {
    json: ["packageSnapshot", "modelSettings"],
    numeric: ["costUsd"],
  }),
  continuityChecks: spec("continuity_checks", continuityCheckSchema, {
    json: ["scores", "issues"],
    numeric: ["overallScore"],
  }),
};

// ───────────────────────── Generic flat mapping ─────────────────────────

/** Domain entity → column map (snake_case). Virtual keys are skipped; JSON keys are stringified. */
export function flatToRow(item: object, s: CollectionSpec): Row {
  const row: Row = {};
  for (const [key, value] of Object.entries(item)) {
    if (s.virtual.includes(key)) continue;
    row[toSnake(key)] =
      s.json.includes(key) && value !== null && value !== undefined ? JSON.stringify(value) : value;
  }
  return row;
}

/** Column map → domain-shaped object (dates → ISO strings, numerics → numbers). Not yet schema-validated. */
export function flatFromRow(row: Row, s: CollectionSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [col, value] of Object.entries(row)) {
    const key = toCamel(col);
    if (key === "projectId" && !s.projectScoped) continue;
    out[key] =
      value instanceof Date
        ? value.toISOString()
        : s.numeric.includes(key) && value != null
          ? Number(value)
          : value;
  }
  return out;
}

// ───────────────────────── Locations (3D set columns) ─────────────────────────

export function locationToRow(location: Collections["locations"][number]): Row {
  const row = flatToRow(location, COLLECTIONS.locations);
  row.set3d_model_asset_id = location.set3d?.modelAssetId ?? null;
  row.set3d = location.set3d
    ? JSON.stringify({
        cameraRigs: location.set3d.cameraRigs,
        blockingMarkers: location.set3d.blockingMarkers,
        lightRigs: location.set3d.lightRigs,
      })
    : null;
  return row;
}

export function locationFromRow(row: Row): Record<string, unknown> {
  const out = flatFromRow(row, COLLECTIONS.locations);
  const { set3dModelAssetId, set3d, ...rest } = out;
  const extra = (set3d ?? null) as {
    cameraRigs?: unknown[];
    blockingMarkers?: unknown[];
    lightRigs?: unknown[];
  } | null;
  return {
    ...rest,
    set3d:
      set3dModelAssetId || extra
        ? {
            modelAssetId: set3dModelAssetId ?? null,
            cameraRigs: extra?.cameraRigs ?? [],
            blockingMarkers: extra?.blockingMarkers ?? [],
            lightRigs: extra?.lightRigs ?? [],
          }
        : null,
  };
}

// ───────────────────────── Scenes (+ scene_characters / scene_props) ─────────────────────────

export interface SceneRows {
  scene: Row;
  characters: Row[];
  props: Row[];
}

export function sceneToRows(scene: Collections["scenes"][number]): SceneRows {
  const row = flatToRow(scene, COLLECTIONS.scenes);
  row.script_start_line = scene.scriptRange?.startLine ?? null;
  row.script_end_line = scene.scriptRange?.endLine ?? null;
  return {
    scene: row,
    characters: [...new Set(scene.characterIds)].map((character_id) => ({
      scene_id: scene.id,
      character_id,
    })),
    props: [...new Set(scene.propIds)].map((prop_id) => ({ scene_id: scene.id, prop_id })),
  };
}

export function sceneFromRow(row: Row, characterIds: string[], propIds: string[]): Record<string, unknown> {
  const out = flatFromRow(row, COLLECTIONS.scenes);
  const { scriptStartLine, scriptEndLine, ...rest } = out;
  return {
    ...rest,
    scriptRange:
      scriptStartLine != null && scriptEndLine != null
        ? { startLine: Number(scriptStartLine), endLine: Number(scriptEndLine) }
        : null,
    characterIds,
    propIds,
  };
}

// ───────────────────────── Shots ─────────────────────────

export interface ShotRows {
  shot: Row;
  characters: Row[];
  props: Row[];
  lines: Row[];
  assets: Row[];
}

const json = (v: unknown) => JSON.stringify(v);

export function shotToRows(shot: Shot): ShotRows {
  const { locationId, ...spatial } = shot.spatial;
  const { previousShotId, ...continuity } = shot.continuity;
  const { dialogueLineIds, ...audio } = shot.audio;
  const { referenceAssetId, ...lighting } = shot.lighting;
  const {
    referenceAssetIds,
    startFrameAssetId,
    endFrameAssetId,
    referenceVideoAssetId,
    referenceAudioAssetId,
    ...generation
  } = shot.generation;

  const assets: Row[] = [];
  const addAsset = (asset_id: string | null, role: string) => {
    if (asset_id && !assets.some((a) => a.asset_id === asset_id && a.role === role)) {
      assets.push({ shot_id: shot.id, asset_id, role });
    }
  };
  referenceAssetIds.forEach((id) => addAsset(id, "reference"));
  addAsset(startFrameAssetId, "start_frame");
  addAsset(endFrameAssetId, "end_frame");
  addAsset(referenceVideoAssetId, "reference_video");
  addAsset(referenceAudioAssetId, "reference_audio");
  addAsset(referenceAssetId, "lighting_reference");

  return {
    shot: {
      id: shot.id,
      project_id: shot.projectId,
      episode_id: shot.episodeId,
      scene_id: shot.sceneId,
      shot_code: shot.shotCode,
      title: shot.title,
      story_beat: shot.storyBeat,
      dramatic_purpose: shot.dramaticPurpose,
      order: shot.order,
      status: shot.status,
      target_duration_ms: shot.targetDurationMs,
      duration_mode: shot.durationMode,
      location_id: locationId,
      previous_shot_id: previousShotId,
      composition: json(shot.composition),
      spatial: json(spatial),
      continuity: json(continuity),
      action: json(shot.action),
      audio: json(audio),
      lighting: json(lighting),
      constraints: json(shot.constraints),
      generation: json(generation),
      approval_storyboard: shot.approval.storyboardApproved,
      approval_performance: shot.approval.performanceApproved,
      approval_continuity: shot.approval.continuityApproved,
      created_at: shot.createdAt,
      updated_at: shot.updatedAt,
    },
    characters: shot.characters.map((c, position) => ({
      shot_id: shot.id,
      character_id: c.characterId,
      look_id: c.lookId,
      performance_notes: c.performanceNotes,
      expression: c.expression,
      posture: c.posture,
      gestures: c.gestures,
      physical_interactions: c.physicalInteractions,
      position,
    })),
    props: [...new Set(shot.propIds)].map((prop_id) => ({ shot_id: shot.id, prop_id })),
    lines: dialogueLineIds.map((dialogue_line_id, position) => ({
      shot_id: shot.id,
      dialogue_line_id,
      position,
    })),
    assets,
  };
}

export interface ShotJoinRows {
  characters: Row[];
  props: Row[];
  lines: Row[];
  assets: Row[];
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

export function shotFromRows(row: Row, joins: ShotJoinRows): Record<string, unknown> {
  const base = emptyShot({
    id: String(row.id),
    projectId: String(row.project_id),
    episodeId: String(row.episode_id),
    sceneId: String(row.scene_id),
    shotCode: String(row.shot_code),
    title: String(row.title),
    order: Number(row.order),
  });
  const roleAssets = (role: string) =>
    joins.assets.filter((a) => a.role === role).map((a) => String(a.asset_id));
  const first = (role: string) => roleAssets(role)[0] ?? null;

  return {
    ...base,
    storyBeat: String(row.story_beat ?? ""),
    dramaticPurpose: String(row.dramatic_purpose ?? ""),
    status: row.status,
    targetDurationMs: row.target_duration_ms == null ? null : Number(row.target_duration_ms),
    durationMode: row.duration_mode,
    composition: { ...base.composition, ...asObject(row.composition) },
    spatial: {
      ...base.spatial,
      ...asObject(row.spatial),
      locationId: (row.location_id as string | null) ?? null,
    },
    characters: joins.characters
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map((c) => ({
        characterId: String(c.character_id),
        lookId: (c.look_id as string | null) ?? null,
        performanceNotes: String(c.performance_notes ?? ""),
        expression: String(c.expression ?? ""),
        posture: String(c.posture ?? ""),
        gestures: String(c.gestures ?? ""),
        physicalInteractions: String(c.physical_interactions ?? ""),
      })),
    propIds: joins.props.map((p) => String(p.prop_id)),
    continuity: {
      ...base.continuity,
      ...asObject(row.continuity),
      previousShotId: (row.previous_shot_id as string | null) ?? null,
    },
    action: { ...base.action, ...asObject(row.action) },
    audio: {
      ...base.audio,
      ...asObject(row.audio),
      dialogueLineIds: joins.lines
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map((l) => String(l.dialogue_line_id)),
    },
    lighting: { ...base.lighting, ...asObject(row.lighting), referenceAssetId: first("lighting_reference") },
    constraints: { ...base.constraints, ...asObject(row.constraints) },
    generation: {
      ...base.generation,
      ...asObject(row.generation),
      referenceAssetIds: roleAssets("reference"),
      startFrameAssetId: first("start_frame"),
      endFrameAssetId: first("end_frame"),
      referenceVideoAssetId: first("reference_video"),
      referenceAudioAssetId: first("reference_audio"),
    },
    approval: {
      storyboardApproved: Boolean(row.approval_storyboard),
      performanceApproved: Boolean(row.approval_performance),
      continuityApproved: Boolean(row.approval_continuity),
    },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

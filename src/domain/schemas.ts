import { z } from "zod";
import {
  GENERATION_MODALITIES,
  REJECTION_CATEGORIES,
  REVIEW_STATUSES,
  promptPlanSchema,
} from "./generation/schemas";

/**
 * Prism Studio domain schemas. Provider-agnostic and storage-agnostic.
 * TS shapes are camelCase; the SQL migrations use snake_case and the future
 * Supabase adapter owns the mapping.
 */

const id = z.string().min(1);
const nullableId = id.nullable();
const text = z.string();
const iso = z.string();

// ───────────────────────── Enumerations ─────────────────────────

export const PROJECT_TYPES = ["series", "film", "short"] as const;
export const PRODUCTION_STATUSES = [
  "development",
  "pre_production",
  "production",
  "post_production",
  "complete",
] as const;
export const ASSET_TYPES = ["image", "video", "audio", "document", "3d", "waveform", "reference"] as const;
export const ASSET_SOURCES = [
  "upload",
  "generated",
  "sketch",
  "3d_preview",
  "recording",
  "import",
  "seed",
  "extracted",
  "3d_render",
  "storyboard",
  "provider_output",
  "derived",
] as const;
/** What an asset is FOR (type says what it is). Drives the library filters and storage conventions. */
export const ASSET_PURPOSES = [
  "identity_ref",
  "look_ref",
  "location_ref",
  "prop_ref",
  "storyboard",
  "performance_audio",
  "reference_audio",
  "generation_input",
  "generation_output",
  "video_reference",
  "document",
  "waveform",
  "model_3d",
  "other",
] as const;
export const STORAGE_PROVIDERS = ["none", "local", "supabase"] as const;
export const DURATION_SOURCES = ["server_metadata", "browser_hint", "manual", "seed"] as const;
export const IDENTITY_SLOTS = ["front", "three_quarter", "profile", "full_body", "additional"] as const;
export const TAKE_SOURCES = ["human_recording", "generated_voice", "temp_voice"] as const;
export const DURATION_MODES = ["manual", "derived_from_performance"] as const;
export const SHOT_STATUSES = [
  "draft",
  "prepping",
  "ready",
  "generating",
  "review",
  "approved",
  "locked",
] as const;
export const FRAME_SOURCES = ["upload", "generated", "3d_preview", "sketch"] as const;
export const MODALITIES = ["video", "image", "image_to_video", "audio"] as const;
/** EXECUTION outcome of an attempt (mirrors its job). Review is a separate field: see REVIEW_STATUSES. */
export const ATTEMPT_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export const INT_EXT = ["INT", "EXT", "INT/EXT"] as const;
export const PACES = ["very_slow", "slow", "natural", "fast", "very_fast"] as const;
export const VOLUMES = ["whisper", "quiet", "normal", "loud", "shout"] as const;

// ───────────────────────── Project & Bible ─────────────────────────

export const projectSchema = z.object({
  id,
  userId: id,
  title: text.min(1),
  slug: text.min(1),
  projectType: z.enum(PROJECT_TYPES),
  description: text,
  genre: text,
  tone: text,
  defaultLanguage: text,
  productionStatus: z.enum(PRODUCTION_STATUSES),
  /**
   * Explicit owner classification, never inferred from the slug: production (default), benchmark (a model or
   * provider benchmark / synthetic fixture) or test (infrastructure / UI test project). Reviews and winners of
   * non-production projects persist and work normally, but their records are excluded from production
   * model-performance aggregates and routing recommendations (see domain/generation/performance).
   */
  purpose: z.enum(["production", "benchmark", "test"]).default("production"),
  createdAt: iso,
  updatedAt: iso,
});
export type Project = z.infer<typeof projectSchema>;

export const bibleSchema = z.object({
  projectId: id,
  premise: text,
  genre: text,
  tone: text,
  visualStyle: text,
  cinematographyRules: z.array(text),
  colorLanguage: text,
  aspectRatio: text,
  defaultFrameRate: z.number().positive(),
  dialogueLanguageStrategy: text,
  subtitleStrategy: text,
  audioPhilosophy: text,
  canonFacts: z.array(text),
  continuityRules: z.array(text),
  /** Forbidden changes / generator guardrails. Injected verbatim into every generation package. */
  guardrails: z.array(text),
  /**
   * Optional explicit production format. `aspectRatio` remains the canonical statement of the frame; pixel
   * dimensions are only recorded when someone decides them (never invented). All null by default.
   */
  deliveryWidth: z.number().int().positive().nullable().default(null),
  deliveryHeight: z.number().int().positive().nullable().default(null),
  targetCodec: text.nullable().default(null),
  audioSampleRate: z.number().int().positive().nullable().default(null),
  updatedAt: iso,
});
export type ProjectBible = z.infer<typeof bibleSchema>;

// ───────────────────────── Assets ─────────────────────────

export const assetSchema = z.object({
  // identity
  id,
  projectId: id,
  /** Auth user that created the asset (null for seeded/system assets). */
  createdBy: nullableId,
  type: z.enum(ASSET_TYPES),
  purpose: z.enum(ASSET_PURPOSES),
  source: z.enum(ASSET_SOURCES),
  // storage
  name: text,
  originalFilename: text,
  storageProvider: z.enum(STORAGE_PROVIDERS),
  bucket: text.nullable(),
  /** Key inside the bucket/provider. Null = placeholder (not yet uploaded). */
  objectPath: text.nullable(),
  // technical metadata (server-read wherever possible)
  mime: text.nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  checksum: text.nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  frameRate: z.number().positive().nullable(),
  sampleRate: z.number().int().positive().nullable(),
  channels: z.number().int().positive().nullable(),
  // production
  tags: z.array(text),
  notes: text,
  /** Free-form technical metadata (codec, loudness…). */
  metadata: z.record(z.string(), z.unknown()),
  createdAt: iso,
  updatedAt: iso,
});
export type Asset = z.infer<typeof assetSchema>;

// ───────────────────────── Characters ─────────────────────────

export const characterSchema = z.object({
  id,
  projectId: id,
  name: text.min(1),
  role: text,
  description: text,
  personality: text,
  behaviorNotes: text,
  physicalDescription: text,
  continuityRules: z.array(text),
  signatureBehavior: text,
  relationshipNotes: text,
  createdAt: iso,
  updatedAt: iso,
});
export type Character = z.infer<typeof characterSchema>;

export const identityRefSchema = z.object({
  id,
  characterId: id,
  slot: z.enum(IDENTITY_SLOTS),
  assetId: nullableId,
  label: text,
  metadata: z.record(z.string(), z.unknown()),
  locked: z.boolean(),
});
export type IdentityRef = z.infer<typeof identityRefSchema>;

export const lookSchema = z.object({
  id,
  projectId: id,
  characterId: id,
  episodeId: nullableId,
  name: text.min(1),
  wardrobe: text,
  shoes: text,
  jewelry: text,
  hair: text,
  makeup: text,
  grooming: text,
  bodyNotes: text,
  accessories: text,
  referenceAssetIds: z.array(id),
  locked: z.boolean(),
});
export type CharacterLook = z.infer<typeof lookSchema>;

export const voiceProfileSchema = z.object({
  id,
  projectId: id,
  characterId: id,
  name: text.min(1),
  language: text,
  locale: text,
  provider: text,
  providerVoiceId: text.nullable(),
  description: text,
  pitchNotes: text,
  timbreNotes: text,
  accent: text,
  speakingStyle: text,
  emotionalRange: text,
  pronunciationRules: z.array(text),
  sampleAssetIds: z.array(id),
  locked: z.boolean(),
});
export type VoiceProfile = z.infer<typeof voiceProfileSchema>;

// ───────────────────────── Locations / Props ─────────────────────────

export const locationSchema = z.object({
  id,
  projectId: id,
  name: text.min(1),
  description: text,
  geography: text,
  zones: z.array(z.object({ id, name: text, description: text })),
  entrances: z.array(z.object({ id, name: text, description: text })),
  lighting: text,
  recurringProps: z.array(text),
  referenceAssetIds: z.array(id),
  locked: z.boolean(),
  /** Extension points for the future 3D Set; the location model itself needs no rewrite. */
  set3d: z
    .object({
      modelAssetId: nullableId,
      cameraRigs: z.array(z.record(z.string(), z.unknown())),
      blockingMarkers: z.array(z.record(z.string(), z.unknown())),
      lightRigs: z.array(z.record(z.string(), z.unknown())),
    })
    .nullable(),
});
export type Location = z.infer<typeof locationSchema>;

export const propSchema = z.object({
  id,
  projectId: id,
  name: text.min(1),
  description: text,
  referenceAssetIds: z.array(id),
  locked: z.boolean(),
});
export type Prop = z.infer<typeof propSchema>;

// ───────────────────────── Episodes / Scenes ─────────────────────────

export const episodeSchema = z.object({
  id,
  projectId: id,
  number: z.number().int().positive(),
  slug: text.min(1),
  title: text.min(1),
  synopsis: text,
  scriptText: text,
  order: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
});
export type Episode = z.infer<typeof episodeSchema>;

export const sceneSchema = z.object({
  id,
  projectId: id,
  episodeId: id,
  sceneNumber: text,
  slugline: text,
  intExt: z.enum(INT_EXT),
  locationId: nullableId,
  timeOfDay: text,
  summary: text,
  dramaticPurpose: text,
  emotionEntering: text,
  emotionLeaving: text,
  /** Line range in the episode script (1-based, inclusive). */
  scriptRange: z.object({ startLine: z.number().int(), endLine: z.number().int() }).nullable(),
  characterIds: z.array(id),
  propIds: z.array(id),
  continuityNotes: text,
  order: z.number().int(),
});
export type Scene = z.infer<typeof sceneSchema>;

// ───────────────────────── Dialogue & Performance ─────────────────────────

export const waveformSchema = z.object({
  version: z.literal(1),
  sampleCount: z.number().int().nonnegative(),
  /** Normalised 0..1 peak amplitude per bucket. */
  peaks: z.array(z.number().min(0).max(1)),
  durationMs: z.number().int().nonnegative(),
});
export type Waveform = z.infer<typeof waveformSchema>;

export const dialogueLineSchema = z.object({
  id,
  projectId: id,
  episodeId: id,
  sceneId: id,
  /** Null for non-principal speakers; `speakerLabel` then carries the cue. */
  characterId: nullableId,
  speakerLabel: text,
  originalText: text,
  language: text,
  translation: text.nullable(),
  pronunciationNotes: text,
  dramaticContext: text,
  subtext: text,
  /** Approved dialogue is locked; script sync and AI revision must not alter it. */
  locked: z.boolean(),
  order: z.number().int(),
  /** Source range in the episode script (1-based, inclusive). Null for hand-created lines. */
  sourceStartLine: z.number().int().nullable(),
  sourceEndLine: z.number().int().nullable(),
});
export type DialogueLine = z.infer<typeof dialogueLineSchema>;

/** A stable-ID action paragraph of the script. Shots reference these, never copy them. */
export const actionBlockSchema = z.object({
  id,
  projectId: id,
  episodeId: id,
  sceneId: id,
  text,
  order: z.number().int(),
  startLine: z.number().int().nullable(),
  endLine: z.number().int().nullable(),
});
export type ActionBlock = z.infer<typeof actionBlockSchema>;

export const performanceDirectionSchema = z.object({
  id,
  dialogueLineId: id,
  emotion: text,
  objective: text,
  subtext: text,
  intensity: z.number().int().min(0).max(100),
  pace: z.enum(PACES),
  volume: z.enum(VOLUMES),
  pauses: text,
  breaths: text,
  emphasisNotes: text,
  physicalBehaviorNotes: text,
});
export type PerformanceDirection = z.infer<typeof performanceDirectionSchema>;

export const performanceTakeSchema = z.object({
  id,
  projectId: id,
  dialogueLineId: id,
  characterId: nullableId,
  voiceProfileId: nullableId,
  sourceType: z.enum(TAKE_SOURCES),
  audioAssetId: nullableId,
  durationMs: z.number().int().positive(),
  /** Where durationMs came from; server-read metadata outranks a browser hint. */
  durationSource: z.enum(DURATION_SOURCES),
  waveform: waveformSchema.nullable(),
  transcript: text,
  takeNumber: z.number().int().positive(),
  notes: text,
  rating: z.number().int().min(0).max(5),
  selected: z.boolean(),
  /** Archived takes keep their history but are hidden and can never be canonical. */
  archived: z.boolean(),
  createdAt: iso,
});
export type PerformanceTake = z.infer<typeof performanceTakeSchema>;

// ───────────────────────── Shots ─────────────────────────

const shotCharacterSchema = z.object({
  characterId: id,
  lookId: nullableId,
  performanceNotes: text,
  expression: text,
  posture: text,
  gestures: text,
  physicalInteractions: text,
});
export type ShotCharacter = z.infer<typeof shotCharacterSchema>;

const compositionSchema = z.object({
  framing: text,
  shotSize: text,
  aspectRatio: text,
  cameraPosition: text,
  cameraHeight: text,
  cameraAngle: text,
  lens: text,
  aperture: text,
  movement: text,
  movementSpeed: text,
  notes: text,
});

const spatialSchema = z.object({
  locationId: nullableId,
  setZone: text,
  subjectBlocking: text,
  /** Abstract marks, e.g. {label:"Yumeko", x:0.3, y:0.6}; real coordinates arrive with 3D sets. */
  marks: z.array(z.object({ label: text, x: z.number(), y: z.number(), notes: text })),
  facingDirection: text,
  eyelines: text,
  screenDirection: text,
  entryPoint: text,
  exitPoint: text,
  backgroundActivity: text,
});

const continuitySchema = z.object({
  previousShotId: nullableId,
  wardrobe: text,
  hair: text,
  makeup: text,
  jewelry: text,
  props: text,
  lighting: text,
  weather: text,
  timeOfDay: text,
  vehicleInPlay: z.boolean(),
  vehicleOrientation: text,
  /** Explicit visible character count; generators must not add people. */
  characterCount: z.number().int().min(0).nullable(),
  geography: text,
});

const actionSchema = z.object({
  beats: z.array(z.object({ id, order: z.number().int(), atMs: z.number().int().min(0), description: text })),
  beginningPose: text,
  endingPose: text,
});

const audioSchema = z.object({
  dialogueLineIds: z.array(id),
  preRollMs: z.number().int().min(0),
  postRollMs: z.number().int().min(0),
  interLineGapMs: z.number().int().min(0),
  ambience: text,
  foley: text,
  musicCue: text,
  silenceRequirements: text,
});

const lightingSchema = z.object({
  keyDirection: text,
  fill: text,
  practicals: text,
  colorTemperature: text,
  mood: text,
  referenceAssetId: nullableId,
});

const constraintsSchema = z.object({
  hard: z.array(text),
  negative: z.array(text),
  forbiddenObjects: z.array(text),
  forbiddenPeople: z.array(text),
  forbiddenActions: z.array(text),
  generatorNotes: text,
});

const generationPrefsSchema = z.object({
  modality: z.enum(MODALITIES),
  provider: text.nullable(),
  model: text.nullable(),
  referenceAssetIds: z.array(id),
  startFrameAssetId: nullableId,
  endFrameAssetId: nullableId,
  referenceVideoAssetId: nullableId,
  referenceAudioAssetId: nullableId,
  resolution: text,
  fps: z.number().positive(),
  /**
   * Manual production intent about the FINAL frame: what must survive a crop ("Yumeko's eyes inside the crop",
   * "keep the doorway fully visible"). Not part of any freshness part: it informs the adaptation plan only.
   */
  protectedComposition: z.array(text).default([]),
});

const scriptSourcesSchema = z.object({
  actionBlockIds: z.array(id),
  dialogueLineIds: z.array(id),
});

const approvalSchema = z.object({
  storyboardApproved: z.boolean(),
  performanceApproved: z.boolean(),
  continuityApproved: z.boolean(),
});

export const shotSchema = z.object({
  id,
  projectId: id,
  episodeId: id,
  sceneId: id,
  shotCode: text.min(1),
  title: text.min(1),
  storyBeat: text,
  dramaticPurpose: text,
  order: z.number().int(),
  status: z.enum(SHOT_STATUSES),
  targetDurationMs: z.number().int().min(0).nullable(),
  durationMode: z.enum(DURATION_MODES),
  composition: compositionSchema,
  spatial: spatialSchema,
  characters: z.array(shotCharacterSchema),
  propIds: z.array(id),
  continuity: continuitySchema,
  action: actionSchema,
  audio: audioSchema,
  lighting: lightingSchema,
  constraints: constraintsSchema,
  generation: generationPrefsSchema,
  /** Script content this shot was made from (traceability + coverage). */
  scriptSources: scriptSourcesSchema,
  approval: approvalSchema,
  createdAt: iso,
  updatedAt: iso,
});
export type Shot = z.infer<typeof shotSchema>;

// ───────────────────────── Storyboard / Generation / Continuity ─────────────────────────

export const storyboardFrameSchema = z.object({
  id,
  projectId: id,
  shotId: id,
  assetId: nullableId,
  version: z.number().int().positive(),
  source: z.enum(FRAME_SOURCES),
  notes: text,
  approved: z.boolean(),
  /** Fingerprint of the shot's visual inputs at approval time; compare to detect a stale storyboard. */
  approvedFingerprint: text.nullable(),
  /** Per-part fingerprints + derived duration at approval time (see domain/fingerprint.ts). */
  approvedSnapshot: z.object({ parts: z.record(z.string(), z.string()), durationMs: z.number() }).nullable(),
  approvedAt: iso.nullable(),
  createdAt: iso,
});
export type StoryboardFrame = z.infer<typeof storyboardFrameSchema>;

export const generationAttemptSchema = z.object({
  id,
  projectId: id,
  shotId: id,
  attemptNumber: z.number().int().positive(),
  provider: text,
  model: text,
  modality: z.enum(MODALITIES),
  prompt: text,
  negativePrompt: text,
  /** Frozen GenerationPackage at attempt time. History is never rewritten. */
  packageSnapshot: z.record(z.string(), z.unknown()),
  /** Fingerprint of that package (also inside the snapshot's provenance). Immutable. */
  packageFingerprint: text,
  modelSettings: z.record(z.string(), z.unknown()),
  inputAssetIds: z.array(id),
  outputAssetId: nullableId,
  costUsd: z.number().min(0).nullable(),
  durationMs: z.number().int().nullable(),
  status: z.enum(ATTEMPT_STATUSES),
  /** Review is independent of execution: a successful generation is not an approved shot. */
  reviewStatus: z.enum(REVIEW_STATUSES).default("unreviewed"),
  rejectionCategories: z.array(z.enum(REJECTION_CATEGORIES)).default([]),
  reviewedAt: iso.nullable().default(null),
  rejectionReason: text,
  notes: text,
  /** Equals reviewStatus === "approved" (enforced by a DB check). At most one per shot. */
  approved: z.boolean(),
  /** New-taxonomy modality the request was compiled for (null for manually logged legacy attempts). */
  requestModality: z.enum(GENERATION_MODALITIES).nullable().default(null),
  /** Frozen PromptPlan / normalized request / compatibility report at submission. Immutable. */
  promptPlan: promptPlanSchema.nullable().default(null),
  request: z.record(z.string(), z.unknown()).nullable().default(null),
  compatibility: z.record(z.string(), z.unknown()).nullable().default(null),
  /** Ignored-feature ids the user explicitly acknowledged before submitting. */
  acknowledgedIgnored: z.array(text).default([]),
  /**
   * Frozen GenerationAdaptationPlan (Phase 2C): how production framing/duration were adapted to this
   * provider. Null for attempts created before it existed ("No adaptation plan recorded"): never back-filled.
   */
  adaptationPlan: z.record(z.string(), z.unknown()).nullable().default(null),
  createdBy: nullableId.default(null),
  createdAt: iso,
});
export type GenerationAttempt = z.infer<typeof generationAttemptSchema>;

export const CONTINUITY_DIMENSIONS = [
  "characterIdentity",
  "wardrobe",
  "hair",
  "makeup",
  "jewelry",
  "set",
  "props",
  "lighting",
  "geography",
  "actionContinuity",
  "characterCount",
] as const;
export type ContinuityDimension = (typeof CONTINUITY_DIMENSIONS)[number];

export const continuityCheckSchema = z.object({
  id,
  projectId: id,
  shotId: id,
  attemptId: nullableId,
  kind: z.enum(["manual", "automated"]),
  overallScore: z.number().min(0).max(100).nullable(),
  scores: z.record(z.string(), z.number().min(0).max(100).nullable()),
  issues: z.array(
    z.object({ dimension: text, severity: z.enum(["minor", "major", "blocker"]), description: text }),
  ),
  reviewer: text,
  createdAt: iso,
});
export type ContinuityCheck = z.infer<typeof continuityCheckSchema>;

// ───────────────────────── Aggregate ─────────────────────────

export interface Collections {
  assets: Asset[];
  characters: Character[];
  identityRefs: IdentityRef[];
  looks: CharacterLook[];
  voiceProfiles: VoiceProfile[];
  locations: Location[];
  props: Prop[];
  episodes: Episode[];
  scenes: Scene[];
  shots: Shot[];
  dialogueLines: DialogueLine[];
  actionBlocks: ActionBlock[];
  directions: PerformanceDirection[];
  takes: PerformanceTake[];
  frames: StoryboardFrame[];
  attempts: GenerationAttempt[];
  continuityChecks: ContinuityCheck[];
}
export type CollectionName = keyof Collections;

export interface ProjectData extends Collections {
  project: Project;
  bible: ProjectBible;
  /**
   * Per-shot 3D set snapshot (Phase 2F), attached by the server loaders for shots that have a production camera.
   * Never persisted here and absent for projects without 3D sets.
   */
  spatialReferences?: Record<string, import("./previs/spatial").SpatialReference>;
}

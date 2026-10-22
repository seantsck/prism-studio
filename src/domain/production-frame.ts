import { z } from "zod";
import type { ShotContext } from "./context";
import {
  computeShotParts,
  PART_LABELS,
  stableParts,
  VISUAL_PARTS,
  type FreshnessPart,
  type ShotParts,
} from "./fingerprint";
import { formatRatio, parseAspectRatio, RATIO_TOLERANCE, sameRatio, type Ratio } from "./framing/ratio";
import { fingerprint } from "./hash";
import type { Asset, ProjectBible, Shot } from "./schemas";

/**
 * PRODUCTION FRAME (Phase 2G.1): the canonical, approved visual image of a Shot that Prism carries forward into
 * image-to-video and continuity workflows. Prism keeps five image concepts DISTINCT:
 *
 *   STORYBOARD FRAME   planning / composition approval (storyboard_frames)
 *   3D MASTER FRAME    deterministic render from the OPTIONAL spatial scene (scene_master_frames)
 *   PRODUCTION FRAME   this: what the Shot's finished still should look like (shot_production_frames)
 *   PROVIDER CANVAS    execution geometry a generation model requires
 *   DELIVERY FRAME     final conformed media
 *
 * A Production Frame needs NO 3D scene, GPU, reconstruction or Gaussian splat: 3D is one possible SOURCE, never a
 * prerequisite. The bytes live in the normal private Asset store; a promoted Storyboard or Master Frame REUSES its
 * existing Asset (no copy). A Production Frame record is IMMUTABLE history: its origin, image, dimensions and the
 * frozen visual-intent snapshot never change. Which one is canonical is separate, mutable state (the selection
 * pointer), so choosing another frame never rewrites history.
 *
 * Pure domain code: no persistence, no storage, no provider.
 */

export const PRODUCTION_FRAME_SCHEMA = "prism.production-frame.v1" as const;
export const PRODUCTION_FRAME_INTENT_SCHEMA = "prism.production-frame-intent.v1" as const;

/**
 * Where a frame came from. `generation_output` is accepted by the schema for Phase 2G.2 (image generation); Phase
 * 2G.1 has no action that creates one and makes no image-model call.
 */
export const PRODUCTION_FRAME_SOURCES = [
  "upload",
  "storyboard",
  "previs_master",
  "generation_output",
] as const;
export type ProductionFrameSource = (typeof PRODUCTION_FRAME_SOURCES)[number];

export const PRODUCTION_FRAME_SOURCE_LABEL: Record<ProductionFrameSource, string> = {
  upload: "Uploaded",
  storyboard: "From Storyboard",
  previs_master: "From 3D Master Frame",
  generation_output: "Generated",
};

const id = z.string().min(1);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** The immutable historical record. `version` is monotonically increasing per Shot (1, 2, 3 …). */
export const productionFrameSchema = z.object({
  id,
  projectId: id,
  shotId: id,
  version: z.number().int().positive(),
  schemaVersion: z.literal(PRODUCTION_FRAME_SCHEMA),
  /** the private image Asset (an existing one for a promotion; a new `production_frame` Asset for an upload) */
  assetId: id,
  /** frozen from the Asset at creation: the bytes' sha256 and the image's real pixel size */
  assetChecksum: hex64,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** the Shot's production aspect ratio at creation (e.g. "2.39:1"), as written */
  productionAspectRatio: z.string().min(1),
  source: z.enum(PRODUCTION_FRAME_SOURCES),
  sourceStoryboardFrameId: id.nullable(),
  sourceMasterFrameId: id.nullable(),
  sourceGenerationAttemptId: id.nullable(),
  /** prism.production-frame-intent.v1: WHAT THIS FRAME WAS MADE TO REPRESENT, copied by value */
  intentSnapshot: z.record(z.string(), z.unknown()),
  intentFingerprint: hex64,
  /** the Shot's named-part fingerprints at creation (see FRESHNESS_PARTS) */
  parts: z.record(z.string(), z.string()),
  /** deterministic identity of THIS artifact (no timestamps): the duplicate-promotion key */
  frameFingerprint: hex64,
  createdBy: id.nullable(),
  createdAt: z.string(),
});
export type ProductionFrame = z.infer<typeof productionFrameSchema>;

/** The Shot's canonical Production Frame. At most one per Shot; changing it moves only this pointer. */
export const productionFrameSelectionSchema = z.object({
  projectId: id,
  shotId: id,
  productionFrameId: id,
  selectedBy: id.nullable(),
  selectedAt: z.string(),
});
export type ProductionFrameSelection = z.infer<typeof productionFrameSelectionSchema>;

// ───────────────────────── the image rules ─────────────────────────

/** Image types a Production Frame may use: those whose pixel size Prism can read and verify server-side. */
export const PRODUCTION_FRAME_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
/** Smallest accepted side. Production Frames are NOT required to be 1912×800 (that is only the 3D master size). */
export const PRODUCTION_FRAME_MIN_EDGE = 64;
/** Relative aspect tolerance: 2.39 vs 2.388 (a 1912×800 render) match, 16:9 vs 2.39:1 does not. */
export const PRODUCTION_FRAME_ASPECT_TOLERANCE = RATIO_TOLERANCE;

/**
 * The Shot's canonical production aspect: its own composition ratio, else the Bible's. Never hardcoded. Null when
 * neither parses (then no frame can be judged and promotion/upload is refused with a clear instruction).
 */
export function shotProductionAspect(
  shot: Pick<Shot, "composition">,
  bible: Pick<ProjectBible, "aspectRatio">,
): { raw: string; ratio: Ratio } | null {
  for (const raw of [shot.composition.aspectRatio, bible.aspectRatio]) {
    const ratio = parseAspectRatio(raw);
    if (ratio) return { raw: raw.trim(), ratio };
  }
  return null;
}

export type ProductionImageProblemCode =
  | "not_image"
  | "unsupported_type"
  | "not_stored"
  | "no_dimensions"
  | "no_checksum"
  | "too_small"
  | "no_production_aspect"
  | "wrong_aspect";

export interface ProductionImageProblem {
  code: ProductionImageProblemCode;
  message: string;
}

export type ProductionImageCheck =
  | { ok: true; width: number; height: number; checksum: string; aspect: { raw: string; ratio: Ratio } }
  | { ok: false; problem: ProductionImageProblem };

const bad = (code: ProductionImageProblemCode, message: string): ProductionImageCheck => ({
  ok: false,
  problem: { code, message },
});

/**
 * Judges an Asset as a Production Frame image against the Shot's production aspect. Prism NEVER silently crops or
 * pads: a wrongly shaped image is refused so the filmmaker re-frames it (a future conform tool may create a correctly
 * shaped DERIVED Asset instead).
 */
export function checkProductionImage(
  asset: Pick<Asset, "type" | "mime" | "objectPath" | "width" | "height" | "checksum">,
  aspect: { raw: string; ratio: Ratio } | null,
): ProductionImageCheck {
  if (asset.type !== "image") return bad("not_image", "A Production Frame must be an image.");
  if (!asset.objectPath)
    return bad("not_stored", "That image has not been uploaded yet (it has no stored file).");
  if (!(PRODUCTION_FRAME_MIMES as readonly string[]).includes(asset.mime ?? ""))
    return bad("unsupported_type", "A Production Frame must be a PNG, JPEG or WebP image.");
  if (!asset.width || !asset.height || asset.width < 1 || asset.height < 1)
    return bad("no_dimensions", "Prism could not read this image's pixel size.");
  if (!asset.checksum || !/^[0-9a-f]{64}$/.test(asset.checksum))
    return bad("no_checksum", "This image has no recorded checksum.");
  if (asset.width < PRODUCTION_FRAME_MIN_EDGE || asset.height < PRODUCTION_FRAME_MIN_EDGE)
    return bad(
      "too_small",
      `A Production Frame must be at least ${PRODUCTION_FRAME_MIN_EDGE} px on each side.`,
    );
  if (!aspect)
    return bad(
      "no_production_aspect",
      "This Shot has no production aspect ratio. Set one in the Bible or the Shot's composition first.",
    );
  const actual = asset.width / asset.height;
  if (!sameRatio(actual, aspect.ratio.value, PRODUCTION_FRAME_ASPECT_TOLERANCE))
    return bad(
      "wrong_aspect",
      `This image is ${asset.width}×${asset.height} (${formatRatio(actual)}), but this Shot's production frame is ${aspect.raw}. Re-frame it to ${aspect.raw} and upload it again: Prism does not crop it.`,
    );
  return { ok: true, width: asset.width, height: asset.height, checksum: asset.checksum, aspect };
}

/** Whether an existing image can be promoted to a Production Frame now, and if not, the truthful reason. */
export type PromotionStatus = { ok: true } | { ok: false; reason: string };

/** The approved Storyboard Frame as a Production Frame source (the same rules the server applies). */
export function storyboardPromotionStatus(ctx: ShotContext): PromotionStatus {
  const frame = ctx.approvedFrame;
  if (!frame) return { ok: false, reason: "Approve a storyboard frame first." };
  const asset = frame.assetId ? (ctx.assets.get(frame.assetId) ?? null) : null;
  if (!asset) return { ok: false, reason: "The approved storyboard frame has no image." };
  return assetPromotionStatus(ctx, asset);
}

/** An existing Asset (e.g. a 3D Master Frame's render) judged against THIS Shot's production aspect. */
export function assetPromotionStatus(
  ctx: ShotContext,
  asset: Pick<Asset, "type" | "mime" | "objectPath" | "width" | "height" | "checksum" | "projectId"> | null,
): PromotionStatus {
  if (!asset) return { ok: false, reason: "That frame's image is missing." };
  if (asset.projectId !== ctx.project.id)
    return { ok: false, reason: "That image belongs to a different project." };
  const r = checkProductionImage(asset, shotProductionAspect(ctx.shot, ctx.bible));
  return r.ok ? { ok: true } : { ok: false, reason: r.problem.message };
}

// ───────────────────────── the frozen visual intent ─────────────────────────

export interface ProductionFrameIntentSnapshot {
  schema: typeof PRODUCTION_FRAME_INTENT_SCHEMA;
  shot: {
    id: string;
    code: string;
    title: string;
    storyBeat: string;
    dramaticPurpose: string;
    durationMs: number;
  };
  scene: { id: string; slugline: string };
  style: { visualStyle: string; colorLanguage: string; aspectRatio: string };
  framing: {
    aspectRatio: string;
    shotSize: string;
    framing: string;
    lens: string;
    aperture: string;
    cameraPosition: string;
    cameraHeight: string;
    cameraAngle: string;
    movement: string;
    movementSpeed: string;
    notes: string;
  };
  characters: Array<{
    characterId: string;
    name: string;
    physicalDescription: string;
    lookId: string | null;
    lookName: string | null;
    wardrobe: string;
    shoes: string;
    hair: string;
    makeup: string;
    jewelry: string;
    grooming: string;
    accessories: string;
    identityReferenceAssetIds: string[];
    lookReferenceAssetIds: string[];
    expression: string;
    posture: string;
    gestures: string;
    physicalInteractions: string;
    performanceNotes: string;
    /**
     * Phase 2G.4: the Character Continuity Lock the appearance above came from, by identity. Optional, so every
     * snapshot made before 2G.4 (or for an unlocked assignment) stays valid as written and is never rewritten.
     */
    continuityLock?: { lockId: string; name: string; lockFingerprint: string };
  }>;
  location: {
    id: string;
    name: string;
    zone: string;
    description: string;
    geography: string;
    referenceAssetIds: string[];
    /**
     * Phase 2G.3: the Shot's selected canonical Location View, by identity. Optional, so every snapshot made before
     * 2G.3 (or without a selected view) stays valid as written and is never rewritten.
     */
    view?: {
      viewId: string;
      name: string;
      kind: string;
      assetId: string;
      viewFingerprint: string;
    };
  } | null;
  props: Array<{ id: string; name: string }>;
  lighting: {
    keyDirection: string;
    fill: string;
    practicals: string;
    colorTemperature: string;
    mood: string;
    referenceAssetId: string | null;
  };
  blocking: Shot["spatial"];
  performance: Array<{
    lineId: string;
    speaker: string;
    text: string;
    emotion: string;
    objective: string;
    selectedTakeId: string | null;
    selectedTakeDurationMs: number | null;
  }>;
  timing: {
    durationMs: number;
    beginningPose: string;
    endingPose: string;
    beats: Array<{ atMs: number; description: string }>;
  };
  continuity: Shot["continuity"];
  constraints: {
    hard: string[];
    negative: string[];
    forbiddenObjects: string[];
    forbiddenPeople: string[];
    forbiddenActions: string[];
    guardrails: string[];
  };
  /** Frozen ONLY when the Shot has a 3D set. Absent otherwise: a Production Frame never needs one. */
  spatial?: {
    sceneFingerprint: string;
    cameraBookmarkId: string | null;
    cameraBookmarkLabel: string | null;
    masterFrameAssetId: string | null;
    environmentAssetId: string | null;
  };
}

/**
 * What a Production Frame is approved to represent, copied BY VALUE from the Shot's resolved context. Deliberately NOT
 * a GenerationPackage: the package will itself reference the selected frame, so embedding it here would be circular,
 * and provider/execution data has no place in a statement of visual intent.
 */
export function buildProductionFrameIntent(ctx: ShotContext): ProductionFrameIntentSnapshot {
  const { shot, scene, bible, location } = ctx;
  const snapshot: ProductionFrameIntentSnapshot = {
    schema: PRODUCTION_FRAME_INTENT_SCHEMA,
    shot: {
      id: shot.id,
      code: shot.shotCode,
      title: shot.title,
      storyBeat: shot.storyBeat,
      dramaticPurpose: shot.dramaticPurpose,
      durationMs: ctx.duration.durationMs,
    },
    scene: { id: scene.id, slugline: scene.slugline },
    style: {
      visualStyle: bible.visualStyle,
      colorLanguage: bible.colorLanguage,
      aspectRatio: shot.composition.aspectRatio || bible.aspectRatio,
    },
    framing: { ...shot.composition },
    // the AUTHORITATIVE appearance (Phase 2G.4): a selected Continuity Lock's frozen facts, else the live library
    characters: ctx.characters.map((c) => {
      const a = c.appearance;
      return {
        characterId: c.assignment.characterId,
        name: a.name,
        physicalDescription: a.physicalDescription,
        lookId: a.look?.id ?? null,
        lookName: a.look?.name ?? null,
        wardrobe: a.look?.wardrobe ?? "",
        shoes: a.look?.shoes ?? "",
        hair: a.look?.hair ?? "",
        makeup: a.look?.makeup ?? "",
        jewelry: a.look?.jewelry ?? "",
        grooming: a.look?.grooming ?? "",
        accessories: a.look?.accessories ?? "",
        identityReferenceAssetIds: [...a.identityReferenceAssetIds],
        lookReferenceAssetIds: [...(a.look?.referenceAssetIds ?? [])],
        expression: c.assignment.expression,
        posture: c.assignment.posture,
        gestures: c.assignment.gestures,
        physicalInteractions: c.assignment.physicalInteractions,
        performanceNotes: c.assignment.performanceNotes,
        ...(a.lock ? { continuityLock: { ...a.lock } } : {}),
      };
    }),
    location: location
      ? {
          id: location.id,
          name: location.name,
          zone: shot.spatial.setZone,
          description: location.description,
          geography: location.geography,
          referenceAssetIds: [...location.referenceAssetIds],
          ...(ctx.selectedLocationView
            ? {
                view: {
                  viewId: ctx.selectedLocationView.id,
                  name: ctx.selectedLocationView.name,
                  kind: ctx.selectedLocationView.kind,
                  assetId: ctx.selectedLocationView.assetId,
                  viewFingerprint: ctx.selectedLocationView.viewFingerprint,
                },
              }
            : {}),
        }
      : null,
    props: ctx.props.map((p) => ({ id: p.id, name: p.name })),
    lighting: { ...shot.lighting },
    blocking: structuredClone(shot.spatial),
    performance: ctx.lines.map((l) => ({
      lineId: l.line.id,
      speaker: l.character?.name ?? l.line.speakerLabel,
      text: l.line.originalText,
      emotion: l.direction?.emotion ?? "",
      objective: l.direction?.objective ?? "",
      selectedTakeId: l.selectedTake?.id ?? null,
      selectedTakeDurationMs: l.selectedTake?.durationMs ?? null,
    })),
    timing: {
      durationMs: ctx.duration.durationMs,
      beginningPose: shot.action.beginningPose,
      endingPose: shot.action.endingPose,
      beats: [...shot.action.beats]
        .sort((a, b) => a.order - b.order)
        .map((b) => ({ atMs: b.atMs, description: b.description })),
    },
    continuity: structuredClone(shot.continuity),
    constraints: {
      hard: [...shot.constraints.hard],
      negative: [...shot.constraints.negative],
      forbiddenObjects: [...shot.constraints.forbiddenObjects],
      forbiddenPeople: [...shot.constraints.forbiddenPeople],
      forbiddenActions: [...shot.constraints.forbiddenActions],
      guardrails: [...bible.guardrails],
    },
  };
  if (ctx.spatial)
    snapshot.spatial = {
      sceneFingerprint: ctx.spatial.sceneFingerprint,
      cameraBookmarkId: ctx.spatial.cameraBookmark?.id ?? null,
      cameraBookmarkLabel: ctx.spatial.cameraBookmark?.label ?? null,
      masterFrameAssetId: ctx.spatial.masterFrameAssetId ?? null,
      environmentAssetId: ctx.spatial.spatialEnvironment?.assetId ?? null,
    };
  return snapshot;
}

// ───────────────────────── creating a record (pure) ─────────────────────────

export interface ProductionFrameDraftInput {
  id: string;
  now: string;
  userId: string | null;
  source: ProductionFrameSource;
  sourceStoryboardFrameId?: string | null;
  sourceMasterFrameId?: string | null;
  sourceGenerationAttemptId?: string | null;
  /** the Asset the frame shows; its checksum and size are frozen into the record */
  asset: Pick<Asset, "id" | "type" | "mime" | "objectPath" | "width" | "height" | "checksum" | "projectId">;
}

/** The record before the repository assigns its per-Shot version (inside the creating transaction). */
export type ProductionFrameDraft = Omit<ProductionFrame, "version">;

export type DraftResult =
  | { ok: true; draft: ProductionFrameDraft }
  | {
      ok: false;
      problem: ProductionImageProblem | { code: "wrong_project" | "bad_source"; message: string };
    };

/** Which source ids each origin carries; anything else is refused (the database CHECK says the same). */
function sourceIdsAreConsistent(i: ProductionFrameDraftInput): boolean {
  const sb = i.sourceStoryboardFrameId ?? null;
  const mf = i.sourceMasterFrameId ?? null;
  const ga = i.sourceGenerationAttemptId ?? null;
  switch (i.source) {
    case "upload":
      return !sb && !mf && !ga;
    case "storyboard":
      return !!sb && !mf && !ga;
    case "previs_master":
      return !sb && !!mf && !ga;
    case "generation_output":
      return !sb && !mf && !!ga;
  }
}

export function draftProductionFrame(ctx: ShotContext, input: ProductionFrameDraftInput): DraftResult {
  if (input.asset.projectId !== ctx.project.id)
    return {
      ok: false,
      problem: { code: "wrong_project", message: "That image belongs to a different project." },
    };
  if (!sourceIdsAreConsistent(input))
    return {
      ok: false,
      problem: { code: "bad_source", message: "The Production Frame's origin is inconsistent." },
    };
  const aspect = shotProductionAspect(ctx.shot, ctx.bible);
  const image = checkProductionImage(input.asset, aspect);
  if (!image.ok) return { ok: false, problem: image.problem };

  const intent = buildProductionFrameIntent(ctx);
  const intentFingerprint = fingerprint(intent);
  const sb = input.sourceStoryboardFrameId ?? null;
  const mf = input.sourceMasterFrameId ?? null;
  const ga = input.sourceGenerationAttemptId ?? null;
  const frameFingerprint = fingerprint({
    schema: PRODUCTION_FRAME_SCHEMA,
    shotId: ctx.shot.id,
    source: input.source,
    sourceStoryboardFrameId: sb,
    sourceMasterFrameId: mf,
    sourceGenerationAttemptId: ga,
    assetChecksum: image.checksum,
    width: image.width,
    height: image.height,
    productionAspectRatio: image.aspect.raw,
    intentFingerprint,
  });
  return {
    ok: true,
    draft: {
      id: input.id,
      projectId: ctx.project.id,
      shotId: ctx.shot.id,
      schemaVersion: PRODUCTION_FRAME_SCHEMA,
      assetId: input.asset.id,
      assetChecksum: image.checksum,
      width: image.width,
      height: image.height,
      productionAspectRatio: image.aspect.raw,
      source: input.source,
      sourceStoryboardFrameId: sb,
      sourceMasterFrameId: mf,
      sourceGenerationAttemptId: ga,
      intentSnapshot: intent as unknown as Record<string, unknown>,
      intentFingerprint,
      // the Shot's 13 named parts, never another frame's selection part
      parts: { ...stableParts(computeShotParts(ctx)) },
      frameFingerprint,
      createdBy: input.userId,
      createdAt: input.now,
    },
  };
}

// ───────────────────────── freshness ─────────────────────────

/**
 * The parts whose change makes a Production Frame stale: everything the picture shows (camera, blocking, characters,
 * Looks, location, props, lighting, action, continuity) plus the selected performance (expression and delivery).
 * Story text, derived timing and constraints are frozen in the snapshot for later interpretation but do NOT stale the
 * image by themselves; the optional 3D scene is deliberately not a freshness input (3D never gates the image path).
 */
export const PRODUCTION_FRAME_PARTS: readonly FreshnessPart[] = [...VISUAL_PARTS, "performance"];

export type ProductionFrameFreshnessStatus = "missing" | "fresh" | "stale";

export interface ProductionFrameFreshness {
  status: ProductionFrameFreshnessStatus;
  /** which named parts differ from the ones the frame was made from */
  changedParts: FreshnessPart[];
  messages: string[];
}

const MISSING: ProductionFrameFreshness = { status: "missing", changedParts: [], messages: [] };

export function productionFrameFreshness(
  ctx: ShotContext,
  frame: Pick<ProductionFrame, "parts"> | null,
  currentParts: ShotParts = computeShotParts(ctx),
): ProductionFrameFreshness {
  if (!frame) return MISSING;
  const changed = PRODUCTION_FRAME_PARTS.filter(
    (p) => frame.parts[p] !== undefined && frame.parts[p] !== currentParts[p],
  );
  return {
    status: changed.length > 0 ? "stale" : "fresh",
    changedParts: [...changed],
    messages: changed.map((p) =>
      p === "looks"
        ? "Character Look changed after this Production Frame was made."
        : `${PART_LABELS[p]} changed after this Production Frame was made.`,
    ),
  };
}

/** The freshness of the Shot's SELECTED Production Frame (missing when none is selected). */
export const selectedProductionFrameFreshness = (ctx: ShotContext): ProductionFrameFreshness =>
  productionFrameFreshness(ctx, ctx.selectedProductionFrame);

// ───────────────────────── by-value reference for GenerationPackage v3 ─────────────────────────

/** What a GenerationPackage records about the selected Production Frame (by value; never a URL or a path). */
export interface ProductionFramePackageRef {
  frameId: string;
  assetId: string;
  version: number;
  source: ProductionFrameSource;
  intentFingerprint: string;
  freshness: "fresh" | "stale";
  changedParts: FreshnessPart[];
}

export function productionFramePackageRef(ctx: ShotContext): ProductionFramePackageRef | null {
  const f = ctx.selectedProductionFrame;
  if (!f) return null;
  const fr = productionFrameFreshness(ctx, f);
  return {
    frameId: f.id,
    assetId: f.assetId,
    version: f.version,
    source: f.source,
    intentFingerprint: f.intentFingerprint,
    freshness: fr.status === "stale" ? "stale" : "fresh",
    changedParts: fr.changedParts,
  };
}

// ───────────────────────── Production Frame → Location View (Phase 2G.3) ─────────────────────────

export type SaveAsViewStatus = { ok: true } | { ok: false; reason: string };

/**
 * "Save as Location View" from Shot Prep: only a SELECTED and FRESH Production Frame of a Shot that has a Location may
 * become canonical Location truth. A stale frame no longer depicts the Shot's intent, so it is refused.
 */
export function productionFrameToViewStatus(ctx: ShotContext): SaveAsViewStatus {
  if (!ctx.location) return { ok: false, reason: "This Shot has no Location." };
  const f = ctx.selectedProductionFrame;
  if (!f) return { ok: false, reason: "Select a Production Frame first." };
  if (productionFrameFreshness(ctx, f).status !== "fresh")
    return {
      ok: false,
      reason:
        "The selected Production Frame is stale: it no longer matches the Shot. Create or select a current one before saving it as a Location View.",
    };
  return { ok: true };
}

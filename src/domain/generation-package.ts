import { characterContinuityPackageRef, type CharacterContinuityPackageRef } from "./character-continuity";
import type { ShotContext } from "./context";
import type { DurationBreakdown } from "./duration";
import {
  computeShotParts,
  overallFingerprint,
  PART_LABELS,
  storyboardFreshness,
  type StoryboardFreshness,
} from "./fingerprint";
import { fingerprint } from "./hash";
import { runPreflight } from "./preflight";
import {
  PRODUCTION_FRAME_SOURCE_LABEL,
  productionFramePackageRef,
  selectedProductionFrameFreshness,
  type ProductionFrameFreshness,
  type ProductionFramePackageRef,
} from "./production-frame";
import {
  describeLocationView,
  LOCATION_VIEW_KIND_LABEL,
  LOCATION_VIEW_SOURCE_LABEL,
  locationViewPackageRef,
  type LocationViewPackageRef,
} from "./location-view";
import type { Asset, Shot } from "./schemas";
import { timelineFromContext, type TimelineSegment } from "./timeline";
import type { SpatialReference } from "./previs/spatial";

/**
 * Bump when the package SHAPE changes. Attempts keep the version they were built with (history is never rewritten).
 *   v2  Phase 2F and earlier
 *   v3  Phase 2G.1: `references.productionFrame` + `freshness.productionFrame` + the Production Frame Asset (present
 *       ONLY when the Shot has a selected Production Frame), and the start-frame precedence below
 *   v4  Phase 2G.3: `references.locationView` + the Location View Asset (present ONLY when the Shot has a selected,
 *       valid Location View), whose identity is also part of the Shot's `location` part
 *   v5  Phase 2G.4: `references.characterContinuity` + `characters[].continuityLock` + every locked reference image in
 *       `assets` (present ONLY for assignments with a selected, valid Character Continuity Lock). A locked
 *       assignment's `characters[]` entry describes the Lock's frozen appearance: the appearance Prism actually sends
 * Packages of v2, v3 and v4 stay readable: every later key is optional. No historical package is ever rewritten.
 */
export const PACKAGE_SCHEMA_VERSION = 5 as const;
export const PREVIOUS_PACKAGE_SCHEMA_VERSION = 4 as const;
export const LEGACY_PACKAGE_SCHEMA_VERSION = 2 as const;
export type PackageSchemaVersion =
  | typeof LEGACY_PACKAGE_SCHEMA_VERSION
  | 3
  | typeof PREVIOUS_PACKAGE_SCHEMA_VERSION
  | typeof PACKAGE_SCHEMA_VERSION;

/** Self-describing asset record embedded in the package so history stays interpretable if the asset later changes. */
export interface PackageAsset {
  id: string;
  type: Asset["type"];
  purpose: Asset["purpose"];
  name: string;
  originalFilename: string;
  mime: string | null;
  byteSize: number | null;
  checksum: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  storageProvider: Asset["storageProvider"];
  bucket: string | null;
  objectPath: string | null;
}

/**
 * Normalized, provider-independent generation package. Provider adapters (Phase 2) translate this
 * into provider payloads. Principle: never ask a model to remember what Prism Studio can store.
 */
export interface GenerationPackage {
  /**
   * The 3D set state this package was compiled against (Phase 2F). OPTIONAL and omitted entirely when the Shot
   * has no 3D set, so packages for such Shots are byte-identical to those built before 3D sets existed.
   */
  spatialReference?: SpatialReference;
  version: PackageSchemaVersion;
  packageSchemaVersion: PackageSchemaVersion;
  builtAt: string;
  project: { id: string; title: string; slug: string; defaultLanguage: string };
  episode: { id: string; number: number; title: string };
  shot: { id: string; code: string; title: string; status: Shot["status"] };
  /** Script content this shot was made from, copied by value so the snapshot stays readable. */
  sourceScript: {
    actions: Array<{ id: string; text: string; startLine: number | null }>;
    dialogue: Array<{ id: string; speaker: string; text: string; startLine: number | null; locked: boolean }>;
  };
  storyIntent: {
    storyBeat: string;
    dramaticPurpose: string;
    scene: {
      number: string;
      slugline: string;
      summary: string;
      emotionEntering: string;
      emotionLeaving: string;
    };
    episodeTitle: string;
  };
  style: { visualStyle: string; colorLanguage: string; cinematographyRules: string[]; aspectRatio: string };
  characters: Array<{
    characterId: string;
    name: string;
    physicalDescription: string;
    look: {
      id: string;
      name: string;
      locked: boolean;
      wardrobe: string;
      shoes: string;
      jewelry: string;
      hair: string;
      makeup: string;
      grooming: string;
      accessories: string;
      referenceAssetIds: string[];
    } | null;
    identityReferenceAssetIds: string[];
    expression: string;
    posture: string;
    gestures: string;
    physicalInteractions: string;
    performanceNotes: string;
    /**
     * v5: the Character Continuity Lock this entry's appearance comes from (by identity; the full frozen record is in
     * `references.characterContinuity`). Omitted for an assignment without a selected Lock (and in every v2-v4 package).
     */
    continuityLock?: { lockId: string; name: string; lockFingerprint: string };
  }>;
  set: {
    locationId: string;
    name: string;
    locked: boolean;
    description: string;
    geography: string;
    zone: string;
    lighting: string;
    referenceAssetIds: string[];
  } | null;
  props: Array<{ id: string; name: string; description: string }>;
  camera: Shot["composition"];
  blocking: Shot["spatial"];
  lighting: Shot["lighting"];
  performance: Array<{
    lineId: string;
    speaker: string;
    text: string;
    language: string;
    lockedText: boolean;
    emotion: string;
    objective: string;
    intensity: number | null;
    pace: string | null;
    selectedTake: {
      takeId: string;
      takeNumber: number;
      durationMs: number;
      audioAssetId: string | null;
      sourceType: string;
      transcript: string;
    } | null;
  }>;
  timing: {
    durationMs: number;
    /** shot.durationMode: how timing is meant to be derived. */
    mode: Shot["durationMode"];
    source: string;
    /** Labelled, contiguous time map: pre-roll, each selected take, pauses, reaction hold. */
    segments: TimelineSegment[];
    breakdown: DurationBreakdown | null;
    beats: Array<{ atMs: number; description: string }>;
    beginningPose: string;
    endingPose: string;
    ambience: string;
    foley: string;
    musicCue: string;
    silenceRequirements: string;
  };
  continuity: {
    previousShot: { id: string; code: string; title: string } | null;
    nextShot: { id: string; code: string; title: string } | null;
    wardrobe: string;
    hair: string;
    makeup: string;
    jewelry: string;
    props: string;
    lighting: string;
    weather: string;
    timeOfDay: string;
    vehicleInPlay: boolean;
    vehicleOrientation: string;
    characterCount: number | null;
    geography: string;
    projectRules: string[];
    sceneNotes: string;
  };
  constraints: {
    hard: string[];
    negative: string[];
    guardrails: string[];
    forbiddenObjects: string[];
    forbiddenPeople: string[];
    forbiddenActions: string[];
    generatorNotes: string;
  };
  references: {
    /**
     * The image-to-video start frame. Precedence (v3): the Shot's explicit `generation.startFrameAssetId` override, then
     * the SELECTED Production Frame's image, then the approved Storyboard Frame's image, else null. (v2: the first and
     * last only.) The Shot's own start-frame field is never written from the selection: it stays an explicit override.
     */
    startFrameAssetId: string | null;
    endFrameAssetId: string | null;
    approvedStoryboardFrame: { frameId: string; assetId: string | null; version: number } | null;
    /** v3: the Shot's SELECTED Production Frame, by value. Omitted when none is selected (and in every v2 package). */
    productionFrame?: ProductionFramePackageRef;
    /**
     * v4: the Shot's SELECTED canonical Location View, by value (image identity + semantic viewSpec). Omitted when none
     * is selected (and in every v2/v3 package). Its image is described in `assets`; it is never a start frame.
     */
    locationView?: LocationViewPackageRef;
    /**
     * v5: every selected Character Continuity Lock, by value (frozen facts + ordered reference images with checksums),
     * in Shot assignment order. Omitted when no assignment has one (and in every v2-v4 package).
     */
    characterContinuity?: CharacterContinuityPackageRef[];
    referenceAssetIds: string[];
    referenceVideoAssetId: string | null;
    referenceAudioAssetId: string | null;
  };
  generation: {
    modality: Shot["generation"]["modality"];
    provider: string | null;
    model: string | null;
    resolution: string;
    fps: number;
  };
  /** Every asset id referenced anywhere in this package, described by value. */
  assets: Record<string, PackageAsset>;
  freshness: { storyboard: StoryboardFreshness; productionFrame?: ProductionFrameFreshness };
  readiness: { ready: boolean; score: number; blockers: string[]; warnings: string[] };
  prompt: { positive: string; negative: string };
  provenance: {
    /** Hash of the whole package content (excluding builtAt and this provenance block). */
    fingerprint: string;
    /** Per-part content hashes: which inputs this package was built from. */
    parts: Record<string, string>;
    builtAt: string;
    sourceVersions: {
      shotUpdatedAt: string;
      lookIds: string[];
      locationId: string | null;
      selectedTakeIds: string[];
      storyboardFrameId: string | null;
      /** v3: only when a Production Frame is selected */
      productionFrameId?: string;
      /** v4: only when a Location View is selected */
      locationViewId?: string;
      /** v5: only when ≥1 Character Continuity Lock is selected; keyed by Character id */
      characterContinuityLocks?: Record<string, { lockId: string; lockFingerprint: string }>;
    };
  };
}

const nonEmpty = (xs: Array<string | null | undefined>) => xs.map((x) => x?.trim() ?? "").filter(Boolean);
const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** Pure assembly from a fully-resolved shot context. */
export function assembleGenerationPackage(ctx: ShotContext, now: Date = new Date()): GenerationPackage {
  const { shot, scene, bible, location } = ctx;
  const report = runPreflight(ctx);
  // Phase 2G.4: each assignment's appearance is resolved ONCE (the selected Continuity Lock, else the live Character /
  // IdentityRefs / Look) and packaged from that, so `characters[]` describes exactly what Prism sends.
  const names = ctx.characters.map((c) => c.appearance.name);

  const characters: GenerationPackage["characters"] = ctx.characters.map((c) => {
    const a = c.appearance;
    return {
      characterId: c.assignment.characterId,
      name: a.name,
      physicalDescription: a.physicalDescription,
      look: a.look
        ? {
            id: a.look.id,
            name: a.look.name,
            locked: a.look.locked,
            wardrobe: a.look.wardrobe,
            shoes: a.look.shoes,
            jewelry: a.look.jewelry,
            hair: a.look.hair,
            makeup: a.look.makeup,
            grooming: a.look.grooming,
            accessories: a.look.accessories,
            referenceAssetIds: a.look.referenceAssetIds,
          }
        : null,
      identityReferenceAssetIds: a.identityReferenceAssetIds,
      // shot-specific performance stays live on the assignment, locked or not
      expression: c.assignment.expression,
      posture: c.assignment.posture,
      gestures: c.assignment.gestures,
      physicalInteractions: c.assignment.physicalInteractions,
      performanceNotes: c.assignment.performanceNotes,
      ...(a.lock ? { continuityLock: { ...a.lock } } : {}),
    };
  });
  const characterContinuity = ctx.characters.flatMap((c) =>
    c.continuityLock ? [characterContinuityPackageRef(c.continuityLock)] : [],
  );

  const performance: GenerationPackage["performance"] = ctx.lines.map((l) => ({
    lineId: l.line.id,
    speaker: l.character?.name ?? l.line.speakerLabel,
    text: l.line.originalText,
    language: l.line.language,
    lockedText: l.line.locked,
    emotion: l.direction?.emotion ?? "",
    objective: l.direction?.objective ?? "",
    intensity: l.direction?.intensity ?? null,
    pace: l.direction?.pace ?? null,
    selectedTake: l.selectedTake
      ? {
          takeId: l.selectedTake.id,
          takeNumber: l.selectedTake.takeNumber,
          durationMs: l.selectedTake.durationMs,
          audioAssetId: l.selectedTake.audioAssetId,
          sourceType: l.selectedTake.sourceType,
          transcript: l.selectedTake.transcript,
        }
      : null,
  }));

  // Constraints derived from explicit stored state, so the generator is never asked to infer them.
  const derivedHard: string[] = [];
  if (shot.continuity.characterCount != null) {
    derivedHard.push(
      shot.continuity.characterCount === 0
        ? "No named characters appear in frame."
        : `Only these named characters appear: ${names.join(", ")}. Do not add anyone else.`,
    );
  }
  if (shot.continuity.vehicleInPlay && shot.continuity.vehicleOrientation) {
    derivedHard.push(`Vehicle orientation: ${shot.continuity.vehicleOrientation}`);
  }
  if (location?.locked) derivedHard.push(`Set is locked: ${location.name}. Do not alter its geography.`);
  for (const c of characters)
    if (c.continuityLock)
      derivedHard.push(
        c.look
          ? `${c.name} wears Look "${c.look.name}" exactly as frozen by Character Continuity Lock "${c.continuityLock.name}". Do not change it.`
          : `${c.name}'s appearance is frozen by Character Continuity Lock "${c.continuityLock.name}". Do not change it.`,
      );
    else if (c.look?.locked)
      derivedHard.push(`${c.name} wears locked Look "${c.look.name}". Do not change it.`);
  if (shot.continuity.weather) derivedHard.push(`Weather: ${shot.continuity.weather}. Do not change it.`);

  const negative = uniq([
    ...shot.constraints.negative,
    ...shot.constraints.forbiddenObjects.map((x) => `no ${x}`),
    ...shot.constraints.forbiddenPeople.map((x) => `no ${x}`),
    ...shot.constraints.forbiddenActions.map((x) => `no ${x}`),
  ]);

  const visual = nonEmpty([
    `${shot.composition.shotSize} ${shot.composition.framing}`.trim(),
    location ? `Location: ${location.name}${shot.spatial.setZone ? ` (${shot.spatial.setZone})` : ""}` : "",
    ...characters.map(
      (c) =>
        `${c.name}${c.look ? `, wearing ${c.look.wardrobe}` : ""}${c.expression ? `; ${c.expression}` : ""}${c.posture ? `; ${c.posture}` : ""}`,
    ),
    shot.spatial.subjectBlocking,
    shot.composition.movement
      ? `Camera: ${shot.composition.movement}${shot.composition.movementSpeed ? ` (${shot.composition.movementSpeed})` : ""}`
      : "",
    shot.lighting.mood
      ? `Lighting: ${shot.lighting.mood}${shot.lighting.keyDirection ? `, key ${shot.lighting.keyDirection}` : ""}`
      : "",
    bible.visualStyle,
  ]).join(". ");

  const approved = ctx.approvedFrame;
  // The selected Production Frame (if any). An unselected historical frame never reaches the package, so adding one
  // cannot change it; changing the SELECTION does.
  const productionFrame = productionFramePackageRef(ctx);
  // The selected canonical Location View (if any, and only when valid for the Shot's Location).
  const locationView = locationViewPackageRef(ctx.selectedLocationView);
  const timeline = timelineFromContext(ctx);
  const base: Omit<GenerationPackage, "assets" | "provenance"> = {
    version: PACKAGE_SCHEMA_VERSION,
    packageSchemaVersion: PACKAGE_SCHEMA_VERSION,
    builtAt: now.toISOString(),
    project: {
      id: ctx.project.id,
      title: ctx.project.title,
      slug: ctx.project.slug,
      defaultLanguage: ctx.project.defaultLanguage,
    },
    episode: { id: ctx.episode.id, number: ctx.episode.number, title: ctx.episode.title },
    shot: { id: shot.id, code: shot.shotCode, title: shot.title, status: shot.status },
    sourceScript: {
      actions: ctx.sourceActions.map((a) => ({ id: a.id, text: a.text, startLine: a.startLine })),
      dialogue: ctx.sourceDialogue.map((l) => ({
        id: l.id,
        speaker: ctx.lines.find((x) => x.line.id === l.id)?.character?.name ?? l.speakerLabel,
        text: l.originalText,
        startLine: l.sourceStartLine,
        locked: l.locked,
      })),
    },
    storyIntent: {
      storyBeat: shot.storyBeat,
      dramaticPurpose: shot.dramaticPurpose,
      scene: {
        number: scene.sceneNumber,
        slugline: scene.slugline,
        summary: scene.summary,
        emotionEntering: scene.emotionEntering,
        emotionLeaving: scene.emotionLeaving,
      },
      episodeTitle: ctx.episode.title,
    },
    style: {
      visualStyle: bible.visualStyle,
      colorLanguage: bible.colorLanguage,
      cinematographyRules: bible.cinematographyRules,
      aspectRatio: shot.composition.aspectRatio || bible.aspectRatio,
    },
    characters,
    set: location
      ? {
          locationId: location.id,
          name: location.name,
          locked: location.locked,
          description: location.description,
          geography: location.geography,
          zone: shot.spatial.setZone,
          lighting: location.lighting,
          referenceAssetIds: location.referenceAssetIds,
        }
      : null,
    props: ctx.props.map((p) => ({ id: p.id, name: p.name, description: p.description })),
    camera: shot.composition,
    blocking: shot.spatial,
    lighting: shot.lighting,
    performance,
    timing: {
      durationMs: ctx.duration.durationMs,
      mode: shot.durationMode,
      source: ctx.duration.source,
      segments: timeline.segments,
      breakdown: ctx.duration.breakdown,
      beats: [...shot.action.beats]
        .sort((a, b) => a.order - b.order)
        .map((b) => ({ atMs: b.atMs, description: b.description })),
      beginningPose: shot.action.beginningPose,
      endingPose: shot.action.endingPose,
      ambience: shot.audio.ambience,
      foley: shot.audio.foley,
      musicCue: shot.audio.musicCue,
      silenceRequirements: shot.audio.silenceRequirements,
    },
    continuity: {
      previousShot: ctx.previousShot
        ? { id: ctx.previousShot.id, code: ctx.previousShot.shotCode, title: ctx.previousShot.title }
        : null,
      nextShot: ctx.nextShot
        ? { id: ctx.nextShot.id, code: ctx.nextShot.shotCode, title: ctx.nextShot.title }
        : null,
      wardrobe: shot.continuity.wardrobe,
      hair: shot.continuity.hair,
      makeup: shot.continuity.makeup,
      jewelry: shot.continuity.jewelry,
      props: shot.continuity.props,
      lighting: shot.continuity.lighting,
      weather: shot.continuity.weather,
      timeOfDay: shot.continuity.timeOfDay || scene.timeOfDay,
      vehicleInPlay: shot.continuity.vehicleInPlay,
      vehicleOrientation: shot.continuity.vehicleOrientation,
      characterCount: shot.continuity.characterCount,
      geography: shot.continuity.geography,
      projectRules: bible.continuityRules,
      sceneNotes: scene.continuityNotes,
    },
    constraints: {
      hard: uniq([...shot.constraints.hard, ...derivedHard]),
      negative,
      guardrails: bible.guardrails,
      forbiddenObjects: shot.constraints.forbiddenObjects,
      forbiddenPeople: shot.constraints.forbiddenPeople,
      forbiddenActions: shot.constraints.forbiddenActions,
      generatorNotes: shot.constraints.generatorNotes,
    },
    references: {
      startFrameAssetId:
        shot.generation.startFrameAssetId ?? productionFrame?.assetId ?? approved?.assetId ?? null,
      endFrameAssetId: shot.generation.endFrameAssetId,
      approvedStoryboardFrame: approved
        ? { frameId: approved.id, assetId: approved.assetId, version: approved.version }
        : null,
      ...(productionFrame ? { productionFrame } : {}),
      ...(locationView ? { locationView } : {}),
      ...(characterContinuity.length > 0 ? { characterContinuity } : {}),
      referenceAssetIds: shot.generation.referenceAssetIds,
      referenceVideoAssetId: shot.generation.referenceVideoAssetId,
      referenceAudioAssetId:
        shot.generation.referenceAudioAssetId ??
        ctx.lines.find((l) => l.selectedTake?.audioAssetId)?.selectedTake?.audioAssetId ??
        null,
    },
    generation: {
      modality: shot.generation.modality,
      provider: shot.generation.provider,
      model: shot.generation.model,
      resolution: shot.generation.resolution,
      fps: shot.generation.fps,
    },
    freshness: {
      storyboard: storyboardFreshness(ctx, approved),
      ...(productionFrame ? { productionFrame: selectedProductionFrameFreshness(ctx) } : {}),
    },
    readiness: {
      ready: report.ready,
      score: report.score,
      blockers: report.blockers.map((b) => `${b.label}${b.detail ? ` — ${b.detail}` : ""}`),
      warnings: report.warnings.map((b) => `${b.label}${b.detail ? ` — ${b.detail}` : ""}`),
    },
    prompt: {
      positive: visual,
      negative: negative.concat(bible.guardrails).join("; "),
    },
    ...(ctx.spatial ? { spatialReference: ctx.spatial } : {}),
  };

  // Every referenced asset is described by value (checksum, dimensions, filename...).
  const assetIds = new Set<string>();
  const addIds = (ids: Array<string | null | undefined>) => ids.forEach((i) => i && assetIds.add(i));
  for (const c of base.characters)
    addIds([...c.identityReferenceAssetIds, ...(c.look?.referenceAssetIds ?? [])]);
  // every image a selected Continuity Lock froze (v5), described by value like every other reference
  for (const l of base.references.characterContinuity ?? []) addIds(l.references.map((r) => r.assetId));
  addIds(base.set?.referenceAssetIds ?? []);
  addIds([
    base.references.startFrameAssetId,
    base.references.endFrameAssetId,
    base.references.approvedStoryboardFrame?.assetId,
    // the Production Frame's image is described by value too, even when an explicit override wins the start frame
    base.references.productionFrame?.assetId,
    // the selected Location View's image (v4), described by value like every other reference
    base.references.locationView?.assetId,
    base.references.referenceVideoAssetId,
    base.references.referenceAudioAssetId,
    base.spatialReference?.masterFrameAssetId,
    // M2C control passes are described by value too (checksum, size, MIME, dimensions): provider-neutral machine data
    base.spatialReference?.controlPasses?.depth.assetId,
    base.spatialReference?.controlPasses?.objectIds.assetId,
    ...(base.spatialReference?.controlPasses?.characterMasks.map((m) => m.assetId) ?? []),
    // the Location's Gaussian-splat environment (M2D.1): described by value (checksum, size, MIME), never by URL
    base.spatialReference?.spatialEnvironment?.assetId,
    base.lighting.referenceAssetId,
    ...base.references.referenceAssetIds,
    ...base.performance.map((p) => p.selectedTake?.audioAssetId),
  ]);
  const assets: GenerationPackage["assets"] = {};
  for (const id of [...assetIds].sort()) {
    const a = ctx.assets.get(id);
    if (!a) continue;
    assets[id] = {
      id: a.id,
      type: a.type,
      purpose: a.purpose,
      name: a.name,
      originalFilename: a.originalFilename,
      mime: a.mime,
      byteSize: a.byteSize,
      checksum: a.checksum,
      width: a.width,
      height: a.height,
      durationMs: a.durationMs,
      sampleRate: a.sampleRate,
      channels: a.channels,
      storageProvider: a.storageProvider,
      bucket: a.bucket,
      objectPath: a.objectPath,
    };
  }

  const parts = computeShotParts(ctx);
  const content = { ...base, assets };
  // builtAt is excluded: rebuilding an unchanged shot must yield the same fingerprint.
  //
  // PACKAGE IDENTITY: provenance.fingerprint is the SHA-256 of this frozen package's content (the schema-version
  // fields included), so a v3 package and a v2 package are different frozen shapes with different identities even for
  // an unchanged Shot. "Has the Shot itself changed?" is a different question, answered by provenance.parts.overall
  // (see shotChangedSinceAttempt); the two are never interchangeable.
  const contentFingerprint = fingerprint({ ...content, builtAt: null });
  return {
    ...content,
    provenance: {
      fingerprint: contentFingerprint,
      parts: { ...parts, overall: overallFingerprint(parts) },
      builtAt: base.builtAt,
      sourceVersions: {
        shotUpdatedAt: shot.updatedAt,
        lookIds: ctx.characters.flatMap((c) => (c.look ? [c.look.id] : [])),
        locationId: ctx.location?.id ?? null,
        selectedTakeIds: ctx.lines.flatMap((l) => (l.selectedTake ? [l.selectedTake.id] : [])),
        storyboardFrameId: approved?.id ?? null,
        ...(productionFrame ? { productionFrameId: productionFrame.frameId } : {}),
        ...(locationView ? { locationViewId: locationView.viewId } : {}),
        ...(characterContinuity.length > 0
          ? {
              characterContinuityLocks: Object.fromEntries(
                characterContinuity.map((l) => [
                  l.characterId,
                  { lockId: l.lockId, lockFingerprint: l.lockFingerprint },
                ]),
              ),
            }
          : {}),
      },
    },
  };
}

// ───────────────────────── "has the Shot changed since attempt N?" ─────────────────────────

/** What the attempt-vs-now comparison used, and the two values compared (for display). */
export interface ShotChangeSinceAttempt {
  changed: boolean;
  /**
   * `inputs`: the Shot's production-input identity (`provenance.parts.overall`), comparable ACROSS package schema
   * versions. `package`: the exact package fingerprints, used only for genuinely old snapshots that recorded no
   * `parts.overall`.
   */
  basis: "inputs" | "package";
  from: string;
  to: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Has the SHOT changed since a historical generation attempt? Prefers the semantic input fingerprint
 * (`provenance.parts.overall`) of the frozen snapshot and of the current package, so a package SCHEMA upgrade alone
 * (v2 → v3) never reads as "the shot changed". A snapshot without it falls back to the exact package fingerprint. The
 * attempt is never rewritten. (Candidate sets, attempts, continuity runs and exports keep using the exact package
 * identity, `provenance.fingerprint`; only this reasoning uses the inputs identity.)
 */
export function shotChangedSinceAttempt(
  attempt: { packageFingerprint: string; packageSnapshot: Record<string, unknown> | null | undefined },
  current: Pick<GenerationPackage, "provenance">,
): ShotChangeSinceAttempt | null {
  const prov = attempt.packageSnapshot?.provenance as { parts?: { overall?: unknown } } | undefined;
  const then = prov?.parts?.overall;
  const now = current.provenance.parts.overall;
  if (typeof then === "string" && HEX64.test(then) && typeof now === "string" && HEX64.test(now))
    return { changed: then !== now, basis: "inputs", from: then, to: now };
  if (!attempt.packageFingerprint) return null;
  return {
    changed: attempt.packageFingerprint !== current.provenance.fingerprint,
    basis: "package",
    from: attempt.packageFingerprint,
    to: current.provenance.fingerprint,
  };
}

// ───────────────────────── Generation Brief (human readable) ─────────────────────────

export interface BriefSection {
  title: string;
  lines: string[];
}

export function renderGenerationBrief(pkg: GenerationPackage): BriefSection[] {
  const sec = (title: string, lines: Array<string | null | undefined | false>): BriefSection => ({
    title,
    lines: lines.filter((l): l is string => Boolean(l && l.trim())),
  });
  const secs: BriefSection[] = [];
  const sec_ = (s: BriefSection) => (s.lines.length > 0 ? secs.push(s) : undefined);

  sec_(
    sec("Story intent", [
      `Scene ${pkg.storyIntent.scene.number} — ${pkg.storyIntent.scene.slugline}`,
      pkg.storyIntent.storyBeat && `Beat: ${pkg.storyIntent.storyBeat}`,
      pkg.storyIntent.dramaticPurpose && `Purpose: ${pkg.storyIntent.dramaticPurpose}`,
      pkg.storyIntent.scene.emotionEntering &&
        `Emotion: ${pkg.storyIntent.scene.emotionEntering} → ${pkg.storyIntent.scene.emotionLeaving}`,
    ]),
  );
  sec_(
    sec("Look & style", [
      pkg.style.visualStyle,
      pkg.style.colorLanguage && `Color: ${pkg.style.colorLanguage}`,
      ...pkg.style.cinematographyRules,
    ]),
  );
  sec_(
    sec(
      "Characters",
      pkg.characters.flatMap((c) => [
        `${c.name}${c.look ? ` — Look: ${c.look.name}${c.look.locked ? " (locked)" : ""}` : " — NO LOOK ASSIGNED"}`,
        c.continuityLock && `  Continuity Lock: ${c.continuityLock.name}`,
        c.look && `  Wardrobe: ${c.look.wardrobe}`,
        c.look && c.look.shoes && `  Shoes: ${c.look.shoes}`,
        c.look && c.look.hair && `  Hair: ${c.look.hair}`,
        c.look && c.look.jewelry && `  Jewelry: ${c.look.jewelry}`,
        c.expression && `  Expression: ${c.expression}`,
        c.posture && `  Posture: ${c.posture}`,
        c.gestures && `  Gestures: ${c.gestures}`,
        c.performanceNotes && `  Notes: ${c.performanceNotes}`,
        `  Identity references: ${c.identityReferenceAssetIds.length}`,
      ]),
    ),
  );
  if (pkg.set) {
    sec_(
      sec("Set", [
        `${pkg.set.name}${pkg.set.locked ? " (locked)" : ""}${pkg.set.zone ? ` — ${pkg.set.zone}` : ""}`,
        pkg.set.geography,
        pkg.set.lighting && `Set lighting: ${pkg.set.lighting}`,
      ]),
    );
  }
  const cam = pkg.camera;
  sec_(
    sec("Camera", [
      [cam.shotSize, cam.framing].filter(Boolean).join(" · "),
      [cam.cameraPosition, cam.cameraHeight, cam.cameraAngle].filter(Boolean).join(" / "),
      [cam.lens, cam.aperture].filter(Boolean).join(" · "),
      cam.movement && `Movement: ${cam.movement}${cam.movementSpeed ? ` (${cam.movementSpeed})` : ""}`,
      cam.notes,
    ]),
  );
  const b = pkg.blocking;
  sec_(
    sec("Blocking", [
      b.subjectBlocking,
      b.facingDirection && `Facing: ${b.facingDirection}`,
      b.eyelines && `Eyelines: ${b.eyelines}`,
      b.screenDirection && `Screen direction: ${b.screenDirection}`,
      b.entryPoint && `Entry: ${b.entryPoint}`,
      b.exitPoint && `Exit: ${b.exitPoint}`,
      b.backgroundActivity && `Background: ${b.backgroundActivity}`,
    ]),
  );
  sec_(
    sec("Performance", [
      ...pkg.performance.flatMap((p) => [
        `${p.speaker}: 「${p.text}」${p.lockedText ? " 🔒" : ""}`,
        p.emotion &&
          `  ${p.emotion}${p.objective ? ` — wants: ${p.objective}` : ""}${p.intensity != null ? ` — intensity ${p.intensity}` : ""}`,
        p.selectedTake
          ? `  Selected take #${p.selectedTake.takeNumber} · ${(p.selectedTake.durationMs / 1000).toFixed(1)}s · ${p.selectedTake.sourceType}`
          : "  NO SELECTED TAKE",
      ]),
    ]),
  );
  const t = pkg.timing;
  sec_(
    sec("Timing", [
      `Target duration: ${(t.durationMs / 1000).toFixed(1)}s (${t.source})`,
      t.breakdown &&
        `Pre ${(t.breakdown.preRollMs / 1000).toFixed(1)}s + performance ${(t.breakdown.performanceMs / 1000).toFixed(1)}s + gaps ${(t.breakdown.gapsMs / 1000).toFixed(1)}s + post ${(t.breakdown.postRollMs / 1000).toFixed(1)}s`,
      t.beginningPose && `Begins: ${t.beginningPose}`,
      ...t.beats.map((x) => `@${(x.atMs / 1000).toFixed(1)}s ${x.description}`),
      t.endingPose && `Ends: ${t.endingPose}`,
    ]),
  );
  sec_(
    sec("Audio", [
      pkg.timing.ambience && `Ambience: ${t.ambience}`,
      t.foley && `Foley: ${t.foley}`,
      t.musicCue && `Music: ${t.musicCue}`,
      t.silenceRequirements && `Silence: ${t.silenceRequirements}`,
    ]),
  );
  const c = pkg.continuity;
  sec_(
    sec("Continuity", [
      c.previousShot && `Follows ${c.previousShot.code} — ${c.previousShot.title}`,
      c.weather && `Weather: ${c.weather}`,
      c.timeOfDay && `Time of day: ${c.timeOfDay}`,
      c.characterCount != null && `Visible characters: ${c.characterCount}`,
      c.vehicleInPlay && `Vehicle: ${c.vehicleOrientation || "ORIENTATION MISSING"}`,
      c.wardrobe && `Wardrobe: ${c.wardrobe}`,
      c.props && `Props: ${c.props}`,
      c.geography && `Geography: ${c.geography}`,
      c.sceneNotes,
    ]),
  );
  sec_(sec("Hard constraints", pkg.constraints.hard));
  sec_(sec("Negative constraints", pkg.constraints.negative));
  sec_(sec("Project guardrails", pkg.constraints.guardrails));
  const pf = pkg.references.productionFrame;
  if (pf) {
    // by name and state only: never a path, URL or checksum (those are diagnostics/export provenance)
    const changed = pf.changedParts.map((p) => PART_LABELS[p]);
    sec_(
      sec("Production Frame", [
        `Production Frame: v${pf.version} · ${PRODUCTION_FRAME_SOURCE_LABEL[pf.source]} · ${pf.freshness}`,
        pf.freshness === "stale" &&
          `STALE: ${changed.join(", ") || "the Shot changed"} changed after this frame was made`,
      ]),
    );
  }
  const lv = pkg.references.locationView;
  if (lv) {
    // by name and meaning only: never a path, URL or checksum
    sec_(
      sec("Location View", [
        `${lv.name} · ${LOCATION_VIEW_KIND_LABEL[lv.kind]} · ${LOCATION_VIEW_SOURCE_LABEL[lv.source]} · ${lv.width}×${lv.height}`,
        ...describeLocationView(lv).slice(1),
      ]),
    );
  }
  sec_(
    sec("References", [
      pkg.references.approvedStoryboardFrame &&
        `Approved storyboard frame v${pkg.references.approvedStoryboardFrame.version}`,
      pkg.references.startFrameAssetId && `Start frame: ${pkg.references.startFrameAssetId}`,
      pkg.references.endFrameAssetId && `End frame: ${pkg.references.endFrameAssetId}`,
      pkg.references.referenceAssetIds.length > 0 &&
        `${pkg.references.referenceAssetIds.length} reference image(s)`,
    ]),
  );
  sec_(
    sec("Target", [
      `${pkg.generation.modality} · ${pkg.generation.resolution} @ ${pkg.generation.fps}fps`,
      pkg.generation.provider
        ? `${pkg.generation.provider} / ${pkg.generation.model ?? "no model"}`
        : "No provider chosen",
    ]),
  );
  sec_(
    sec("Readiness", [
      pkg.readiness.ready ? "READY TO GENERATE" : "NOT READY TO GENERATE",
      ...pkg.readiness.blockers.map((x) => `✕ ${x}`),
      ...pkg.readiness.warnings.map((x) => `⚠ ${x}`),
    ]),
  );
  return secs;
}

export function briefToText(sections: BriefSection[]): string {
  return sections.map((s) => `## ${s.title}\n${s.lines.join("\n")}`).join("\n\n");
}

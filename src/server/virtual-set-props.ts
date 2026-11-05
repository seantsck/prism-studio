import "server-only";
import type { VirtualSetMode, VirtualSetProps } from "@/components/previs/virtual-set-editor";
import type { PrevisRepository } from "@/data/previs-repository";
import { buildShotContext } from "@/domain/context";
import type { TimelineCue } from "@/domain/previs/audio-mix";
import { shotTimelineCues } from "@/domain/previs/audio-mix-shot";
import { onCurrentSet, type CurrentSet } from "@/domain/previs/blocking";
import {
  authoredLightingIntent,
  baseEnvironmentFingerprint,
  baseEnvironmentOf,
} from "@/domain/previs/lighting";
import { sharedSetShots } from "@/domain/previs/spatial-workspace";
import type { ProjectData } from "@/domain/schemas";

type Location = ProjectData["locations"][number];

/** Which surface the editor is opened from (Phase 4C-I2). */
export type VirtualSetContext =
  /** Location-first set management: the page may switch Shots (by navigation, never in place) */
  | { kind: "location" }
  /** the Shot Spatial Workspace: the route owns the Shot; its CURRENT Location is the only set it opens */
  | { kind: "shot"; shotPrepHref: string };

/**
 * Phase 4C-I2: the ONE server loader of the 3D editor's props, shared by the Location 3D page and the Shot Spatial
 * Workspace. Everything is read through the existing repositories; nothing new is persisted.
 *
 *   Location scene   `location_scene_documents` of THIS Location (null = no set yet: the first save creates it)
 *   Shot-owned rows  the active Shot's bookmark / camera path / blocking / renders, ONLY when they were authored on
 *                    this Location's saved set (`onCurrentSet`). A row left on another Location's set is history: it
 *                    is never handed to the editor as working state. (The rig is handed over as stored because the
 *                    lighting panel needs its revision for compare-and-set; the panel never applies a rig from
 *                    another set.)
 *   Master Frames    the Shot's whole capture history (each compared live with THIS set, so an old one is stale)
 *   sharedWith       the OTHER Shots currently assigned to this Location (never the active one)
 */
export async function loadVirtualSetProps(input: {
  slug: string;
  data: ProjectData;
  previs: PrevisRepository;
  location: Location;
  /** the Shot to open (validated here: in Location mode it must be listed; in Shot mode it is the route's Shot) */
  activeShotId: string | null;
  context: VirtualSetContext;
}): Promise<VirtualSetProps> {
  const { slug, data, previs, location, context } = input;
  const scene = await previs.getSceneForLocation(location.id);
  const set: CurrentSet | null = scene ? { locationId: location.id, sceneDocumentId: scene.id } : null;

  const episodeOf = new Map(data.episodes.map((e) => [e.id, e]));
  const labelOf = (s: ProjectData["shots"][number]) =>
    `Ep ${episodeOf.get(s.episodeId)?.number ?? "?"} · Shot ${s.shotCode}`;

  // Location mode: Shots set in this Location, plus the Shot the user came from (whatever its Location is now)
  const listed =
    context.kind === "location"
      ? data.shots.filter((s) => s.spatial.locationId === location.id || s.id === input.activeShotId)
      : [];
  const activeShot =
    context.kind === "shot"
      ? (data.shots.find((s) => s.id === input.activeShotId) ?? null)
      : (listed.find((s) => s.id === input.activeShotId) ?? null);
  const activeShotId = activeShot?.id ?? null;

  const mode: VirtualSetMode =
    context.kind === "location"
      ? { kind: "location", shots: listed.map((s) => ({ id: s.id, label: labelOf(s) })) }
      : {
          kind: "shot",
          shot: activeShot
            ? { id: activeShot.id, label: labelOf(activeShot), code: activeShot.shotCode }
            : { id: "", label: "", code: "" },
          shotPrepHref: context.shotPrepHref,
        };

  const current = <T extends { locationId: string; sceneDocumentId: string }>(rows: T[]) =>
    onCurrentSet(rows, set);
  const bookmarkRec = activeShotId ? await previs.getBookmarkForShot(activeShotId) : null;
  const bookmark = bookmarkRec ? (current([bookmarkRec])[0] ?? null) : null;
  const pathRec = activeShotId ? await previs.getCameraPathForShot(activeShotId) : null;
  const cameraPath = pathRec ? (current([pathRec])[0] ?? null) : null;
  const frames = activeShotId ? await previs.listMasterFrames(activeShotId) : [];
  const clips = activeShotId ? current(await previs.listPrevisClips(activeShotId)) : [];
  const blockingRecords = activeShotId ? current(await previs.listShotBlocking(activeShotId)) : [];
  const spatialBundles = activeShotId ? current(await previs.listSpatialPassBundles(activeShotId)) : [];
  const shotLighting = activeShot
    ? {
        rig: await previs.getLightingRigForShot(activeShot.id),
        currentIntent: authoredLightingIntent(activeShot),
      }
    : null;

  // Gaussian-splat environments of this Location: immutable reconstruction records + their private result Assets
  const assetById = new Map(data.assets.map((a) => [a.id, a]));
  const splatEnvironments = (await previs.listReconstructions(location.id)).flatMap((r) => {
    const asset = assetById.get(r.resultAssetId);
    if (!asset || !asset.objectPath) return [];
    return [
      {
        assetId: asset.id,
        reconstructionId: r.id,
        name: asset.name,
        format: r.resultFormat,
        byteSize: asset.byteSize ?? null,
        gaussianCount: r.gaussianCount,
        checksum: asset.checksum ?? null,
        method: r.method,
        sources: r.sources.map((s) => ({
          assetId: s.assetId,
          name: assetById.get(s.assetId)?.name ?? s.assetId,
          checksum: s.checksum,
        })),
        createdAt: r.createdAt,
      },
    ];
  });
  const referenceImages = data.assets
    .filter(
      (a) =>
        a.type === "image" &&
        a.objectPath &&
        (location.referenceAssetIds.includes(a.id) || a.purpose === "location_ref"),
    )
    .map((a) => ({ id: a.id, name: a.name }));

  // Shot timing authority: the canonical Shot duration (selected performance, else manual target) and the
  // Shot's own frame rate. Camera motion aligns to these; nothing here invents a duration.
  let shotTiming: {
    durationMs: number;
    source: string;
    frameRate: number;
    timelineCues: TimelineCue[];
    assetNames: Record<string, string>;
  } | null = null;
  if (activeShot) {
    const ctx = buildShotContext(data, activeShot.id);
    // the one Shot-timeline arithmetic (layoutPerformance): interactive playback and the previs mix both use it
    const { cues } = shotTimelineCues(data, activeShot.id);
    const assetNames: Record<string, string> = {};
    for (const line of ctx.lines)
      if (line.selectedAudioAsset) assetNames[line.selectedAudioAsset.id] = line.selectedAudioAsset.name;
    shotTiming = {
      durationMs: ctx.duration.durationMs,
      source: ctx.duration.source,
      frameRate: activeShot.generation.fps,
      timelineCues: cues,
      assetNames,
    };
  }

  return {
    projectSlug: slug,
    locationId: location.id,
    locationName: location.name,
    scene: {
      sceneDocumentId: scene?.id ?? null,
      revision: scene?.revision ?? null,
      fingerprint: scene?.sceneFingerprint ?? null,
      baseEnvironmentFingerprint: scene
        ? baseEnvironmentFingerprint(baseEnvironmentOf(scene.document))
        : null,
      engineScene: scene ? (scene.document.scene as Record<string, unknown>) : null,
    },
    mode,
    sharedWith: sharedSetShots(data, location.id, activeShot),
    characters: data.characters.map((c) => ({ id: c.id, name: c.name })),
    glbAssets: data.assets
      .filter((a) => a.mime === "model/gltf-binary" && a.objectPath)
      .map((a) => ({ id: a.id, name: a.name, checksum: a.checksum ?? null })),
    splatEnvironments,
    referenceImages,
    activeShotId,
    bookmark: bookmark
      ? {
          id: bookmark.id,
          cameraLabel: bookmark.cameraLabel,
          sceneRevision: bookmark.sceneRevision,
          sceneFingerprint: bookmark.sceneFingerprint,
          value: bookmark.value,
        }
      : null,
    shotTiming,
    cameraPath: cameraPath
      ? {
          id: cameraPath.id,
          revision: cameraPath.revision,
          sceneRevision: cameraPath.sceneRevision,
          sceneFingerprint: cameraPath.sceneFingerprint,
          pathFingerprint: cameraPath.pathFingerprint,
          path: cameraPath.path,
        }
      : null,
    previsClips: clips.map((c) => ({
      id: c.id,
      assetId: c.assetId,
      pathRevision: c.pathRevision,
      pathFingerprint: c.pathFingerprint,
      sceneRevision: c.sceneRevision,
      sceneFingerprint: c.sceneFingerprint,
      frameRate: c.frameRate,
      durationMs: c.durationMs,
      renderWidth: c.renderWidth,
      renderHeight: c.renderHeight,
      container: c.container,
      codec: c.codec,
      hasAudio: c.hasAudio,
      audioMixFingerprint: c.audioMixFingerprint,
      audioCodec: c.audioMix?.codec ?? null,
      blockingFingerprint: c.blockingFingerprint,
      lightingFingerprint: c.lightingFingerprint,
      lighting: c.lighting ? { baseEnvironment: c.lighting.baseEnvironment } : null,
      renderedAt: c.renderedAt,
    })),
    masterFrames: frames.map((f) => ({
      id: f.id,
      assetId: f.assetId,
      sceneRevision: f.sceneRevision,
      sceneFingerprint: f.sceneFingerprint,
      sceneDocumentId: f.sceneDocumentId,
      capturedAt: f.capturedAt,
      adopted: f.adoptedAt !== null,
      blockingFingerprint: f.blockingFingerprint,
      lightingFingerprint: f.lightingFingerprint,
      lighting: f.lighting ? { baseEnvironment: f.lighting.baseEnvironment } : null,
      cameraFingerprint: f.cameraFingerprint,
      baseEnvironmentFingerprint: f.baseEnvironmentFingerprint,
      // captured on another Location's set (history): shown, but compared with THIS set like every other frame
      otherSet: f.locationId !== location.id,
    })),
    spatialBundles,
    shotLighting,
    blocking: blockingRecords.map((r) => ({
      characterId: r.characterId,
      name: data.characters.find((c) => c.id === r.characterId)?.name ?? "Character",
      blockingId: r.id,
      revision: r.revision,
      fingerprint: r.blockingFingerprint,
      sceneRevision: r.sceneRevision,
      sceneFingerprint: r.sceneFingerprint,
      entry: r.entry,
    })),
  };
}

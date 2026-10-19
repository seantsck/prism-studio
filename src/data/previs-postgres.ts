import type { Pool, PoolClient } from "pg";
import {
  applyJobPatch,
  jobActualCostSchema,
  jobCostEstimateSchema,
  jobOptionsSchema,
  jobSourceSchema,
  JobTransitionError,
  newJobRecord,
  sanitizeProviderPayload,
  type JobEvent,
  type JobEventRecord,
  type JobPatch,
  type NewReconstructionJob,
  type ReconstructionJobRecord,
} from "@/domain/reconstruction/job";
import {
  calibrationSchema,
  generationProvenanceSchema,
  sourcesFor,
  reconstructionFingerprintOf,
  type NewSpatialReconstruction,
  type SpatialReconstructionRecord,
} from "@/domain/previs/splat";
import { pickCurrentClip, type StoredAudioMix } from "@/domain/previs/audio-mix";
import {
  blockingFingerprint,
  buildShotBlockingReference,
  parseBlockingEntry,
  renderedBlockingFingerprint,
  type RenderedBlockingFigure,
} from "@/domain/previs/blocking";
import { poseFingerprint } from "@/domain/previs/pose";
import { bookmarkFromCamera } from "@/domain/previs/camera";
import { cameraPathFingerprint, cameraPathSchema, validateCameraPath } from "@/domain/previs/camera-path";
import { sceneFingerprint } from "@/domain/previs/document";
import {
  buildSpatialReference,
  CAMERA_MOTION_SCHEMA_VERSION,
  type CameraMotionReference,
  type SpatialReference,
} from "@/domain/previs/spatial";
import {
  bookmarkCameraFingerprint,
  buildControlPassesReference,
  pickCurrentBundle,
  SPATIAL_PASS_BUNDLE_SCHEMA,
  type CharacterMasksJson,
  type ControlCameraSource,
  type DepthMetadata,
  type ObjectManifest,
} from "@/domain/previs/spatial-passes";
import { cameraBookmarkSchema, previsDocumentSchema } from "@/domain/previs/types";
import {
  PrevisError,
  type AudioMixResolver,
  type CameraBookmarkRecord,
  type CameraPathRecord,
  type MasterFrameRecord,
  type NewMasterFrame,
  type NewPrevisClip,
  type NewSpatialPassBundle,
  type SpatialPassBundleRecord,
  type PrevisClipRecord,
  type SaveCameraPathInput,
  type SaveShotBlockingInput,
  type ShotBlockingRecord,
  type PrevisRepository,
  type SaveSceneInput,
  type SceneDocumentRecord,
  type SetBookmarkInput,
} from "./previs-repository";

type Row = Record<string, unknown>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

const mapScene = (r: Row): SceneDocumentRecord => ({
  id: String(r.id),
  projectId: String(r.project_id),
  locationId: String(r.location_id),
  engine: String(r.engine),
  engineVersion: String(r.engine_version),
  upstreamCommit: String(r.upstream_commit),
  schemaVersion: String(r.schema_version),
  revision: Number(r.revision),
  document: previsDocumentSchema.parse(r.scene_json),
  sceneFingerprint: String(r.scene_fingerprint),
  createdBy: str(r.created_by),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const mapBookmark = (r: Row): CameraBookmarkRecord => ({
  id: String(r.id),
  projectId: String(r.project_id),
  shotId: String(r.shot_id),
  locationId: String(r.location_id),
  sceneDocumentId: String(r.scene_document_id),
  sceneRevision: Number(r.scene_revision),
  sceneFingerprint: String(r.scene_fingerprint),
  cameraLabel: String(r.camera_label),
  value: cameraBookmarkSchema.parse({
    position: r.position,
    rotation: r.rotation,
    target: r.target,
    projection: r.projection,
    fovVerticalDegrees: Number(r.fov_vertical_degrees),
    focalLengthMm: Number(r.focal_length_mm),
    focalLengthBasis: r.focal_length_basis,
    productionAspectRatio: r.production_aspect_ratio,
    productionAspectValue: Number(r.production_aspect_value),
  }),
  createdBy: str(r.created_by),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const mapFrame = (r: Row): MasterFrameRecord => ({
  id: String(r.id),
  projectId: String(r.project_id),
  shotId: String(r.shot_id),
  locationId: String(r.location_id),
  sceneDocumentId: String(r.scene_document_id),
  sceneRevision: Number(r.scene_revision),
  sceneFingerprint: String(r.scene_fingerprint),
  cameraBookmarkId: str(r.camera_bookmark_id),
  assetId: String(r.asset_id),
  source: "scene_render",
  renderWidth: Number(r.render_width),
  renderHeight: Number(r.render_height),
  productionAspectRatio: String(r.production_aspect_ratio),
  capturedAt: iso(r.captured_at),
  adoptedAt: isoOrNull(r.adopted_at),
  adoptedFrameId: str(r.adopted_frame_id),
  blockingFingerprint: str(r.blocking_fingerprint),
  blocking: (r.blocking_json as RenderedBlockingFigure[] | null) ?? null,
  createdBy: str(r.created_by),
  createdAt: iso(r.created_at),
});

const mapBlocking = (r: Row): ShotBlockingRecord => ({
  id: String(r.id),
  projectId: String(r.project_id),
  shotId: String(r.shot_id),
  characterId: String(r.character_id),
  locationId: String(r.location_id),
  sceneDocumentId: String(r.scene_document_id),
  sceneRevision: Number(r.scene_revision),
  sceneFingerprint: String(r.scene_fingerprint),
  schemaVersion: String(r.schema_version),
  rigVersion: String(r.rig_version),
  revision: Number(r.revision),
  entry: parseBlockingEntry({
    schema: r.schema_version,
    characterId: String(r.character_id),
    root: {
      position: r.root_position,
      orientation: r.root_orientation,
      scale: Number(r.root_scale),
    },
    pose: r.pose_json,
    visibility: Boolean(r.visible),
  }),
  poseFingerprint: String(r.pose_fingerprint),
  blockingFingerprint: String(r.blocking_fingerprint),
  createdBy: str(r.created_by),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const mapPath = (r: Row): CameraPathRecord => ({
  id: String(r.id),
  projectId: String(r.project_id),
  shotId: String(r.shot_id),
  locationId: String(r.location_id),
  sceneDocumentId: String(r.scene_document_id),
  sceneRevision: Number(r.scene_revision),
  sceneFingerprint: String(r.scene_fingerprint),
  schemaVersion: String(r.schema_version),
  revision: Number(r.revision),
  durationMs: Number(r.duration_ms),
  frameRate: Number(r.frame_rate),
  path: cameraPathSchema.parse(r.path_json),
  pathFingerprint: String(r.path_fingerprint),
  createdBy: str(r.created_by),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const mapClip = (r: Row): PrevisClipRecord => ({
  id: String(r.id),
  projectId: String(r.project_id),
  shotId: String(r.shot_id),
  locationId: String(r.location_id),
  cameraPathId: str(r.camera_path_id),
  pathRevision: Number(r.path_revision),
  pathFingerprint: String(r.path_fingerprint),
  sceneDocumentId: String(r.scene_document_id),
  sceneRevision: Number(r.scene_revision),
  sceneFingerprint: String(r.scene_fingerprint),
  assetId: String(r.asset_id),
  source: "local_previs",
  frameRate: Number(r.frame_rate),
  durationMs: Number(r.duration_ms),
  renderWidth: Number(r.render_width),
  renderHeight: Number(r.render_height),
  container: String(r.container) as "mp4" | "webm",
  codec: String(r.codec),
  hasAudio: Boolean(r.has_audio),
  audioAssetId: str(r.audio_asset_id),
  audioMix: (r.audio_mix_json as StoredAudioMix | null) ?? null,
  audioMixFingerprint: str(r.audio_mix_fingerprint),
  blockingFingerprint: str(r.blocking_fingerprint),
  blocking: (r.blocking_json as RenderedBlockingFigure[] | null) ?? null,
  renderedAt: iso(r.rendered_at),
  createdBy: str(r.created_by),
  createdAt: iso(r.created_at),
});

const mapBundle = (r: Row): SpatialPassBundleRecord => ({
  id: String(r.id),
  projectId: String(r.project_id),
  shotId: String(r.shot_id),
  locationId: String(r.location_id),
  sceneDocumentId: String(r.scene_document_id),
  sceneRevision: Number(r.scene_revision),
  sceneFingerprint: String(r.scene_fingerprint),
  blockingFingerprint: str(r.blocking_fingerprint),
  camera: r.camera_json as ControlCameraSource,
  schemaVersion: String(r.schema_version),
  bundleFingerprint: String(r.bundle_fingerprint),
  width: Number(r.width),
  height: Number(r.height),
  depth: {
    assetId: String(r.depth_asset_id),
    encoding: "prism.depth-f32.v1",
    metadata: r.depth_metadata_json as DepthMetadata,
  },
  objectIds: {
    assetId: String(r.object_id_asset_id),
    encoding: "prism.object-id-u32.v1",
    manifest: r.object_manifest_json as ObjectManifest,
  },
  characterMasks: r.character_masks_json as CharacterMasksJson,
  createdBy: str(r.created_by),
  createdAt: iso(r.created_at),
});

const mapReconstruction = (r: Row): SpatialReconstructionRecord => ({
  id: String(r.id),
  projectId: String(r.project_id),
  locationId: String(r.location_id),
  schemaVersion: "prism.spatial-reconstruction.v1",
  method: r.method as SpatialReconstructionRecord["method"],
  resultKind: r.result_kind as SpatialReconstructionRecord["resultKind"],
  resultAssetId: String(r.result_asset_id),
  resultChecksum: str(r.result_checksum),
  resultFormat: r.result_format as SpatialReconstructionRecord["resultFormat"],
  gaussianCount:
    r.gaussian_count === null || r.gaussian_count === undefined ? null : Number(r.gaussian_count),
  sources: sourcesFor(
    r.method as SpatialReconstructionRecord["method"],
    (Array.isArray(r.source_assets_json) ? r.source_assets_json : []).map(
      (s: { assetId: string; checksum: string | null }) => ({
        assetId: String(s.assetId),
        checksum: s.checksum ?? null,
      }),
    ),
  ),
  calibration: calibrationSchema.parse(r.calibration_json),
  generation: r.generation_json ? generationProvenanceSchema.parse(r.generation_json) : null,
  fingerprint: String(r.reconstruction_fingerprint),
  createdBy: str(r.created_by),
  createdAt: iso(r.created_at),
});

const mapJob = (r: Row): ReconstructionJobRecord => ({
  id: String(r.id),
  projectId: String(r.project_id),
  locationId: String(r.location_id),
  schemaVersion: "prism.reconstruction-job.v1",
  jobFingerprint: String(r.job_fingerprint),
  attempt: Number(r.attempt),
  previousJobId: str(r.previous_job_id),
  // a plain identifier: an id the registry no longer knows is still readable history
  provider: String(r.provider),
  capability: String(r.provider_capability),
  model: str(r.provider_model),
  resultKind: r.requested_result_kind as ReconstructionJobRecord["resultKind"],
  sources: (r.source_assets_json as unknown[]).map((x) => jobSourceSchema.parse(x)),
  options: jobOptionsSchema.parse(r.options_json),
  status: r.status as ReconstructionJobRecord["status"],
  progress: r.progress === null || r.progress === undefined ? null : Number(r.progress),
  revision: Number(r.revision),
  providerOperationId: str(r.provider_operation_id),
  providerOperation: (r.provider_operation_json as Record<string, unknown> | null) ?? null,
  providerInputs: (r.provider_inputs_json as ReconstructionJobRecord["providerInputs"]) ?? null,
  providerResult: (r.provider_result_json as Record<string, unknown> | null) ?? null,
  resultReconstructionId: str(r.result_reconstruction_id),
  costEstimate: r.cost_estimate_json ? jobCostEstimateSchema.parse(r.cost_estimate_json) : null,
  actualCost: r.cost_actual_json ? jobActualCostSchema.parse(r.cost_actual_json) : null,
  errorCode: (r.error_code as ReconstructionJobRecord["errorCode"]) ?? null,
  errorMessage: str(r.error_message),
  lastPolledAt: r.last_polled_at ? iso(r.last_polled_at) : null,
  createdBy: str(r.created_by),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  completedAt: r.completed_at ? iso(r.completed_at) : null,
});

async function insertReconstruction(c: PoolClient, input: NewSpatialReconstruction) {
  const calibration = calibrationSchema.parse(input.calibration);
  const sources = sourcesFor(input.method, input.sources);
  const generation = input.method === "generated" ? generationProvenanceSchema.parse(input.generation) : null;
  if (input.method !== "generated" && input.generation)
    throw new PrevisError("invalid", "Only a generated reconstruction carries provider provenance.");
  const fp = reconstructionFingerprintOf({
    locationId: input.locationId,
    method: input.method,
    resultKind: input.resultKind,
    resultAssetId: input.resultAssetId,
    resultChecksum: input.resultChecksum,
    sources,
    calibration,
    generation,
  });
  try {
    const r = await c.query(
      `insert into location_spatial_reconstructions
         (id, project_id, location_id, schema_version, method, result_kind, result_asset_id, result_checksum,
          result_format, gaussian_count, source_assets_json, calibration_json, reconstruction_fingerprint,
          created_by, created_at, job_id, provider, provider_capability, provider_model, provider_operation_id,
          generation_json)
       values ($1,$2,$3,'prism.spatial-reconstruction.v1',$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,
               $15,$16,$17,$18,$19,$20::jsonb)
       returning *`,
      [
        input.id,
        input.projectId,
        input.locationId,
        input.method,
        input.resultKind,
        input.resultAssetId,
        input.resultChecksum,
        input.resultFormat,
        input.gaussianCount,
        JSON.stringify(sources),
        JSON.stringify(calibration),
        fp,
        input.userId,
        input.now,
        generation?.jobId ?? null,
        generation?.provider ?? null,
        generation?.capability ?? null,
        generation?.model ?? null,
        generation?.operationId ?? null,
        generation ? JSON.stringify(generation) : null,
      ],
    );
    return mapReconstruction(r.rows[0]);
  } catch (e) {
    if ((e as { code?: string }).code === "23505")
      throw new PrevisError(
        "conflict",
        generation
          ? "That reconstruction job already produced its reconstruction."
          : "That exact reconstruction is already recorded for this location.",
      );
    throw e;
  }
}

/** RLS-bound: every statement runs under the caller's JWT claims via the preamble (owner-only policies). */
export class PostgresPrevisData implements PrevisRepository {
  constructor(
    private readonly pool: Pool,
    private readonly preamble: string,
  ) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(this.preamble);
      const r = await fn(client);
      await client.query("commit");
      return r;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getSceneForLocation(locationId: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from location_scene_documents where location_id = $1", [locationId]);
      return r.rows[0] ? mapScene(r.rows[0]) : null;
    });
  }

  async getScene(sceneDocumentId: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from location_scene_documents where id = $1", [sceneDocumentId]);
      return r.rows[0] ? mapScene(r.rows[0]) : null;
    });
  }

  async saveScene(input: SaveSceneInput) {
    const fp = sceneFingerprint(input.document);
    const json = JSON.stringify(input.document);
    return this.tx(async (c) => {
      if (input.expectedRevision === null) {
        const r = await c.query(
          `insert into location_scene_documents
             (id, project_id, location_id, engine, engine_version, upstream_commit, schema_version, revision,
              scene_json, scene_fingerprint, created_by, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,1,$8::jsonb,$9,$10,$11,$11)
           on conflict (location_id) do nothing returning *`,
          [
            input.id,
            input.projectId,
            input.locationId,
            input.document.engine,
            input.engineVersion,
            input.document.upstreamCommit,
            input.document.schema,
            json,
            fp,
            input.userId,
            input.now,
          ],
        );
        if (!r.rows[0])
          throw new PrevisError("conflict", "This set was changed elsewhere. Reload before saving.");
        return mapScene(r.rows[0]);
      }
      const r = await c.query(
        `update location_scene_documents
            set revision = revision + 1, engine_version = $3, upstream_commit = $4, scene_json = $5::jsonb,
                scene_fingerprint = $6
          where location_id = $1 and project_id = $7 and revision = $2
          returning *`,
        [
          input.locationId,
          input.expectedRevision,
          input.engineVersion,
          input.document.upstreamCommit,
          json,
          fp,
          input.projectId,
        ],
      );
      if (!r.rows[0])
        throw new PrevisError("conflict", "This set was changed elsewhere. Reload before saving.");
      return mapScene(r.rows[0]);
    });
  }

  async getBookmarkForShot(shotId: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from shot_camera_bookmarks where shot_id = $1", [shotId]);
      return r.rows[0] ? mapBookmark(r.rows[0]) : null;
    });
  }

  async setBookmark(input: SetBookmarkInput) {
    return this.tx(async (c) => {
      const s = await c.query(
        "select * from location_scene_documents where id = $1 and project_id = $2 and location_id = $3",
        [input.sceneDocumentId, input.projectId, input.locationId],
      );
      if (!s.rows[0]) throw new PrevisError("not_found", "That 3D set was not found for this location.");
      const scene = mapScene(s.rows[0]);
      if (!scene.document.productionCamera)
        throw new PrevisError("no_camera", "This set has no production camera yet.");
      const v = bookmarkFromCamera(scene.document.productionCamera);
      const r = await c.query(
        `insert into shot_camera_bookmarks
           (id, project_id, shot_id, location_id, scene_document_id, scene_revision, scene_fingerprint, camera_label,
            position, rotation, target, projection, fov_vertical_degrees, focal_length_mm, focal_length_basis,
            production_aspect_ratio, production_aspect_value, created_by, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$19)
         on conflict (shot_id) do update set
           location_id = excluded.location_id, scene_document_id = excluded.scene_document_id,
           scene_revision = excluded.scene_revision, scene_fingerprint = excluded.scene_fingerprint,
           camera_label = excluded.camera_label, position = excluded.position, rotation = excluded.rotation,
           target = excluded.target, fov_vertical_degrees = excluded.fov_vertical_degrees,
           focal_length_mm = excluded.focal_length_mm, focal_length_basis = excluded.focal_length_basis,
           production_aspect_ratio = excluded.production_aspect_ratio,
           production_aspect_value = excluded.production_aspect_value
         returning *`,
        [
          input.id,
          input.projectId,
          input.shotId,
          input.locationId,
          scene.id,
          scene.revision,
          scene.sceneFingerprint,
          scene.document.productionCamera.label,
          JSON.stringify(v.position),
          JSON.stringify(v.rotation),
          JSON.stringify(v.target),
          v.projection,
          v.fovVerticalDegrees,
          v.focalLengthMm,
          v.focalLengthBasis,
          v.productionAspectRatio,
          v.productionAspectValue,
          input.userId,
          input.now,
        ],
      );
      return mapBookmark(r.rows[0]);
    });
  }

  async listSpatialReferences(projectId: string, currentAudioMix?: AudioMixResolver) {
    return this.tx(async (c) => {
      const b = await c.query("select * from shot_camera_bookmarks where project_id = $1", [projectId]);
      const p = await c.query("select * from shot_camera_paths where project_id = $1", [projectId]);
      const bl = await c.query("select * from shot_character_blocking where project_id = $1", [projectId]);
      const out: Record<string, SpatialReference> = {};
      if (b.rows.length === 0 && p.rows.length === 0 && bl.rows.length === 0) return out;
      const blockingByShot = new Map<string, ShotBlockingRecord[]>();
      for (const r of bl.rows) {
        const rec = mapBlocking(r);
        const list = blockingByShot.get(rec.shotId) ?? [];
        list.push(rec);
        blockingByShot.set(rec.shotId, list);
      }
      const nameRows = bl.rows.length
        ? await c.query("select id, name from characters where project_id = $1", [projectId])
        : { rows: [] as Row[] };
      const names = Object.fromEntries(nameRows.rows.map((r) => [String(r.id), String(r.name)]));
      const bookmarks = new Map(b.rows.map((r) => [String(r.shot_id), mapBookmark(r)]));
      const paths = new Map(p.rows.map((r) => [String(r.shot_id), mapPath(r)]));
      const sceneIds = [
        ...new Set([...b.rows, ...p.rows, ...bl.rows].map((r) => String(r.scene_document_id))),
      ];
      const s = await c.query("select * from location_scene_documents where id = any($1::uuid[])", [
        sceneIds,
      ]);
      const scenes = new Map(s.rows.map((r) => [String(r.id), mapScene(r)]));
      const f = await c.query(
        `select distinct on (shot_id) shot_id, asset_id from scene_master_frames
          where project_id = $1 and adopted_at is not null order by shot_id, adopted_at desc`,
        [projectId],
      );
      const adopted = new Map(f.rows.map((r) => [String(r.shot_id), String(r.asset_id)]));
      const reconRows = await c.query(
        "select * from location_spatial_reconstructions where project_id = $1 order by created_at desc",
        [projectId],
      );
      const reconstructions = reconRows.rows.map(mapReconstruction);
      const bundleRows = await c.query(
        "select * from shot_spatial_pass_bundles where project_id = $1 order by created_at desc",
        [projectId],
      );
      const bundlesByShot = new Map<string, SpatialPassBundleRecord[]>();
      for (const r of bundleRows.rows) {
        const rec = mapBundle(r);
        const list = bundlesByShot.get(rec.shotId) ?? [];
        list.push(rec);
        bundlesByShot.set(rec.shotId, list);
      }
      const k = await c.query(
        `select shot_id, path_fingerprint, asset_id, has_audio, audio_mix_fingerprint, blocking_fingerprint,
                rendered_at
           from shot_previs_clips where project_id = $1`,
        [projectId],
      );
      const clipsByShot = new Map<
        string,
        Array<{
          shotId: string;
          pathFingerprint: string;
          assetId: string;
          hasAudio: boolean;
          audioMixFingerprint: string | null;
          blockingFingerprint: string | null;
          renderedAt: string;
        }>
      >();
      for (const r of k.rows) {
        const list = clipsByShot.get(String(r.shot_id)) ?? [];
        list.push({
          shotId: String(r.shot_id),
          pathFingerprint: String(r.path_fingerprint),
          assetId: String(r.asset_id),
          hasAudio: Boolean(r.has_audio),
          audioMixFingerprint: str(r.audio_mix_fingerprint),
          blockingFingerprint: str(r.blocking_fingerprint),
          renderedAt: iso(r.rendered_at),
        });
        clipsByShot.set(String(r.shot_id), list);
      }
      for (const shotId of new Set([...bookmarks.keys(), ...paths.keys(), ...blockingByShot.keys()])) {
        const bm = bookmarks.get(shotId) ?? null;
        const path = paths.get(shotId) ?? null;
        const blockRecs = (blockingByShot.get(shotId) ?? []).sort((x, y) =>
          x.characterId < y.characterId ? -1 : 1,
        );
        const scene = scenes.get(
          (bm?.sceneDocumentId ?? path?.sceneDocumentId ?? blockRecs[0]?.sceneDocumentId) as string,
        );
        if (!scene) continue;
        const currentBlockingFp = blockRecs.length
          ? renderedBlockingFingerprint(
              blockRecs.map((x) => x.entry),
              { locationId: scene.locationId },
            )
          : null;
        const clip = path
          ? pickCurrentClip(
              clipsByShot.get(shotId) ?? [],
              path.pathFingerprint,
              currentAudioMix?.(shotId, path.durationMs) ?? null,
              currentBlockingFp,
            )
          : null;
        const cameraMotion: CameraMotionReference | null = path
          ? {
              schemaVersion: CAMERA_MOTION_SCHEMA_VERSION,
              cameraPathId: path.id,
              cameraPathRevision: path.revision,
              cameraPathFingerprint: path.pathFingerprint,
              sceneRevision: path.sceneRevision,
              sceneFingerprint: path.sceneFingerprint,
              durationMs: path.durationMs,
              frameRate: path.frameRate,
              interpolation: path.path.interpolation,
              focalLengthBasis: "vertical-sensor-24mm",
              keyframes: path.path.keyframes,
              previsAssetId: clip?.assetId ?? null,
              ...(clip
                ? {
                    previs: {
                      assetId: clip.assetId,
                      hasAudio: clip.hasAudio,
                      audioMixFingerprint: clip.audioMixFingerprint,
                    },
                  }
                : {}),
            }
          : null;
        out[shotId] = buildSpatialReference({
          locationId: scene.locationId,
          scene: {
            id: scene.id,
            revision: scene.revision,
            sceneFingerprint: scene.sceneFingerprint,
            document: scene.document,
          },
          bookmark: bm
            ? {
                id: bm.id,
                cameraLabel: bm.cameraLabel,
                sceneRevision: bm.sceneRevision,
                sceneFingerprint: bm.sceneFingerprint,
                value: bm.value,
              }
            : null,
          adoptedMasterFrameAssetId: adopted.get(shotId) ?? null,
          cameraMotion,
          shotBlocking: buildShotBlockingReference(blockRecs, names, { locationId: scene.locationId }),
          controlPasses: (() => {
            const cur = pickCurrentBundle(bundlesByShot.get(shotId) ?? [], {
              sceneFingerprint: scene.sceneFingerprint,
              blockingFingerprint: currentBlockingFp,
              pathFingerprint: path?.pathFingerprint ?? null,
              bookmarkCameraFingerprint: bm ? bookmarkCameraFingerprint(bm.value) : null,
            });
            return cur ? buildControlPassesReference(cur) : null;
          })(),
          reconstructions: reconstructions.filter((rec) => rec.locationId === scene.locationId),
        });
      }
      return out;
    });
  }

  async listMasterFrames(shotId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from scene_master_frames where shot_id = $1 order by captured_at desc",
        [shotId],
      );
      return r.rows.map(mapFrame);
    });
  }

  async getMasterFrame(id: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from scene_master_frames where id = $1", [id]);
      return r.rows[0] ? mapFrame(r.rows[0]) : null;
    });
  }

  async recordMasterFrame(input: NewMasterFrame) {
    return this.tx(async (c) => {
      const r = await c.query(
        `insert into scene_master_frames
           (id, project_id, shot_id, location_id, scene_document_id, scene_revision, scene_fingerprint,
            camera_bookmark_id, asset_id, render_width, render_height, production_aspect_ratio, captured_at,
            created_by, created_at, blocking_fingerprint, blocking_json)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$13,$15,$16::jsonb) returning *`,
        [
          input.id,
          input.projectId,
          input.shotId,
          input.locationId,
          input.sceneDocumentId,
          input.sceneRevision,
          input.sceneFingerprint,
          input.cameraBookmarkId,
          input.assetId,
          input.renderWidth,
          input.renderHeight,
          input.productionAspectRatio,
          input.capturedAt,
          input.userId,
          input.blockingFingerprint ?? null,
          input.blocking ? JSON.stringify(input.blocking) : null,
        ],
      );
      return mapFrame(r.rows[0]);
    });
  }

  async adoptMasterFrame(id: string, storyboardFrameId: string, now: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "update scene_master_frames set adopted_at = $2, adopted_frame_id = $3 where id = $1 returning *",
        [id, now, storyboardFrameId],
      );
      if (!r.rows[0]) throw new PrevisError("not_found", "That master frame was not found.");
      return mapFrame(r.rows[0]);
    });
  }

  async getCameraPathForShot(shotId: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from shot_camera_paths where shot_id = $1", [shotId]);
      return r.rows[0] ? mapPath(r.rows[0]) : null;
    });
  }

  async saveCameraPath(input: SaveCameraPathInput) {
    const problems = validateCameraPath(input.path);
    if (problems.length > 0) throw new PrevisError("invalid", problems.join("; "));
    const fp = cameraPathFingerprint(input.path);
    const json = JSON.stringify(input.path);
    const conflict = new PrevisError(
      "conflict",
      "This camera path was changed elsewhere. Reload before saving.",
    );
    return this.tx(async (c) => {
      const s = await c.query(
        "select id from location_scene_documents where id = $1 and project_id = $2 and location_id = $3",
        [input.sceneDocumentId, input.projectId, input.locationId],
      );
      if (!s.rows[0]) throw new PrevisError("not_found", "That 3D set was not found for this location.");
      if (input.expectedRevision === null) {
        const r = await c.query(
          `insert into shot_camera_paths
             (id, project_id, shot_id, location_id, scene_document_id, scene_revision, scene_fingerprint,
              schema_version, revision, duration_ms, frame_rate, path_json, path_fingerprint, created_by,
              created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11::jsonb,$12,$13,$14,$14)
           on conflict (shot_id) do nothing returning *`,
          [
            input.id,
            input.projectId,
            input.shotId,
            input.locationId,
            input.sceneDocumentId,
            input.sceneRevision,
            input.sceneFingerprint,
            input.path.schema,
            input.path.durationMs,
            input.path.frameRate,
            json,
            fp,
            input.userId,
            input.now,
          ],
        );
        if (!r.rows[0]) throw conflict;
        return mapPath(r.rows[0]);
      }
      const r = await c.query(
        `update shot_camera_paths
            set revision = revision + 1, location_id = $3, scene_document_id = $4, scene_revision = $5,
                scene_fingerprint = $6, duration_ms = $7, frame_rate = $8, path_json = $9::jsonb,
                path_fingerprint = $10
          where shot_id = $1 and project_id = $11 and revision = $2
          returning *`,
        [
          input.shotId,
          input.expectedRevision,
          input.locationId,
          input.sceneDocumentId,
          input.sceneRevision,
          input.sceneFingerprint,
          input.path.durationMs,
          input.path.frameRate,
          json,
          fp,
          input.projectId,
        ],
      );
      if (!r.rows[0]) throw conflict;
      return mapPath(r.rows[0]);
    });
  }

  async listShotBlocking(shotId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from shot_character_blocking where shot_id = $1 order by character_id",
        [shotId],
      );
      return r.rows.map(mapBlocking);
    });
  }

  async saveShotBlocking(input: SaveShotBlockingInput) {
    let entry;
    try {
      entry = parseBlockingEntry(input.entry);
    } catch (err) {
      throw new PrevisError("invalid", `Invalid character blocking: ${(err as Error).message}`);
    }
    if (entry.characterId !== input.characterId)
      throw new PrevisError("invalid", "The blocking is for a different character.");
    const poseFp = poseFingerprint(entry.pose);
    const fp = blockingFingerprint(entry, { locationId: input.locationId });
    const conflict = new PrevisError(
      "conflict",
      "This character's blocking was changed elsewhere. Reload before saving.",
    );
    return this.tx(async (c) => {
      const s = await c.query(
        "select id from location_scene_documents where id = $1 and project_id = $2 and location_id = $3",
        [input.sceneDocumentId, input.projectId, input.locationId],
      );
      if (!s.rows[0]) throw new PrevisError("not_found", "That 3D set was not found for this location.");
      if (input.expectedRevision === null) {
        const r = await c.query(
          `insert into shot_character_blocking
             (id, project_id, shot_id, character_id, location_id, scene_document_id, scene_revision,
              scene_fingerprint, schema_version, rig_version, revision, root_position, root_orientation,
              root_scale, pose_json, visible, pose_fingerprint, blocking_fingerprint, created_by, created_at,
              updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15,$16,$17,$18,$19,$19)
           on conflict (shot_id, character_id) do nothing returning *`,
          [
            input.id,
            input.projectId,
            input.shotId,
            input.characterId,
            input.locationId,
            input.sceneDocumentId,
            input.sceneRevision,
            input.sceneFingerprint,
            entry.schema,
            entry.pose.rig,
            JSON.stringify(entry.root.position),
            JSON.stringify(entry.root.orientation),
            entry.root.scale,
            JSON.stringify(entry.pose),
            entry.visibility,
            poseFp,
            fp,
            input.userId,
            input.now,
          ],
        );
        if (!r.rows[0]) throw conflict;
        return mapBlocking(r.rows[0]);
      }
      const r = await c.query(
        `update shot_character_blocking
            set revision = revision + 1, location_id = $4, scene_document_id = $5, scene_revision = $6,
                scene_fingerprint = $7, root_position = $8::jsonb, root_orientation = $9::jsonb, root_scale = $10,
                pose_json = $11::jsonb, visible = $12, pose_fingerprint = $13, blocking_fingerprint = $14
          where shot_id = $1 and character_id = $2 and project_id = $3 and revision = $15
          returning *`,
        [
          input.shotId,
          input.characterId,
          input.projectId,
          input.locationId,
          input.sceneDocumentId,
          input.sceneRevision,
          input.sceneFingerprint,
          JSON.stringify(entry.root.position),
          JSON.stringify(entry.root.orientation),
          entry.root.scale,
          JSON.stringify(entry.pose),
          entry.visibility,
          poseFp,
          fp,
          input.expectedRevision,
        ],
      );
      if (!r.rows[0]) throw conflict;
      return mapBlocking(r.rows[0]);
    });
  }

  async removeShotBlocking(input: {
    projectId: string;
    shotId: string;
    characterId: string;
    expectedRevision: number;
  }) {
    return this.tx(async (c) => {
      const r = await c.query(
        `delete from shot_character_blocking
          where shot_id = $1 and character_id = $2 and project_id = $3 and revision = $4 returning id`,
        [input.shotId, input.characterId, input.projectId, input.expectedRevision],
      );
      if (!r.rows[0]) {
        const exists = await c.query(
          "select 1 from shot_character_blocking where shot_id = $1 and character_id = $2 and project_id = $3",
          [input.shotId, input.characterId, input.projectId],
        );
        throw exists.rows[0]
          ? new PrevisError("conflict", "This character's blocking was changed elsewhere. Reload first.")
          : new PrevisError("not_found", "That character has no blocking in this shot.");
      }
    });
  }

  async reanchorShotBlocking(input: {
    projectId: string;
    shotId: string;
    sceneDocumentId: string;
    userId: string | null;
    now: string;
  }) {
    return this.tx(async (c) => {
      const s = await c.query("select * from location_scene_documents where id = $1 and project_id = $2", [
        input.sceneDocumentId,
        input.projectId,
      ]);
      if (!s.rows[0]) throw new PrevisError("not_found", "That 3D set was not found.");
      const scene = mapScene(s.rows[0]);
      const r = await c.query(
        `update shot_character_blocking
            set revision = revision + 1, scene_revision = $3, scene_fingerprint = $4
          where shot_id = $1 and project_id = $2 and scene_document_id = $5
          returning *`,
        [input.shotId, input.projectId, scene.revision, scene.sceneFingerprint, scene.id],
      );
      return r.rows.map(mapBlocking);
    });
  }

  async listPrevisClips(shotId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from shot_previs_clips where shot_id = $1 order by rendered_at desc",
        [shotId],
      );
      return r.rows.map(mapClip);
    });
  }

  async getPrevisClip(id: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from shot_previs_clips where id = $1", [id]);
      return r.rows[0] ? mapClip(r.rows[0]) : null;
    });
  }

  async recordPrevisClip(input: NewPrevisClip) {
    return this.tx(async (c) => {
      const r = await c.query(
        `insert into shot_previs_clips
           (id, project_id, shot_id, location_id, camera_path_id, path_revision, path_fingerprint,
            scene_document_id, scene_revision, scene_fingerprint, asset_id, frame_rate, duration_ms,
            render_width, render_height, container, codec, has_audio, audio_asset_id, rendered_at,
            created_by, created_at, audio_mix_json, audio_mix_fingerprint, blocking_fingerprint, blocking_json)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$20,$22,$23,$24,$25::jsonb)
         returning *`,
        [
          input.id,
          input.projectId,
          input.shotId,
          input.locationId,
          input.cameraPathId,
          input.pathRevision,
          input.pathFingerprint,
          input.sceneDocumentId,
          input.sceneRevision,
          input.sceneFingerprint,
          input.assetId,
          input.frameRate,
          input.durationMs,
          input.renderWidth,
          input.renderHeight,
          input.container,
          input.codec,
          input.hasAudio,
          input.audioAssetId,
          input.renderedAt,
          input.userId,
          input.audioMix ? JSON.stringify(input.audioMix) : null,
          input.audioMixFingerprint,
          input.blockingFingerprint ?? null,
          input.blocking ? JSON.stringify(input.blocking) : null,
        ],
      );
      return mapClip(r.rows[0]);
    });
  }

  async listSpatialPassBundles(shotId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from shot_spatial_pass_bundles where shot_id = $1 order by created_at desc, id desc",
        [shotId],
      );
      return r.rows.map(mapBundle);
    });
  }

  async getSpatialPassBundle(id: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from shot_spatial_pass_bundles where id = $1", [id]);
      return r.rows[0] ? mapBundle(r.rows[0]) : null;
    });
  }

  async spatialPassUsesAsset(assetId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        `select 1 from shot_spatial_pass_bundles
          where depth_asset_id = $1 or object_id_asset_id = $1 or character_masks_json::text like '%' || $1::text || '%'
          limit 1`,
        [assetId],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }

  async listReconstructions(locationId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from location_spatial_reconstructions where location_id = $1 order by created_at desc, id desc",
        [locationId],
      );
      return r.rows.map(mapReconstruction);
    });
  }

  async getReconstruction(id: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from location_spatial_reconstructions where id = $1", [id]);
      return r.rows[0] ? mapReconstruction(r.rows[0]) : null;
    });
  }

  async reconstructionUsesAsset(assetId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        `select 1 from location_spatial_reconstructions
          where result_asset_id = $1 or source_assets_json @> jsonb_build_array(jsonb_build_object('assetId', $1::text))
          limit 1`,
        [assetId],
      );
      return r.rows.length > 0;
    });
  }

  async recordReconstruction(input: NewSpatialReconstruction) {
    return this.tx((c) => insertReconstruction(c, input));
  }

  async createReconstructionJob(input: NewReconstructionJob) {
    const rec = newJobRecord(input);
    return this.tx(async (c) => {
      try {
        const r = await c.query(
          `insert into reconstruction_jobs
             (id, project_id, location_id, schema_version, job_fingerprint, attempt, previous_job_id, provider,
              provider_capability, provider_model, requested_result_kind, source_assets_json, options_json, status,
              created_by, created_at, updated_at, cost_estimate_json)
           values ($1,$2,$3,'prism.reconstruction-job.v1',$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$15,
                   $16::jsonb)
           returning *`,
          [
            rec.id,
            rec.projectId,
            rec.locationId,
            rec.jobFingerprint,
            rec.attempt,
            rec.previousJobId,
            rec.provider,
            rec.capability,
            rec.model,
            rec.resultKind,
            JSON.stringify(rec.sources),
            JSON.stringify(rec.options),
            rec.status,
            input.userId,
            input.now,
            rec.costEstimate ? JSON.stringify(rec.costEstimate) : null,
          ],
        );
        return mapJob(r.rows[0]);
      } catch (e) {
        if ((e as { code?: string }).code === "23505")
          throw new PrevisError("conflict", "That reconstruction attempt already exists.");
        throw e;
      }
    });
  }

  async getReconstructionJob(id: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from reconstruction_jobs where id = $1", [id]);
      return r.rows[0] ? mapJob(r.rows[0]) : null;
    });
  }

  async listReconstructionJobs(locationId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from reconstruction_jobs where location_id = $1 order by created_at desc, id desc",
        [locationId],
      );
      return r.rows.map(mapJob);
    });
  }

  async updateReconstructionJob(id: string, expectedRevision: number, patch: JobPatch, now: string) {
    return this.tx(async (c) => {
      const cur = await c.query("select * from reconstruction_jobs where id = $1 for update", [id]);
      if (!cur.rows[0]) throw new PrevisError("not_found", "That reconstruction job no longer exists.");
      const job = mapJob(cur.rows[0]);
      if (job.revision !== expectedRevision)
        throw new PrevisError("conflict", "The reconstruction job changed in the meantime.");
      let next: ReconstructionJobRecord;
      try {
        next = applyJobPatch(job, patch, now);
      } catch (e) {
        if (e instanceof JobTransitionError) throw new PrevisError("invalid", e.message);
        throw e;
      }
      const r = await c.query(
        `update reconstruction_jobs set
            status = $3, progress = $4, revision = $5, provider_operation_id = $6, provider_operation_json = $7::jsonb,
            provider_inputs_json = $8::jsonb, provider_result_json = $9::jsonb, error_code = $10, error_message = $11,
            last_polled_at = $12, completed_at = $13, cost_actual_json = $14::jsonb
          where id = $1 and revision = $2
          returning *`,
        [
          id,
          expectedRevision,
          next.status,
          next.progress,
          next.revision,
          next.providerOperationId,
          next.providerOperation ? JSON.stringify(next.providerOperation) : null,
          next.providerInputs ? JSON.stringify(next.providerInputs) : null,
          next.providerResult ? JSON.stringify(next.providerResult) : null,
          next.errorCode,
          next.errorMessage,
          next.lastPolledAt,
          next.completedAt,
          next.actualCost ? JSON.stringify(next.actualCost) : null,
        ],
      );
      if (!r.rows[0]) throw new PrevisError("conflict", "The reconstruction job changed in the meantime.");
      return mapJob(r.rows[0]);
    });
  }

  async completeReconstructionJob(input: {
    jobId: string;
    expectedRevision: number;
    reconstruction: NewSpatialReconstruction;
    providerResult: Record<string, unknown> | null;
    now: string;
  }) {
    return this.tx(async (c) => {
      const cur = await c.query("select * from reconstruction_jobs where id = $1 for update", [input.jobId]);
      if (!cur.rows[0]) throw new PrevisError("not_found", "That reconstruction job no longer exists.");
      const job = mapJob(cur.rows[0]);
      if (job.revision !== input.expectedRevision || job.status !== "ingesting")
        throw new PrevisError("conflict", "The reconstruction job changed in the meantime.");
      if (input.reconstruction.generation?.jobId !== job.id)
        throw new PrevisError("invalid", "The reconstruction does not belong to this job.");
      // one transaction: the reconstruction row and the job's success are committed together or not at all
      const reconstruction = await insertReconstruction(c, input.reconstruction);
      const r = await c.query(
        `update reconstruction_jobs set status = 'succeeded', progress = 1, revision = revision + 1,
            provider_result_json = $3::jsonb, result_reconstruction_id = $4, completed_at = $5
          where id = $1 and revision = $2 and status = 'ingesting'
          returning *`,
        [
          job.id,
          input.expectedRevision,
          input.providerResult ? JSON.stringify(sanitizeProviderPayload(input.providerResult)) : null,
          reconstruction.id,
          input.now,
        ],
      );
      if (!r.rows[0]) throw new PrevisError("conflict", "The reconstruction job changed in the meantime.");
      return { job: mapJob(r.rows[0]), reconstruction };
    });
  }

  async appendReconstructionJobEvent(input: {
    projectId: string;
    jobId: string;
    event: JobEvent;
    detail: Record<string, unknown>;
    now: string;
  }) {
    await this.tx(async (c) => {
      await c.query(
        `insert into reconstruction_job_events (project_id, job_id, event, detail_json, created_at)
         values ($1,$2,$3,$4::jsonb,$5)`,
        [
          input.projectId,
          input.jobId,
          input.event,
          JSON.stringify(sanitizeProviderPayload(input.detail) ?? {}),
          input.now,
        ],
      );
    });
  }

  async listReconstructionJobEvents(jobId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from reconstruction_job_events where job_id = $1 order by created_at, id",
        [jobId],
      );
      return r.rows.map((x): JobEventRecord => ({
        id: String(x.id),
        jobId: String(x.job_id),
        event: x.event as JobEvent,
        detail: (x.detail_json as Record<string, unknown>) ?? {},
        createdAt: iso(x.created_at),
      }));
    });
  }

  async recordSpatialPassBundle(input: NewSpatialPassBundle) {
    return this.tx(async (c) => {
      const dup = await c.query(
        "select * from shot_spatial_pass_bundles where shot_id = $1 and bundle_fingerprint = $2",
        [input.shotId, input.bundleFingerprint],
      );
      if (dup.rows[0]) return { record: mapBundle(dup.rows[0]), existing: true };
      const cam = input.camera;
      const isPath = cam.kind === "camera_path";
      const r = await c.query(
        `insert into shot_spatial_pass_bundles
           (id, project_id, shot_id, location_id, scene_document_id, scene_revision, scene_fingerprint,
            blocking_fingerprint, camera_source, camera_json, camera_path_id, camera_path_revision,
            camera_path_fingerprint, time_ms, schema_version, bundle_fingerprint, width, height,
            depth_asset_id, depth_encoding, depth_metadata_json, object_id_asset_id, object_id_encoding,
            object_manifest_json, character_masks_json, created_by, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22,$23,
                 $24::jsonb,$25::jsonb,$26,$27)
         returning *`,
        [
          input.id,
          input.projectId,
          input.shotId,
          input.locationId,
          input.sceneDocumentId,
          input.sceneRevision,
          input.sceneFingerprint,
          input.blockingFingerprint,
          cam.kind,
          JSON.stringify(cam),
          isPath ? cam.cameraPathId : null,
          isPath ? cam.cameraPathRevision : null,
          isPath ? cam.cameraPathFingerprint : null,
          isPath ? cam.timeMs : null,
          SPATIAL_PASS_BUNDLE_SCHEMA,
          input.bundleFingerprint,
          input.width,
          input.height,
          input.depth.assetId,
          input.depth.encoding,
          JSON.stringify(input.depth.metadata),
          input.objectIds.assetId,
          input.objectIds.encoding,
          JSON.stringify(input.objectIds.manifest),
          JSON.stringify(input.characterMasks),
          input.userId,
          input.createdAt,
        ],
      );
      return { record: mapBundle(r.rows[0]), existing: false };
    });
  }
}

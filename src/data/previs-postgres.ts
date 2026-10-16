import type { Pool, PoolClient } from "pg";
import { pickCurrentClip, type StoredAudioMix } from "@/domain/previs/audio-mix";
import { bookmarkFromCamera } from "@/domain/previs/camera";
import { cameraPathFingerprint, cameraPathSchema, validateCameraPath } from "@/domain/previs/camera-path";
import { sceneFingerprint } from "@/domain/previs/document";
import {
  buildSpatialReference,
  CAMERA_MOTION_SCHEMA_VERSION,
  type CameraMotionReference,
  type SpatialReference,
} from "@/domain/previs/spatial";
import { cameraBookmarkSchema, previsDocumentSchema } from "@/domain/previs/types";
import {
  PrevisError,
  type AudioMixResolver,
  type CameraBookmarkRecord,
  type CameraPathRecord,
  type MasterFrameRecord,
  type NewMasterFrame,
  type NewPrevisClip,
  type PrevisClipRecord,
  type SaveCameraPathInput,
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
  createdBy: str(r.created_by),
  createdAt: iso(r.created_at),
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
  renderedAt: iso(r.rendered_at),
  createdBy: str(r.created_by),
  createdAt: iso(r.created_at),
});

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
      const out: Record<string, SpatialReference> = {};
      if (b.rows.length === 0 && p.rows.length === 0) return out;
      const bookmarks = new Map(b.rows.map((r) => [String(r.shot_id), mapBookmark(r)]));
      const paths = new Map(p.rows.map((r) => [String(r.shot_id), mapPath(r)]));
      const sceneIds = [...new Set([...b.rows, ...p.rows].map((r) => String(r.scene_document_id)))];
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
      const k = await c.query(
        `select shot_id, path_fingerprint, asset_id, has_audio, audio_mix_fingerprint, rendered_at
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
          renderedAt: iso(r.rendered_at),
        });
        clipsByShot.set(String(r.shot_id), list);
      }
      for (const shotId of new Set([...bookmarks.keys(), ...paths.keys()])) {
        const bm = bookmarks.get(shotId) ?? null;
        const path = paths.get(shotId) ?? null;
        const scene = scenes.get((bm?.sceneDocumentId ?? path?.sceneDocumentId) as string);
        if (!scene) continue;
        const clip = path
          ? pickCurrentClip(
              clipsByShot.get(shotId) ?? [],
              path.pathFingerprint,
              currentAudioMix?.(shotId, path.durationMs) ?? null,
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
            created_by, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$13) returning *`,
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
            created_by, created_at, audio_mix_json, audio_mix_fingerprint)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$20,$22,$23)
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
        ],
      );
      return mapClip(r.rows[0]);
    });
  }
}

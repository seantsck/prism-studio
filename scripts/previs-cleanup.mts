// Removes 3D-set test data from the dev user's projects: scene documents, shot camera bookmarks, master frames,
// camera paths, shot character blocking, spatial control-pass bundles, previs clips, their render assets (and stored files) and the storyboard frames created by
// "Use as Master Frame".
//   npx tsx --env-file=.env.local scripts/previs-cleanup.mts --yes          delete
//   npx tsx --env-file=.env.local scripts/previs-cleanup.mts --report       print provenance of master frames (JSON)
//   npx tsx --env-file=.env.local scripts/previs-cleanup.mts --report-clips  print provenance of previs clips (JSON)
//   npx tsx --env-file=.env.local scripts/previs-cleanup.mts --report-blocking  print stored shot character blocking (JSON)
//   npx tsx --env-file=.env.local scripts/previs-cleanup.mts --report-passes  print spatial control-pass bundles (JSON)
// Development/test tidy-up only. Never touches rows outside the dev user's own projects.
import pg from "pg";
import { createOutputSink } from "../src/generation/sink";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
const report = process.argv.includes("--report");
const reportClips = process.argv.includes("--report-clips");
const reportBlocking = process.argv.includes("--report-blocking");
const reportPasses = process.argv.includes("--report-passes");
if (!report && !reportClips && !reportBlocking && !reportPasses)
  startScript({
    mode: "3D set cleanup (deletes scene documents, bookmarks, master frames)",
    devOwner: dev.id,
  });
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 2 });
await assertDevUserExists(pool, dev);

if (process.argv.includes("--report-jobs")) {
  const rows = await pool.query(
    `select j.id, j.location_id, j.status, j.attempt, j.provider, j.provider_capability, j.provider_model,
            j.provider_operation_id, j.provider_operation_json, j.provider_inputs_json, j.provider_result_json,
            j.source_assets_json, j.result_reconstruction_id, j.error_code, j.revision,
            (select count(*)::int from reconstruction_job_events e where e.job_id = j.id) as events,
            (select jsonb_build_object('method', r.method, 'job_id', r.job_id, 'provider', r.provider,
                     'provider_operation_id', r.provider_operation_id, 'result_asset_id', r.result_asset_id,
                     'source_assets_json', r.source_assets_json, 'calibration_json', r.calibration_json,
                     'asset', (select jsonb_build_object('type', a.type, 'purpose', a.purpose, 'source', a.source,
                                'mime', a.mime, 'bucket', a.bucket, 'object_path', a.object_path, 'checksum', a.checksum,
                                'bucket_public', (select public from storage.buckets bk where bk.id = a.bucket))
                               from assets a where a.id = r.result_asset_id))
               from location_spatial_reconstructions r where r.id = j.result_reconstruction_id) as reconstruction
       from reconstruction_jobs j
       join projects p on p.id = j.project_id
      where p.user_id = $1 order by j.created_at`,
    [dev.id],
  );
  console.log(JSON.stringify(rows.rows));
  await pool.end();
  process.exit(0);
}

if (process.argv.includes("--report-reconstructions")) {
  const rows = await pool.query(
    `select r.id, r.location_id, r.method, r.result_kind, r.result_asset_id, r.result_checksum, r.result_format,
            r.gaussian_count, r.source_assets_json, r.calibration_json, r.reconstruction_fingerprint, r.created_at,
            (select jsonb_build_object('type', a.type, 'purpose', a.purpose, 'source', a.source, 'mime', a.mime,
                      'byte_size', a.byte_size, 'bucket', a.bucket, 'object_path', a.object_path, 'checksum', a.checksum,
                      'bucket_public', (select public from storage.buckets bk where bk.id = a.bucket))
               from assets a where a.id = r.result_asset_id) as result_asset
       from location_spatial_reconstructions r
       join projects p on p.id = r.project_id
      where p.user_id = $1 order by r.created_at`,
    [dev.id],
  );
  console.log(JSON.stringify(rows.rows));
  await pool.end();
  process.exit(0);
}

if (reportPasses) {
  const rows = await pool.query(
    `select b.id, b.shot_id, b.location_id, b.scene_document_id, b.scene_revision, b.scene_fingerprint,
            b.blocking_fingerprint, b.camera_source, b.camera_path_id, b.camera_path_revision, b.camera_path_fingerprint,
            b.time_ms, b.bundle_fingerprint, b.width, b.height, b.depth_asset_id, b.depth_encoding, b.depth_metadata_json,
            b.object_id_asset_id, b.object_id_encoding, b.object_manifest_json, b.character_masks_json, b.created_at,
            (select scene_fingerprint from location_scene_documents d where d.id = b.scene_document_id) as live_scene_fingerprint,
            (select jsonb_build_object('type', a.type, 'purpose', a.purpose, 'source', a.source, 'mime', a.mime, 'byte_size', a.byte_size,
                      'bucket', a.bucket, 'object_path', a.object_path, 'checksum', a.checksum,
                      'bucket_public', (select public from storage.buckets bk where bk.id = a.bucket))
               from assets a where a.id = b.depth_asset_id) as depth_asset,
            (select jsonb_build_object('type', a.type, 'purpose', a.purpose, 'mime', a.mime, 'byte_size', a.byte_size,
                      'object_path', a.object_path)
               from assets a where a.id = b.object_id_asset_id) as object_id_asset,
            (select coalesce(jsonb_agg(jsonb_build_object('type', a.type, 'purpose', a.purpose, 'mime', a.mime, 'byte_size', a.byte_size,
                      'object_path', a.object_path)), '[]'::jsonb)
               from assets a
              where a.id::text in (select m.value ->> 'assetId' from jsonb_each(b.character_masks_json -> 'masks') m)) as mask_assets
       from shot_spatial_pass_bundles b
       join projects p on p.id = b.project_id
      where p.user_id = $1 order by b.created_at`,
    [dev.id],
  );
  console.log(JSON.stringify(rows.rows));
  await pool.end();
  process.exit(0);
}

if (reportBlocking) {
  const rows = await pool.query(
    `select b.id, b.shot_id, b.character_id, b.location_id, b.scene_document_id, b.scene_revision, b.scene_fingerprint,
            b.schema_version, b.rig_version, b.revision, b.root_position, b.root_orientation, b.root_scale::float as root_scale,
            b.pose_json, b.visible, b.pose_fingerprint, b.blocking_fingerprint,
            (select scene_fingerprint from location_scene_documents d where d.id = b.scene_document_id) as live_scene_fingerprint
       from shot_character_blocking b
       join projects p on p.id = b.project_id
      where p.user_id = $1 order by b.created_at`,
    [dev.id],
  );
  console.log(JSON.stringify(rows.rows));
  await pool.end();
  process.exit(0);
}

if (reportClips) {
  const rows = await pool.query(
    `select c.id, c.asset_id, c.path_revision, c.path_fingerprint, c.scene_revision, c.scene_fingerprint,
            c.frame_rate::float as frame_rate, c.duration_ms, c.render_width, c.render_height, c.container, c.codec,
            c.has_audio, c.audio_asset_id, c.audio_mix_fingerprint, c.audio_mix_json, c.blocking_fingerprint, c.blocking_json, c.source, a.bucket, a.object_path, a.source as asset_source, a.purpose as asset_purpose,
            a.type as asset_type, a.mime, a.byte_size, a.metadata->'previs' as provenance,
            (select public from storage.buckets b where b.id = a.bucket) as bucket_public
       from shot_previs_clips c
       join projects p on p.id = c.project_id
       join assets a on a.id = c.asset_id
      where p.user_id = $1 order by c.rendered_at desc`,
    [dev.id],
  );
  console.log(JSON.stringify(rows.rows));
  await pool.end();
  process.exit(0);
}

if (report) {
  const rows = await pool.query(
    `select f.id, f.asset_id, f.scene_revision, f.scene_fingerprint, f.camera_bookmark_id, f.render_width,
            f.render_height, f.production_aspect_ratio, f.source, f.adopted_at is not null as adopted,
            f.adopted_frame_id, f.blocking_fingerprint, f.blocking_json, a.bucket, a.object_path, a.source as asset_source, a.purpose as asset_purpose,
            a.width as asset_width, a.height as asset_height, a.mime, a.metadata->'previs' as provenance,
            (select public from storage.buckets b where b.id = a.bucket) as bucket_public
       from scene_master_frames f
       join projects p on p.id = f.project_id
       join assets a on a.id = f.asset_id
      where p.user_id = $1 order by f.captured_at desc`,
    [dev.id],
  );
  console.log(JSON.stringify(rows.rows));
  await pool.end();
  process.exit(0);
}

// E2E reference images uploaded by a reconstruction-job test (names start with the given e2e- prefix)
const prefixArg = process.argv.find((a) => a.startsWith("--e2e-assets-prefix="))?.split("=")[1] ?? "";
const e2ePrefix = /^e2e-[a-z0-9-]+$/i.test(prefixArg) ? prefixArg : "(no e2e prefix)";
const assets = (
  await pool.query(
    `select a.id, a.object_path from assets a join projects p on p.id = a.project_id
      where p.user_id = $1
        and (
          -- images an e2e test uploaded, named by its own e2e- prefix (these may be pinned by the test's own frames)
          (a.source in ('upload', 'storyboard') and a.name like $2 || '%')
          -- 3D-set tidy-up: but never an image a user's Production Frame pins (a promoted Master Frame keeps its image)
          or ((   (a.source = '3d_render' and 'master_frame' = any(a.tags))
               or (a.source = '3d_render' and 'spatial_pass' = any(a.tags))
               or (a.source = 'import' and 'gaussian_splat' = any(a.tags))
               or (a.source = 'provider_output' and 'gaussian_splat' = any(a.tags))
               or (a.source = 'local_previs' and 'previs' = any(a.tags)))
              and not exists (select 1 from shot_production_frames pf where pf.asset_id = a.id)
              -- nor one a Location View pins (Phase 2G.3: a Master Frame may have become a canonical view)
              and not exists (select 1 from location_views lv where lv.asset_id = a.id)))`,
    [dev.id, e2ePrefix],
  )
).rows;
const frameRows = (
  await pool.query(
    `select f.id, f.shot_id from storyboard_frames f join projects p on p.id = f.project_id
      where p.user_id = $1
        and ((f.source = '3d_preview' and f.notes like '3D set master frame%')
          -- storyboard frames an e2e test uploaded (named by the same e2e- prefix as its image)
          or exists (select 1 from assets a where a.id = f.asset_id and a.source = 'storyboard' and a.name like $2 || '%'))`,
    [dev.id, e2ePrefix],
  )
).rows;
const frames = frameRows.map((r) => String(r.id));
// Phase 2G.1: Production Frames pin their image (and so cannot be dropped with it). The asset list above holds only
// e2e-prefixed images plus 3D-set artefacts NOT pinned by any frame, so the frames deleted below are exactly the e2e
// test's own: a user's legitimate Production Frame is never in this set.
const assetIdsForPf = assets.map((a) => String(a.id));
const productionFrames = assetIdsForPf.length
  ? (
      await pool.query(
        "select count(*)::int n from shot_production_frames where asset_id = any($1::uuid[])",
        [assetIdsForPf],
      )
    ).rows[0].n
  : 0;
const counts = (
  await pool.query(
    `select (select count(*)::int from location_scene_documents d join projects p on p.id = d.project_id where p.user_id = $1) as scenes,
            (select count(*)::int from shot_camera_bookmarks b join projects p on p.id = b.project_id where p.user_id = $1) as bookmarks,
            (select count(*)::int from shot_camera_paths c join projects p on p.id = c.project_id where p.user_id = $1) as paths,
            (select count(*)::int from shot_previs_clips c join projects p on p.id = c.project_id where p.user_id = $1) as clips,
            (select count(*)::int from shot_character_blocking c join projects p on p.id = c.project_id where p.user_id = $1) as blocking,
            (select count(*)::int from shot_spatial_pass_bundles c join projects p on p.id = c.project_id where p.user_id = $1) as bundles,
            (select count(*)::int from location_spatial_reconstructions c join projects p on p.id = c.project_id where p.user_id = $1) as reconstructions,
            (select count(*)::int from reconstruction_jobs c join projects p on p.id = c.project_id where p.user_id = $1) as jobs`,
    [dev.id],
  )
).rows[0];
console.log(
  `scenes: ${counts.scenes}, bookmarks: ${counts.bookmarks}, camera paths: ${counts.paths}, previs clips: ${counts.clips}, character blocking: ${counts.blocking}, spatial pass bundles: ${counts.bundles}, reconstructions: ${counts.reconstructions}, reconstruction jobs: ${counts.jobs}, previs/master-frame/spatial-pass/splat assets: ${assets.length}, storyboard frames: ${frames.length}, production frames: ${productionFrames}`,
);
if (!process.argv.includes("--yes")) {
  console.log("dry run; pass --yes to delete");
  await pool.end();
  process.exit(0);
}

// Production Frames and Location Views are append-only for users; this maintenance tool runs as the database owner.
// Only views of the images in the list above (the e2e test's own uploads) are removed; selections cascade.
if (assetIdsForPf.length)
  await pool.query("delete from location_views where asset_id = any($1::uuid[])", [assetIdsForPf]);
if (assetIdsForPf.length) {
  await pool.query(
    `delete from shot_production_frame_selections where production_frame_id in
       (select id from shot_production_frames where asset_id = any($1::uuid[]))`,
    [assetIdsForPf],
  );
  await pool.query("delete from shot_production_frames where asset_id = any($1::uuid[])", [assetIdsForPf]);
}
if (frames.length) {
  await pool.query("delete from storyboard_frames where id = any($1::uuid[])", [frames]);
  // a shot whose only approved storyboard frame was removed no longer claims a storyboard approval
  await pool.query(
    `update shots s set approval_storyboard = false
      where s.id = any($1::uuid[]) and s.approval_storyboard
        and not exists (select 1 from storyboard_frames f where f.shot_id = s.id and f.approved)`,
    [[...new Set(frameRows.map((r) => String(r.shot_id)))]],
  );
}
// previs clips and master frames reference assets (no cascade): remove them with their scenes first
await pool.query(
  `delete from shot_spatial_pass_bundles where project_id in (select id from projects where user_id = $1)`,
  [dev.id],
);
// jobs and generated reconstructions reference each other: delete both in ONE statement (FKs checked at its end)
await pool.query(
  `with jobs as (delete from reconstruction_jobs where project_id in (select id from projects where user_id = $1))
   delete from location_spatial_reconstructions where project_id in (select id from projects where user_id = $1)`,
  [dev.id],
);
await pool.query(
  `delete from shot_previs_clips where project_id in (select id from projects where user_id = $1)`,
  [dev.id],
);
await pool.query(
  `delete from shot_character_blocking where project_id in (select id from projects where user_id = $1)`,
  [dev.id],
);
await pool.query(
  `delete from shot_camera_paths where project_id in (select id from projects where user_id = $1)`,
  [dev.id],
);
await pool.query(
  `delete from scene_master_frames where project_id in (select id from projects where user_id = $1)`,
  [dev.id],
);
await pool.query(
  `delete from location_scene_documents where project_id in (select id from projects where user_id = $1)`,
  [dev.id],
);
if (assets.length) {
  await pool.query("delete from assets where id = any($1::uuid[])", [assets.map((a) => a.id)]);
  try {
    const sinkEnv = { ...process.env };
    sinkEnv.PRISM_STUDIO_WORKER_DEV_STORAGE ??= "1"; // maintenance tool, development only
    const sink = await createOutputSink(sinkEnv, "supabase");
    for (const a of assets)
      if (a.object_path) await sink.remove(String(a.object_path)).catch(() => undefined);
  } catch (err) {
    console.log(`storage objects not removed (${(err as Error).name}); they are unreferenced and harmless`);
  }
}
console.log("done");
await pool.end();

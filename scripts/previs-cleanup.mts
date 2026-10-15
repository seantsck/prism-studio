// Removes 3D-set test data from the dev user's projects: scene documents, shot camera bookmarks, master frames,
// their render assets (and stored files) and the storyboard frames created by "Use as Master Frame".
//   npx tsx --env-file=.env.local scripts/previs-cleanup.mts --yes          delete
//   npx tsx --env-file=.env.local scripts/previs-cleanup.mts --report       print provenance of master frames (JSON)
// Development/test tidy-up only. Never touches rows outside the dev user's own projects.
import pg from "pg";
import { createOutputSink } from "../src/generation/sink";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
const report = process.argv.includes("--report");
if (!report)
  startScript({
    mode: "3D set cleanup (deletes scene documents, bookmarks, master frames)",
    devOwner: dev.id,
  });
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 2 });
await assertDevUserExists(pool, dev);

if (report) {
  const rows = await pool.query(
    `select f.id, f.asset_id, f.scene_revision, f.scene_fingerprint, f.camera_bookmark_id, f.render_width,
            f.render_height, f.production_aspect_ratio, f.source, f.adopted_at is not null as adopted,
            f.adopted_frame_id, a.bucket, a.object_path, a.source as asset_source, a.purpose as asset_purpose,
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

const assets = (
  await pool.query(
    `select a.id, a.object_path from assets a join projects p on p.id = a.project_id
      where p.user_id = $1 and a.source = '3d_render' and 'master_frame' = any(a.tags)`,
    [dev.id],
  )
).rows;
const frames = (
  await pool.query(
    `select f.id from storyboard_frames f join projects p on p.id = f.project_id
      where p.user_id = $1 and f.source = '3d_preview' and f.notes like '3D set master frame%'`,
    [dev.id],
  )
).rows.map((r) => String(r.id));
const counts = (
  await pool.query(
    `select (select count(*)::int from location_scene_documents d join projects p on p.id = d.project_id where p.user_id = $1) as scenes,
            (select count(*)::int from shot_camera_bookmarks b join projects p on p.id = b.project_id where p.user_id = $1) as bookmarks`,
    [dev.id],
  )
).rows[0];
console.log(
  `scenes: ${counts.scenes}, bookmarks: ${counts.bookmarks}, master-frame assets: ${assets.length}, storyboard frames: ${frames.length}`,
);
if (!process.argv.includes("--yes")) {
  console.log("dry run; pass --yes to delete");
  await pool.end();
  process.exit(0);
}

if (frames.length) await pool.query("delete from storyboard_frames where id = any($1::uuid[])", [frames]);
// scene_master_frames reference assets (no cascade): remove them with their scenes first
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

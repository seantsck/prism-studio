// Idempotent, ref-guarded bucket setup: the same upsert that migration 0010 performs, for re-asserting the
// private `prism-assets` bucket settings (never public) without a migration. Safe to re-run.
//   npm run db:storage:setup
import pg from "pg";
import { startScript } from "./lib/safety.mjs";

const url = startScript({ mode: "storage setup (upserts bucket prism-assets, private)" });
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query("begin");
  const r = await client.query(
    `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
     values ('prism-assets', 'prism-assets', false, 52428800, array[
       'image/png','image/jpeg','image/webp','image/gif','image/avif',
       'audio/wav','audio/x-wav','audio/wave','audio/mpeg','audio/mp3','audio/mp4','audio/aac','audio/ogg','audio/flac','audio/webm','audio/x-m4a',
       'video/mp4','video/webm','video/quicktime',
       'application/pdf','text/plain','application/json','model/gltf-binary'])
     on conflict (id) do update
       set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types
     returning id, public, file_size_limit`,
  );
  await client.query("commit");
  console.log("bucket:", r.rows[0]);
} catch (err) {
  await client.query("rollback").catch(() => undefined);
  throw err;
} finally {
  await client.end();
}

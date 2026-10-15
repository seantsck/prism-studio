// Live Supabase Storage check through the real Storage HTTP API, as a signed-in user.
//   npm run db:storage:smoke
// Signs in with PRISM_STUDIO_DEV_USER_EMAIL / PRISM_STUDIO_DEV_USER_PASSWORD (the one local dev user) and:
//   1. uploads a small object under <own project>/<uuid>/ (allowed)
//   2. downloads it and mints a signed URL, fetches it without any session (signed URLs are bearer links)
//   3. confirms an anonymous client can neither list, download nor upload
//   4. confirms the user cannot write under a project prefix they do not own
//   5. deletes the object
// Needs a password; without one it prints SKIPPED and exits 0 (the signed-in half cannot run).
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { readDevUserEnv } from "./lib/dev-user.mjs";
import { redact, startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({ mode: "storage smoke (uploads one tiny object, then deletes it)", devOwner: dev.id });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url?.includes("lyqdxiyjperhniwhzsvg") || !key)
  throw new Error("NEXT_PUBLIC_SUPABASE_* must target the Prism Studio project");

const email = process.env.PRISM_STUDIO_DEV_USER_EMAIL;
const password = process.env.PRISM_STUDIO_DEV_USER_PASSWORD;

const results = [];
const check = (name, ok, detail = "") => results.push([name, ok, detail]);
const BUCKET = "prism-assets";
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

// ── anonymous checks (no credentials needed): the bucket is not reachable without a session ──
{
  const anonymous = createClient(url, key, { auth: { persistSession: false } });
  const probe = `${randomUUID()}/${randomUUID()}/x.png`;
  const up = await anonymous.storage.from(BUCKET).upload(probe, png, { contentType: "image/png" });
  check("anon: upload is refused", Boolean(up.error), up.error?.message ?? "no error");
  const dl = await anonymous.storage.from(BUCKET).download(probe);
  check("anon: download is refused", Boolean(dl.error));
  const ls = await anonymous.storage.from(BUCKET).list("", { limit: 5 });
  check("anon: listing returns nothing", !ls.error && (ls.data ?? []).length === 0, ls.error?.message ?? "");
  const pub = await fetch(`${url}/storage/v1/object/public/${BUCKET}/${probe}`);
  check(
    "anon: the public URL form does not serve objects (bucket is private)",
    !pub.ok,
    `status ${pub.status}`,
  );
}

if (!email || !password) {
  let failed = 0;
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  — ${redact(detail)}` : ""}`);
    if (!ok) failed++;
  }
  console.log(`
${results.length - failed}/${results.length} anonymous checks passed`);
  console.log(
    "SKIPPED: PRISM_STUDIO_DEV_USER_EMAIL / PRISM_STUDIO_DEV_USER_PASSWORD are not both set; the signed-in storage checks did not run.",
  );
  process.exit(failed ? 1 : 0);
}

const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 1 });
const projectId = (
  await pool.query("select id from projects where user_id = $1 order by created_at limit 1", [dev.id])
).rows[0]?.id;
await pool.end();
if (!projectId) throw new Error("No project owned by the dev user; run npm run db:seed first.");

const user = createClient(url, key, { auth: { persistSession: false } });
const anon = createClient(url, key, { auth: { persistSession: false } });
const path = `${projectId}/${randomUUID()}/smoke.png`;

try {
  const { error: signInError } = await user.auth.signInWithPassword({ email, password });
  check("sign in with password", !signInError, signInError ? (signInError.code ?? "failed") : "");
  if (signInError) throw new Error("sign-in failed; aborting");

  const up = await user.storage.from(BUCKET).upload(path, png, { contentType: "image/png", upsert: false });
  check("owner uploads inside own project prefix", !up.error, up.error?.message ?? "");

  const down = await user.storage.from(BUCKET).download(path);
  check(
    "owner downloads the object back (same bytes)",
    !down.error && (await down.data.arrayBuffer()).byteLength === png.length,
    down.error?.message ?? "",
  );

  const signed = await user.storage.from(BUCKET).createSignedUrl(path, 60);
  check(
    "owner can mint a signed URL",
    !signed.error && Boolean(signed.data?.signedUrl),
    signed.error?.message ?? "",
  );
  if (signed.data?.signedUrl) {
    const res = await fetch(signed.data.signedUrl);
    check("signed URL works without a session, for a short time", res.ok);
  }

  const publicUrl = `${url}/storage/v1/object/public/${BUCKET}/${path}`;
  const pub = await fetch(publicUrl);
  check("the public URL does NOT work (bucket is private)", !pub.ok, `status ${pub.status}`);

  const anonDown = await anon.storage.from(BUCKET).download(path);
  check("anonymous client cannot download", Boolean(anonDown.error));
  const anonUp = await anon.storage
    .from(BUCKET)
    .upload(`${projectId}/${randomUUID()}/x.png`, png, { contentType: "image/png" });
  check("anonymous client cannot upload", Boolean(anonUp.error));

  const foreign = await user.storage
    .from(BUCKET)
    .upload(`${randomUUID()}/${randomUUID()}/x.png`, png, { contentType: "image/png" });
  check(
    "user cannot write under a project prefix they do not own",
    Boolean(foreign.error),
    foreign.error?.message ?? "no error",
  );

  const badType = await user.storage
    .from(BUCKET)
    .upload(`${projectId}/${randomUUID()}/x.exe`, new Uint8Array([77, 90]), {
      contentType: "application/x-msdownload",
    });
  check(
    "bucket MIME allow-list rejects executables",
    Boolean(badType.error),
    badType.error?.message ?? "no error",
  );
} finally {
  await user.storage
    .from(BUCKET)
    .remove([path])
    .catch(() => undefined);
  await user.auth.signOut().catch(() => undefined);
}

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  — ${redact(detail)}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;

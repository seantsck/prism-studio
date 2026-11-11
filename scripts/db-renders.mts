// Integration tests for Phase 5B-V4 Episode renders against the REAL dedicated Prism Studio database (migration 0059:
// episode_renders, render_segment_cache, the 'episode_render' Asset purpose, the prism_render_worker role).
//   npm run db:renders
//
// Everything runs in ONE THROWAWAY project (purpose 'test') owned by the dev user, deleted at the end (the delete is
// under test: it cascades through renders and the cache). Exercises: structure + owner-only RLS (owner / stranger /
// anon); the database guards (frozen inputs, the lifecycle, the owner's narrow rights, a completed render is history);
// the render WORKER as the least-privilege role (`set local role prism_render_worker`): claim, progress, the segment
// cache, a REAL ffmpeg render of a small manifest through PostgresRenderWorkerStore into a verified MP4 Asset, what the
// role can NOT do (other tables, other purposes, terminal renders, retries); retry = the same render. Media goes to a
// temporary local disk store; no provider call.
//
// Requires migration 0059 to be APPLIED: the suite refuses to start (and writes nothing) when it is not.
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { rlsPreamble } from "../src/data/postgres-repository";
import { buildRenderManifest, manifestFingerprint } from "../src/domain/edit/render-manifest";
import type { EpisodeEdit } from "../src/domain/edit/model";
import type { ProjectData } from "../src/domain/schemas";
import { LocalDiskSink } from "../src/generation/sink";
import { buildRenderPlan } from "../src/render/plan";
import { PostgresEpisodeRenderData, PostgresRenderWorkerStore } from "../src/render/postgres";
import { deliveryProfile } from "../src/render/profile";
import { RenderError } from "../src/render/repository";
import { EpisodeRenderWorker } from "../src/render/worker";
import { mockClipBytes, stillPng } from "../src/render/__tests__/render-fixtures";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import {
  auditRenderWorkerRole,
  provisionRenderWorkerLogin,
  RENDER_WORKER_ROLE,
} from "./lib/render-worker-role";
import { disposableLocalTarget, startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({
  mode: "episode render integration tests (throwaway project, removed afterwards)",
  devOwner: dev.id,
});
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 6 });
await assertDevUserExists(pool, dev);
if (!(await pool.query("select to_regclass('public.episode_renders') as t")).rows[0].t) {
  console.error("Migration 0059 is not applied to this database; db:renders needs it. Nothing was written.");
  await pool.end();
  process.exit(1);
}

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const q = (sql: string, p: unknown[] = []) => pool.query(sql, p);
const stranger = randomUUID();
async function as(preamble: string, sql: string, p: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query(preamble);
    const r = await c.query(sql, p);
    await c.query("commit");
    return { rows: r.rows, rowCount: r.rowCount ?? 0, error: null as string | null };
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    return { rows: [], rowCount: 0, error: (e as Error).message };
  } finally {
    c.release();
  }
}
const OWNER = rlsPreamble({ sub: dev.id });
const STRANGER = rlsPreamble({ sub: stranger });
const ANON = rlsPreamble(null, "anon");
const WORKER = "begin; set local role prism_render_worker";
const owner = new PostgresEpisodeRenderData(pool, OWNER);
const strangerRepo = new PostgresEpisodeRenderData(pool, STRANGER);
const store = new PostgresRenderWorkerStore(pool, WORKER);
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof RenderError ? e.code : `other: ${(e as Error).message}`),
  );

const P = randomUUID();
const E = randomUUID();
const slug = `db-rn-${P.slice(0, 8)}`;
const mediaRoot = mkdtempSync(path.join(tmpdir(), "prism-db-renders-"));
const sink = new LocalDiskSink(mediaRoot);
let cleanup = true;
try {
  // ── fixtures: a project, an Episode, two real media Assets (a mock clip and a still) ──
  await q("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,'db:renders','test')", [
    P,
    dev.id,
    slug,
  ]);
  await q("insert into project_bibles (project_id, aspect_ratio) values ($1, '2.39:1')", [P]).catch(
    async () => q("insert into project_bibles (project_id) values ($1)", [P]),
  );
  await q(
    "insert into episodes (id, project_id, number, slug, title) values ($1,$2,1,'ep-1','The Arrangement')",
    [E, P],
  );
  const media = async (bytes: Uint8Array, type: "video" | "image", ext: string, mime: string) => {
    const id = randomUUID();
    const objectPath = `${P}/${id}/db-renders.${ext}`;
    await sink.put(objectPath, bytes);
    await q(
      `insert into assets (id, project_id, name, type, purpose, source, storage_provider, object_path, mime, checksum,
         width, height, duration_ms, metadata)
       values ($1,$2,'db:renders',$3,$4,'upload','local',$5,$6,$7,$8,$9,$10,'{}'::jsonb)`,
      [
        id,
        P,
        type,
        type === "video" ? "generation_output" : "production_frame",
        objectPath,
        mime,
        sha(bytes),
        type === "video" ? 192 : 640,
        type === "video" ? 108 : 360,
        type === "video" ? 5000 : null,
      ],
    );
    return id;
  };
  const clip = await media(mockClipBytes(), "video", "webm", "video/webm");
  const still = await media(stillPng(), "image", "png", "image/png");
  const data = {
    assets: [
      { id: clip, checksum: sha(mockClipBytes()), mime: "video/webm", objectPath: "x" },
      {
        id: still,
        checksum: (await q("select checksum from assets where id = $1", [still])).rows[0].checksum,
        mime: "image/png",
        objectPath: "x",
      },
    ],
    productionFrames: [{ id: "pf", assetId: still }],
    frames: [],
    shots: [
      { id: "s1", shotCode: "1A" },
      { id: "s2", shotCode: "1B" },
    ],
    takes: [],
    bible: { aspectRatio: "2.39:1", deliveryWidth: null, deliveryHeight: null },
  } as unknown as ProjectData;
  const edit: EpisodeEdit = {
    id: randomUUID(),
    projectId: P,
    episodeId: E,
    editRate: { num: 24, den: 1 },
    revision: 3,
    items: [
      {
        id: "i1",
        shotId: "s1",
        visual: { kind: "video", attemptId: "a", assetId: clip, sourceInMs: 500, sourceOutMs: 2000 },
        sourceAudio: "muted",
        performance: [],
        performanceBasis: null,
      },
      {
        id: "i2",
        shotId: "s2",
        visual: { kind: "production_frame", productionFrameId: "pf", durationMs: 1500 },
        sourceAudio: "muted",
        performance: [],
        performanceBasis: null,
        incomingTransition: { kind: "dissolve", durationMs: 500, fromItemId: "i1" },
      },
    ],
    titles: [],
  };
  const manifest = buildRenderManifest(data, edit);
  const profile = deliveryProfile(manifest.target, { width: 480, preset: "ultrafast" });
  const request = () =>
    owner.create({
      projectId: P,
      episodeId: E,
      editId: edit.id,
      editRevision: edit.revision,
      savedRevisionId: null,
      savedRevisionNumber: 1,
      manifest,
      manifestFingerprint: manifestFingerprint(manifest),
      stateFingerprint: manifest.edit.stateFingerprint,
      profile,
      outputFilename: "db-renders-episode-1.mp4",
      segmentsTotal: buildRenderPlan(manifest, profile).pieces.length,
      userId: dev.id,
      now: new Date().toISOString(),
    });

  // ── 1. structure and the worker role ──
  for (const t of ["episode_renders", "render_segment_cache"]) {
    const r = await q("select relrowsecurity from pg_class where relname = $1 and relkind = 'r'", [t]);
    check(`${t} exists with row-level security enabled`, r.rows[0]?.relrowsecurity === true);
  }
  const ownerPolicies = (
    await q(
      "select cmd from pg_policies where tablename = 'episode_renders' and 'authenticated' = any(roles) order by cmd",
    )
  ).rows.map((r) => r.cmd);
  check(
    "episode_renders: the owner may select / insert / update, never delete",
    ownerPolicies.join() === "INSERT,SELECT,UPDATE",
    ownerPolicies.join(),
  );
  const role = (await q("select rolcanlogin from pg_roles where rolname = 'prism_render_worker'")).rows[0];
  check(
    "prism_render_worker exists and cannot log in (a login is provisioned per environment)",
    role?.rolcanlogin === false,
  );
  const tablesWithGrant = (
    await q(
      `select distinct table_name from information_schema.role_table_grants where grantee = 'prism_render_worker'
       union select distinct table_name from information_schema.column_privileges where grantee = 'prism_render_worker'`,
    )
  ).rows
    .map((r) => r.table_name)
    .sort();
  check(
    "the render worker has privileges on exactly assets, episode_renders and render_segment_cache",
    tablesWithGrant.join() === "assets,episode_renders,render_segment_cache",
    tablesWithGrant.join(),
  );
  for (const t of [
    "story_proposals",
    "writing_proposals",
    "generation_attempts",
    "episode_edits",
    "continuity_analysis_jobs",
    "performance_takes",
    "shots",
  ]) {
    const r = await as(WORKER, `select 1 from ${t} limit 1`);
    check(
      `the render worker cannot read ${t}`,
      /permission denied/.test(r.error ?? ""),
      r.error ?? "readable",
    );
  }

  // ── 2. requests: numbered, frozen; owner-only ──
  const r1 = await request();
  const r2 = await request();
  check(
    "renders are numbered per Episode (1, 2) and requested as queued",
    r1.number === 1 && r2.number === 2 && r1.status === "queued",
  );
  check("a stranger sees no render", (await strangerRepo.listForEpisode(P, E)).length === 0);
  check(
    "anon sees no render",
    (await as(ANON, "select count(*)::int n from episode_renders where project_id = $1", [P])).rows[0]?.n ===
      0,
  );
  const strangerInsert = await as(
    STRANGER,
    "insert into episode_renders (project_id, episode_id, edit_id, number, edit_revision, manifest, manifest_fingerprint, state_fingerprint, profile, profile_id, output_filename, segments_total) select project_id, episode_id, edit_id, 99, edit_revision, manifest, manifest_fingerprint, state_fingerprint, profile, profile_id, output_filename, segments_total from episode_renders where id = $1",
    [r1.id],
  );
  check(
    "a stranger cannot request a render in the owner's project",
    strangerInsert.rowCount === 0 || strangerInsert.error !== null,
    strangerInsert.error ?? "inserted",
  );
  const frozen = await as(OWNER, "update episode_renders set manifest_fingerprint = $2 where id = $1", [
    r1.id,
    sha("x"),
  ]);
  check(
    "frozen inputs cannot change (even for the owner)",
    /frozen inputs/.test(frozen.error ?? ""),
    frozen.error ?? "changed",
  );
  const advance = await as(OWNER, "update episode_renders set status = 'rendering_segments' where id = $1", [
    r1.id,
  ]);
  check(
    "the owner cannot advance a render (only the worker does)",
    /only the render worker/.test(advance.error ?? ""),
    advance.error ?? "advanced",
  );
  const badInsert = await as(
    OWNER,
    "insert into episode_renders (project_id, episode_id, edit_id, number, edit_revision, manifest, manifest_fingerprint, state_fingerprint, profile, profile_id, output_filename, segments_total, status) select project_id, episode_id, edit_id, 50, edit_revision, manifest, manifest_fingerprint, state_fingerprint, profile, profile_id, output_filename, segments_total, 'completed' from episode_renders where id = $1",
    [r1.id],
  );
  check(
    "a render can only be requested as queued",
    /requested as queued/.test(badInsert.error ?? ""),
    badInsert.error ?? "inserted",
  );
  check(
    "the owner cancels a queued render",
    (await owner.cancel(P, r2.id, new Date().toISOString())).status === "cancelled",
  );

  // ── 3. the worker role: a REAL render through PostgresRenderWorkerStore ──
  const worker = new EpisodeRenderWorker({
    store,
    storage: sink,
    storageProvider: "local",
    bucket: null,
    workerId: "db-renders-worker",
  });
  const run = await worker.runOnce();
  check(
    "the worker (as prism_render_worker) claims and completes the queued render",
    run?.status === "completed" && run.renderId === r1.id,
    JSON.stringify(run),
  );
  const done = (await owner.get(P, r1.id))!;
  check(
    "the completed render records a verified H.264 output Asset",
    done.status === "completed" &&
      done.output?.videoCodec === "h264" &&
      done.output.frames === manifest.totalFrames &&
      done.output.width === 480,
    JSON.stringify(done.output),
  );
  const asset = (
    await q("select purpose, type, checksum, object_path, project_id from assets where id = $1", [
      done.output?.assetId,
    ])
  ).rows[0];
  const bytes = asset ? await sink.get(asset.object_path) : null;
  check(
    "the output is a private 'episode_render' Asset of the project whose stored bytes match its checksum",
    asset?.purpose === "episode_render" &&
      asset.type === "video" &&
      String(asset.object_path).startsWith(`${P}/`) &&
      bytes !== null &&
      sha(bytes) === asset.checksum,
  );
  check("the cancelled render was not claimed", (await owner.get(P, r2.id))?.status === "cancelled");
  const cache = await as(OWNER, "select count(*)::int n from render_segment_cache where project_id = $1", [
    P,
  ]);
  check(
    "the segment cache is recorded (and readable by the owner)",
    cache.rows[0]?.n === done.segmentsTotal,
    String(cache.rows[0]?.n),
  );
  check(
    "a stranger cannot read the segment cache",
    (await as(STRANGER, "select count(*)::int n from render_segment_cache where project_id = $1", [P]))
      .rows[0]?.n === 0,
  );

  // ── 4. what the worker role can NOT do ──
  const wDone = await as(WORKER, "update episode_renders set error_message = 'x' where id = $1", [r1.id]);
  check(
    "the worker cannot touch a completed render (no row)",
    wDone.rowCount === 0 && wDone.error === null,
    wDone.error ?? "",
  );
  const superDone = await q("update episode_renders set error_message = 'x' where id = $1", [r1.id]).then(
    () => null,
    (e: Error) => e.message,
  );
  check(
    "a completed render is history even for the table owner (trigger)",
    /history/.test(superDone ?? ""),
    superDone ?? "changed",
  );
  const wInsert = await as(
    WORKER,
    "insert into episode_renders (project_id, episode_id, edit_id, number, edit_revision, manifest, manifest_fingerprint, state_fingerprint, profile, profile_id, output_filename, segments_total) select project_id, episode_id, edit_id, 77, edit_revision, manifest, manifest_fingerprint, state_fingerprint, profile, profile_id, output_filename, segments_total from episode_renders where id = $1",
    [r1.id],
  );
  check(
    "the worker cannot request a render",
    /permission denied/.test(wInsert.error ?? ""),
    wInsert.error ?? "inserted",
  );
  const wAsset = await as(
    WORKER,
    "insert into assets (id, project_id, name, type, purpose, source, storage_provider, object_path, metadata) values ($1,$2,'x','image','production_frame','upload','local',$3,'{}'::jsonb)",
    [randomUUID(), P, `${P}/x/x.png`],
  );
  check(
    "the worker cannot insert any other kind of Asset",
    wAsset.error !== null,
    wAsset.error ?? "inserted",
  );
  const wAssets = await as(WORKER, "select count(*)::int n from assets where project_id = $1", [P]);
  check(
    "with no active render, the worker sees none of the project's Assets",
    wAssets.rows[0]?.n === 0,
    String(wAssets.rows[0]?.n),
  );

  // ── 5. failure and retry (the same render) ──
  const r3 = await request();
  const claimed = (await store.claimNext("db-renders-worker", new Date().toISOString(), 60_000))!;
  await store.fail(
    claimed.render.id,
    claimed.leaseToken,
    { code: "test_failure", message: "simulated" },
    new Date().toISOString(),
  );
  const failed = (await owner.get(P, r3.id))!;
  check(
    "a failed render records its error and no output",
    failed.status === "failed" && failed.errorCode === "test_failure" && failed.output === null,
  );
  const wRetry = await as(WORKER, "update episode_renders set status = 'queued' where id = $1", [r3.id]);
  check(
    "the worker cannot retry (a failed render is not active for it)",
    wRetry.rowCount === 0,
    wRetry.error ?? "",
  );
  const retried = await owner.retry(P, r3.id, new Date().toISOString());
  check(
    "the owner retries the SAME render (attempt 2, queued, no new row)",
    retried.status === "queued" && retried.attemptCount === 2 && retried.number === 3,
  );
  const again = await worker.runOnce();
  const r3done = (await owner.get(P, r3.id))!;
  check(
    "the retried render completes, reusing every cached segment of the identical manifest",
    again?.status === "completed" &&
      again.rendered === 0 &&
      again.reused === r3done.segmentsTotal &&
      r3done.output?.checksum !== undefined,
    JSON.stringify(again),
  );
  check(
    "a stale lease cannot write",
    (await code(store.progress(r3.id, randomUUID(), { segmentsDone: 1 }, new Date().toISOString()))) ===
      "lease_lost",
  );
  check(
    "renders coexist: 1 completed, 2 cancelled, 3 completed",
    (await owner.listForEpisode(P, E)).map((r) => r.status).join() === "completed,cancelled,completed",
  );

  // ── 5b. the provisioned LOGIN (disposable databases only: a hosted login is provisioned by its owner) ──
  if (disposableLocalTarget(dev.url)) {
    const before = (await q("select rolcanlogin from pg_roles where rolname = $1", [RENDER_WORKER_ROLE]))
      .rows[0];
    const pre = await auditRenderWorkerRole(pool);
    check("the render role is least-privilege (audit)", pre.failures.length === 0, pre.failures.join("; "));
    const short = await provisionRenderWorkerLogin(pool, "too-short").catch((e: Error) => e.message);
    check("provisioning refuses a short secret", String(short).includes("at least 24"), String(short));
    const secret = randomUUID() + randomUUID();
    const outcome = await provisionRenderWorkerLogin(pool, secret, { rotate: true });
    check(
      "provisioning attaches LOGIN to prism_render_worker",
      ["enabled", "rotated"].includes(outcome),
      outcome,
    );
    const login = new URL(dev.url);
    login.username = RENDER_WORKER_ROLE;
    login.password = secret;
    const wc = new pg.Client({ connectionString: login.toString() });
    try {
      await wc.connect();
      const who = (await wc.query("select current_user as u, session_user as s")).rows[0];
      check(
        "a real login runs as prism_render_worker",
        who.u === RENDER_WORKER_ROLE && who.s === RENDER_WORKER_ROLE,
        JSON.stringify(who),
      );
      const own = await wc.query("select count(*) from episode_renders").then(
        () => null,
        (e: Error) => e.message,
      );
      check("…reads episode_renders", own === null, own ?? "");
      for (const t of ["projects", "shots", "story_proposals", "generation_jobs", "episode_edits"]) {
        const r = await wc.query(`select 1 from ${t} limit 1`).then(
          () => "allowed",
          (e: Error) => e.message,
        );
        check(`…cannot read ${t}`, /permission denied/.test(r), r);
      }
      const db = await wc.query("create database prism_render_probe_db").then(
        () => "allowed",
        (e: Error) => e.message,
      );
      check("…cannot create a database", /permission denied/.test(db), db);
      if (db === "allowed") await q("drop database if exists prism_render_probe_db");
      const esc = await wc.query("set role postgres").then(
        () => "allowed",
        (e: Error) => e.message,
      );
      check("…cannot SET ROLE to the admin", /permission denied/.test(esc), esc);
    } finally {
      await wc.end().catch(() => undefined);
      // restore the migration's NOLOGIN state when this suite enabled it
      if (!before?.rolcanlogin) await q(`alter role ${RENDER_WORKER_ROLE} nologin password null`);
    }
  }

  // ── 6. a Project delete cascades through renders and the cache ──
  const del = await as(OWNER, "delete from projects where id = $1", [P]);
  check("deleting the Project succeeds", del.error === null, del.error ?? "");
  const left = (
    await q(
      "select (select count(*) from episode_renders where project_id = $1) + (select count(*) from render_segment_cache where project_id = $1) as n",
      [P],
    )
  ).rows[0].n;
  check("…and leaves no render or cache row", Number(left) === 0, String(left));
} catch (err) {
  check("suite ran to completion", false, (err as Error).stack ?? String(err));
} finally {
  if (cleanup) {
    await q("delete from projects where id = $1", [P]).catch(() => undefined);
    const left = (await q("select count(*) as n from projects where id = $1", [P])).rows[0].n;
    check("cleanup: the throwaway project is gone", Number(left) === 0, String(left));
    rmSync(mediaRoot, { recursive: true, force: true });
    cleanup = false;
  }
}

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await pool.end();
process.exit(failed ? 1 : 0);

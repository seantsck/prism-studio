// Supabase E2E for Phase 2F M2D.3B: the DURABLE LOCAL RECONSTRUCTION WORKER against the REAL dedicated Prism Studio
// database and private Storage (project lyqdxiyjperhniwhzsvg only).
//   npm run db:local-worker
//
// The worker is the REAL entry point (`scripts/run-local-reconstruction-worker.mts`) running as a SEPARATE PROCESS.
// Only the external tools are fake: the M2D.3A fake COLMAP/Brush (Node scripts, `--fake-tools`, NODE_ENV=test) behind a
// real, verified provenance manifest. No real COLMAP, no real Brush, no provider of any kind, no paid call.
//
// Flow (fictional data in a temporary project of the dev owner, removed afterwards):
//   private image Assets → worker offline: Local Capture refused, no job → worker online → queued local job
//   → the worker claims it with NO client polling → progress → private SPZ Asset → immutable generated
//   reconstruction → succeeded; anonymous and stranger reads refused
//   → cancel while Brush trains (worker aborts, nothing imported)
//   → hard crash of the worker mid-run → restart: the stale attempt fails truthfully, nothing re-runs → Retry runs.
// Requires `npm run db:seed` first and PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY (the existing worker Storage key).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { PostgresPrevisData } from "../src/data/previs-postgres";
import { rlsPreamble, UserRepository } from "../src/data/postgres-repository";
import { isTerminal, type ReconstructionJobRecord } from "../src/domain/reconstruction/job";
import { assetSchema, type Asset } from "../src/domain/schemas";
import { createOutputSink } from "../src/generation/sink";
import { inspectSplat } from "../src/lib/splat/inspect";
import { buildObjectPath } from "../src/lib/storage-paths";
import { LocalCaptureProvider } from "../src/lib/reconstruction/local-capture";
import { fakeMachine, machineEnv } from "../src/lib/reconstruction/local/__tests__/fake-machine";
import { readHeartbeat } from "../src/lib/reconstruction/local-worker/runtime";
import { workerBackedToolchain } from "../src/lib/reconstruction/local-worker/status";
import { STOPPED_MESSAGE } from "../src/lib/reconstruction/local-worker/adapter";
import type { ReconstructionProvider } from "../src/lib/reconstruction/provider";
import {
  cancelJob,
  createJob,
  retryJob,
  submitJob,
  type JobServiceDeps,
} from "../src/server/reconstruction-jobs";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({
  mode: "local reconstruction worker E2E (fictional rows + objects created, then removed)",
  devOwner: dev.id,
});
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 4 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sink = await createOutputSink(process.env, "supabase");
const owner = new PostgresPrevisData(pool, rlsPreamble({ sub: dev.id }));
const ownerRepo = new UserRepository(pool, { sub: dev.id });
const tmp = await mkdtemp(path.join(os.tmpdir(), "prism-db-local-worker-"));
const workRoot = path.join(tmp, "work");
const machine = await fakeMachine(path.join(tmp, "machine"));
const projectId = randomUUID();
const locationId = randomUUID();
const workers: ChildProcess[] = [];

/** Kills a worker process TREE abruptly (a crash: no shutdown handler runs). */
function crash(child: ChildProcess) {
  if (child.pid && child.exitCode === null)
    spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), [
      "/PID",
      String(child.pid),
      "/T",
      "/F",
    ]);
}

/** Starts the REAL worker entry point as a separate process (fake tools only; scoped to the test project). */
async function startWorker(brushMode = "success"): Promise<ChildProcess> {
  // a crashed worker's heartbeat can still look fresh for a few seconds: wait for THIS worker's own heartbeat
  const previous = readHeartbeat(workRoot, Date.now());
  const previousId = previous.state === "online" ? previous.heartbeat.workerId : null;
  const child = spawn(
    process.execPath,
    [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      "scripts/run-local-reconstruction-worker.mts",
      "--fake-tools",
    ],
    {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "test",
        PRISM_LOCAL_RECONSTRUCTION_WORKER_ENABLED: "1",
        PRISM_STUDIO_PERSISTENCE: "supabase",
        PRISM_LOCAL_RECONSTRUCTION_ROOT: workRoot,
        PRISM_LOCAL_RECONSTRUCTION_PROJECT_ID: projectId,
        ...machineEnv(machine),
        // the fake machine's SystemRoot is for the Vulkan-loader probe only; the worker keeps the real one
        SystemRoot: process.env.SystemRoot,
        PRISM_LOCAL_TEST_SYSTEM_ROOT: machine.sysRoot,
        FAKE_BRUSH_MODE: brushMode,
      },
    },
  );
  let out = "";
  child.stdout!.on("data", (d) => (out += String(d)));
  child.stderr!.on("data", (d) => (out += String(d)));
  workers.push(child);
  const end = Date.now() + 90_000;
  for (;;) {
    const r = readHeartbeat(workRoot, Date.now());
    if (
      r.state === "online" &&
      r.heartbeat.workerId !== previousId &&
      r.heartbeat.toolchain.state === "ready"
    )
      break;
    if (child.exitCode !== null || Date.now() > end)
      throw new Error(`worker did not come online (exit ${child.exitCode}): ${out.slice(-600)}`);
    await sleep(250);
  }
  return child;
}

const waitJob = async (
  id: string,
  until: (j: ReconstructionJobRecord) => boolean,
  ms = 120_000,
  seen?: (j: ReconstructionJobRecord) => void,
) => {
  const end = Date.now() + ms;
  for (;;) {
    const j = (await owner.getReconstructionJob(id))!;
    seen?.(j);
    if (until(j)) return j;
    if (Date.now() > end) throw new Error(`timed out (job ${id} is ${j.status})`);
    await sleep(300);
  }
};

try {
  // ── fictional project, location and three private photographs ──
  await pool.query("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,$4,'test')", [
    projectId,
    dev.id,
    `db-local-worker-${projectId.slice(0, 8)}`,
    "db:local-worker project",
  ]);
  await pool.query(
    "insert into locations (id, project_id, name, description, geography) values ($1,$2,$3,'','')",
    [locationId, projectId, "db:local-worker lobby"],
  );
  const photos: Asset[] = [];
  for (let i = 0; i < 3; i++) {
    const png = i === 1;
    const bytes = png
      ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, i])
      : new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x10 + i, 1, 2, 3, 0xff, 0xd9]);
    const id = randomUUID();
    const name = `db-local-worker-${i + 1}.${png ? "png" : "jpg"}`;
    const objectPath = buildObjectPath(projectId, id, name);
    await sink.put(objectPath, bytes, png ? "image/png" : "image/jpeg");
    const now = new Date().toISOString();
    const asset = assetSchema.parse({
      id,
      projectId,
      createdBy: dev.id,
      type: "image",
      purpose: "location_ref",
      source: "upload",
      name: `db:local-worker photo ${i + 1}`,
      originalFilename: name,
      storageProvider: "supabase",
      bucket: sink.bucket,
      objectPath,
      mime: png ? "image/png" : "image/jpeg",
      byteSize: bytes.length,
      checksum: sha(bytes),
      width: 640,
      height: 480,
      durationMs: null,
      frameRate: null,
      sampleRate: null,
      channels: null,
      tags: [],
      notes: "",
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });
    await ownerRepo.upsert(projectId, "assets", asset);
    photos.push(asset);
  }

  // ── the WEB side: the M2D.2 job service with the worker-backed Local Capture status (no World Labs key, paid off) ──
  const webEnv = {
    PRISM_LOCAL_RECONSTRUCTION_WORKER_ENABLED: "1",
    PRISM_LOCAL_RECONSTRUCTION_ROOT: workRoot,
  };
  const local = new LocalCaptureProvider(workerBackedToolchain({ env: webEnv, persistence: "supabase" }));
  const web: JobServiceDeps = {
    repo: owner,
    providers: new Map<string, ReconstructionProvider>([["local_capture", local]]),
    config: { jobsEnabled: true, paid: { enabled: false, maxUsd: null }, pollIntervalMs: 1000 },
    projectAssets: photos,
    projectId,
    locationName: () => "db:local-worker lobby",
    readAssetBytes: (a) => sink.get(a.objectPath!),
    store: {
      putObject: (p, b, m) => sink.put(p, b, m),
      upsertAsset: (a) => ownerRepo.upsert(projectId, "assets", a),
      removeAsset: (id) => ownerRepo.remove(projectId, "assets", id),
      removeObject: async (a) => void (a.objectPath && (await sink.remove(a.objectPath))),
    },
    storage: { name: "supabase", bucket: sink.bucket },
    userId: dev.id,
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
    log: () => undefined,
  };
  let order = 0;
  const generate = async () => {
    const ids = photos.map((p) => p.id);
    const k = order++ % ids.length; // a different photo order per request: a new request, not the same attempt
    const j = await createJob(web, {
      locationId,
      sourceAssetIds: [...ids.slice(k), ...ids.slice(0, k)],
      provider: "local_capture",
      model: null,
      options: {},
    });
    return submitJob(web, j.id);
  };

  // ── 1. worker offline: Local Capture is not offered; nothing is created ──
  const offline = await generate().then(
    () => null,
    (e: { code?: string }) => e.code ?? "error",
  );
  check(
    "worker offline: Local Capture is refused (not offered)",
    offline === "not_configured",
    String(offline),
  );
  check("worker offline: no job row appears", (await owner.listReconstructionJobs(locationId)).length === 0);

  // ── 2. the worker process starts; a job is queued; the client goes away ──
  let worker = await startWorker();
  check(
    "worker online: Local Capture available (verified toolchain + fresh heartbeat)",
    local.status().capability === "available",
  );
  const job1 = await generate();
  check(
    "Generate Reconstruction queues a FREE local job (the web runs nothing)",
    job1.status === "queued" && job1.costEstimate?.costClass === "free",
  );
  const progress = new Set<number>();
  const stages = new Set<string>();
  const done1 = await waitJob(
    job1.id,
    (j) => isTerminal(j.status),
    120_000,
    (j) => {
      if (j.progress !== null) progress.add(j.progress);
      if (typeof j.providerOperation?.stage === "string") stages.add(j.providerOperation.stage as string);
    },
  );
  check(
    "the separate worker process ran it to success with NO client polling",
    done1.status === "succeeded",
    done1.errorMessage ?? "",
  );
  check(
    "intermediate progress was persisted",
    [...progress].some((p) => p > 0 && p < 1),
    JSON.stringify([...progress]),
  );
  check(
    "stages were persisted",
    stages.has("camera_reconstruction") || stages.has("splat_training"),
    JSON.stringify([...stages]),
  );
  check(
    "operation id is an opaque local run id",
    /^local:lr-[0-9a-f]{12}-a1-[0-9a-f]{8}$/.test(done1.providerOperationId ?? ""),
  );
  const rec = await owner.getReconstruction(done1.resultReconstructionId!);
  check(
    "an immutable GENERATED reconstruction with unknown scale and local provenance",
    rec?.method === "generated" &&
      rec.calibration.units === "unknown" &&
      rec.calibration.metresPerSourceUnit === null &&
      (rec.generation?.metadata as Record<string, unknown> | undefined)?.engine ===
        "prism-local-reconstruction",
  );
  const asset = await ownerRepo.findAsset(rec!.resultAssetId);
  const stored = asset?.objectPath ? await sink.get(asset.objectPath) : null;
  check(
    "a PRIVATE SPZ Asset holding exactly the validated bytes",
    !!asset &&
      asset.storageProvider === "supabase" &&
      !!stored &&
      sha(stored) === rec!.resultChecksum &&
      inspectSplat(stored, "x.spz").ok,
  );
  const persisted = JSON.stringify([done1.providerOperation, done1.providerResult, rec?.generation]);
  check(
    "nothing persisted names a path, the machine or a credential",
    !persisted.includes(tmp) && !/postgres|https?:|secret/i.test(persisted),
  );
  const events = (await owner.listReconstructionJobEvents(job1.id)).map((e) => e.event);
  check(
    "events: stage changes only, never per training iteration",
    events.length <= 14 && events.at(-1) === "succeeded",
    events.join(","),
  );

  // anonymous and stranger reads are refused (RLS + private bucket)
  const anon = async (sql: string, params: unknown[]) => {
    const c = await pool.connect();
    try {
      await c.query(rlsPreamble(null, "anon"));
      return (await c.query(sql, params)).rowCount ?? 0;
    } catch {
      return 0;
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  };
  check(
    "anonymous: no job, no reconstruction, no asset row",
    (await anon("select 1 from reconstruction_jobs where id = $1", [job1.id])) === 0 &&
      (await anon("select 1 from location_spatial_reconstructions where id = $1", [rec!.id])) === 0 &&
      (await anon("select 1 from assets where id = $1", [rec!.resultAssetId])) === 0,
  );
  const stranger = new PostgresPrevisData(pool, rlsPreamble({ sub: randomUUID() }));
  check("a stranger cannot read the job", (await stranger.getReconstructionJob(job1.id)) === null);
  const anonStorage = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: { persistSession: false },
    },
  );
  const dl = await anonStorage.storage.from(sink.bucket!).download(asset!.objectPath!);
  check("anonymous: the SPZ object cannot be downloaded", !!dl.error && !dl.data);

  // ── 3. cancel while Brush trains ──
  crash(worker); // (also leaves a stale lock behind: the next worker must recover it)
  await sleep(500);
  worker = await startWorker("slow");
  const job2 = await generate();
  await waitJob(
    job2.id,
    (j) => j.status === "running" && j.providerOperation?.stage === "splat_training",
    90_000,
  );
  const t0 = Date.now();
  const c2 = await cancelJob(web, job2.id);
  check("cancel: the job is cancelled at once (terminal)", c2.status === "cancelled");
  for (const end = Date.now() + 30_000; Date.now() < end; await sleep(250)) {
    const r = readHeartbeat(workRoot, Date.now());
    if (r.state === "online" && !r.heartbeat.busy) break;
  }
  const hb = readHeartbeat(workRoot, Date.now());
  check(
    "cancel: the worker stopped the run promptly and is idle again",
    hb.state === "online" && !hb.heartbeat.busy && Date.now() - t0 < 20_000,
    `${Date.now() - t0} ms`,
  );
  const after2 = (await owner.getReconstructionJob(job2.id))!;
  check(
    "cancel: nothing was imported",
    after2.status === "cancelled" && after2.resultReconstructionId === null,
  );

  // ── 4. hard crash mid-run → restart: the stale attempt fails truthfully, nothing re-runs → Retry runs ──
  const job3 = await generate();
  await waitJob(
    job3.id,
    (j) => j.status === "running" && j.providerOperation?.stage === "splat_training",
    90_000,
  );
  crash(worker);
  await sleep(500);
  check(
    "crash: the job is still 'running' until a worker restarts",
    (await owner.getReconstructionJob(job3.id))!.status === "running",
  );
  const jobsBefore = (await owner.listReconstructionJobs(locationId)).length;
  worker = await startWorker();
  const failed3 = await waitJob(job3.id, (j) => isTerminal(j.status), 30_000);
  check(
    "restart: the interrupted attempt failed with the truthful message",
    failed3.status === "failed" &&
      failed3.errorCode === "provider_failed" &&
      failed3.errorMessage === STOPPED_MESSAGE,
    `${failed3.status} ${failed3.errorMessage}`,
  );
  check(
    "restart: no automatic re-run (no new job, no result)",
    (await owner.listReconstructionJobs(locationId)).length === jobsBefore &&
      failed3.resultReconstructionId === null,
  );
  const retry = await retryJob(web, job3.id);
  const done4 = await waitJob(retry.id, (j) => isTerminal(j.status), 120_000);
  check(
    "Retry: a NEW local attempt that succeeds",
    retry.attempt === 2 &&
      retry.previousJobId === job3.id &&
      retry.provider === "local_capture" &&
      done4.status === "succeeded",
    `${done4.status}`,
  );
  crash(worker);
  check(
    "exactly one reconstruction per succeeded job",
    (
      await pool.query(
        "select count(*)::int n from location_spatial_reconstructions where location_id = $1",
        [locationId],
      )
    ).rows[0].n === 2,
  );
} catch (e) {
  check("E2E ran to completion", false, e instanceof Error ? e.message.slice(0, 400) : String(e));
} finally {
  for (const w of workers) crash(w);
  // private objects first (the rows say where they are), then the rows (the project cascade)
  const objects = await pool.query(
    "select object_path from assets where project_id = $1 and object_path is not null",
    [projectId],
  );
  for (const r of objects.rows) await sink.remove(String(r.object_path)).catch(() => undefined);
  await pool
    .query("delete from projects where id = $1", [projectId])
    .catch((e: Error) => check("cleanup: project removed", false, e.message));
  await rm(tmp, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}

const leftover = await pool.query(
  `select (select count(*)::int from projects where id = $1) as projects,
          (select count(*)::int from reconstruction_jobs where project_id = $1) as jobs,
          (select count(*)::int from assets where project_id = $1) as assets,
          (select count(*)::int from storage.objects where bucket_id = 'prism-assets' and name like $2) as objects`,
  [projectId, `${projectId}/%`],
);
const l = leftover.rows[0];
check(
  "cleanup left no rows and no stored objects",
  l.projects === 0 && l.jobs === 0 && l.assets === 0 && l.objects === 0,
  JSON.stringify(l),
);

let failed = 0;
for (const [name, ok, detail] of results) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await pool.end();
process.exit(failed ? 1 : 0);

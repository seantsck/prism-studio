// Supabase E2E for Phase 2F M2D.3C2: REMOTE LOCAL AGENT RECONSTRUCTION against the REAL dedicated Prism Studio database
// and private Storage (project lyqdxiyjperhniwhzsvg only).
//   npm run db:remote-agent-jobs
//
// The workstation is the REAL agent CLI (`scripts/local-agent.mts`) in a SEPARATE PROCESS with a MINIMAL environment:
// no SUPABASE_DB_URL, no Supabase key, no worker/relay/Storage secret, no provider key. It talks to the production
// handlers over real HTTP (an in-process server wired to the Postgres stores, as the Next.js routes are). The server
// side uses the guarded connection for discovery, the owner's RLS context for everything else, and a Storage secret
// key for the relay (PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY; when this machine has no dedicated relay key yet,
// the test process uses the worker key's VALUE for it, server-side only). External tools are the M2D.3A fakes.
//
// Checks: real CLI end to end (lease → exact sources from private Storage → engine → progress → SPZ upload → shared
// ingestion: private Asset object + immutable reconstruction + success), Postgres compare-and-set lease race (exactly
// one), cross-project isolation (same owner!), source IDOR, exactly-once uploads, cancel race, lease expiry reaping (never
// re-leased), revocation fails the active job, same-host worker discovery never sees remote jobs, RLS (stranger/anon),
// no World Labs call, cleanup. Fictional data in temporary projects of the dev owner, removed afterwards.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { PostgresPrevisData } from "../src/data/previs-postgres";
import { rlsPreamble, UserRepository } from "../src/data/postgres-repository";
import { assetSchema, type Asset } from "../src/domain/schemas";
import { secretKeySink } from "../src/generation/sink";
import { jobPaths, PATHS, PROTOCOL } from "../src/lib/local-agent/protocol";
import { fakeMachine, machineEnv } from "../src/lib/reconstruction/local/__tests__/fake-machine";
import { createPostgresWorkerStore } from "../src/lib/reconstruction/local-worker/postgres-store";
import type { ReconstructionProvider } from "../src/lib/reconstruction/provider";
import { RemoteAgentCaptureProvider } from "../src/lib/reconstruction/remote-agent-capture";
import { buildObjectPath } from "../src/lib/storage-paths";
import { encodeSpzFile, syntheticPlane } from "../src/lib/splat/synthetic";
import { capabilities, TestAgent } from "../src/server/local-agent/__tests__/helpers";
import { prismServer } from "../src/server/local-agent/jobs/__tests__/prism-server";
import {
  failJobsOfAgent,
  leaseJob,
  progress,
  serveSource,
  uploadResult,
  type RemoteJobDeps,
} from "../src/server/local-agent/jobs/service";
import { postgresRemoteJobStore } from "../src/server/local-agent/jobs/store";
import { PostgresAgentAuthStore, PostgresOwnerAgentStore } from "../src/server/local-agent/postgres-store";
import {
  AgentProtocolError,
  createPairingOffer,
  heartbeat,
  redeemPairing,
  revokeAgent,
} from "../src/server/local-agent/service";
import { cancelJob, createJob, refreshJob, type JobServiceDeps } from "../src/server/reconstruction-jobs";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({
  mode: "remote agent jobs E2E (fictional projects, photographs, jobs and devices created, then removed)",
  devOwner: dev.id,
});
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 12 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const relayKey = process.env.PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY?.trim();
console.log(
  relayKey
    ? "relay Storage: the dedicated agent-relay key"
    : "relay Storage: no dedicated relay key on this machine; the test uses the worker key's value (server-side only)",
);
const sink = secretKeySink({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  publishable: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  secret: relayKey || process.env.PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY?.trim() || "",
  what: "agent relay",
});

const A = randomUUID();
const B = randomUUID();
const locA = randomUUID();
const locB = randomUUID();
const owner = new PostgresPrevisData(pool, rlsPreamble({ sub: dev.id }));
const ownerRepo = new UserRepository(pool, { sub: dev.id });
const ownerAgents = new PostgresOwnerAgentStore(pool, rlsPreamble({ sub: dev.id }));
const tmp = await mkdtemp(path.join(os.tmpdir(), "prism-db-remote-agent-"));
const home = path.join(tmp, "agent-home");
const machine = await fakeMachine(path.join(tmp, "machine"));
const deps: RemoteJobDeps = {
  agent: { store: new PostgresAgentAuthStore(pool), canonicalOrigin: "", now: Date.now, remoteJobs: true },
  jobs: postgresRemoteJobStore(pool, sink),
  available: true,
  newId: () => randomUUID(),
  log: () => undefined,
};
let srv: Awaited<ReturnType<typeof prismServer>> | null = null;
const worldLabsCalls: string[] = [];

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof AgentProtocolError) return e.code;
    return `error:${e instanceof Error ? e.message.slice(0, 160) : "?"}`;
  }
}

async function photos(projectId: string, n: number, tag: string): Promise<Asset[]> {
  const out: Asset[] = [];
  for (let i = 0; i < n; i++) {
    const png = i % 3 === 1;
    const bytes = png
      ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, i, tag.charCodeAt(0)])
      : new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x10 + i, tag.charCodeAt(0), 2, 3, 0xff, 0xd9]);
    const id = randomUUID();
    const name = `db-remote-${tag}-${i + 1}.${png ? "png" : "jpg"}`;
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
      name: `db:remote-agent photo ${tag}${i + 1}`,
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
    out.push(asset);
  }
  return out;
}

/** The WEB side for one project: the job service with a ready Remote Local Agent (World Labs spy, paid off). */
function web(projectId: string, assets: Asset[]): JobServiceDeps {
  const providers = new Map<string, ReconstructionProvider>([
    [
      "local_agent_capture",
      new RemoteAgentCaptureProvider({
        view: () => ({ state: "ready", active: 1, online: 1, ready: 1, busy: 0 }),
      }),
    ],
  ]);
  return {
    repo: owner,
    providers,
    config: { jobsEnabled: true, paid: { enabled: false, maxUsd: null }, pollIntervalMs: 1000 },
    projectAssets: assets,
    projectId,
    locationName: () => "db:remote-agent lobby",
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
}

function cli(args: string[], extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    TEMP: process.env.TEMP ?? os.tmpdir(),
    TMP: process.env.TMP ?? os.tmpdir(),
    NODE_ENV: "test",
    PRISM_LOCAL_AGENT_HOME: home,
    ...machineEnv(machine),
    SystemRoot: process.env.SystemRoot ?? "",
    PRISM_LOCAL_TEST_SYSTEM_ROOT: machine.sysRoot,
    ...extra,
  };
  const child = spawn(
    process.execPath,
    [path.resolve("node_modules/tsx/dist/cli.mjs"), "scripts/local-agent.mts", ...args],
    { shell: false, stdio: ["ignore", "pipe", "pipe"], env: env as NodeJS.ProcessEnv },
  );
  let out = "";
  child.stdout!.on("data", (d: Buffer) => (out += String(d)));
  child.stderr!.on("data", (d: Buffer) => (out += String(d)));
  const exit = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { child, exit, env, output: () => out };
}

/** A fictional device of `projectId`, signing with its own key, heartbeating a ready toolchain that runs jobs. */
async function device(projectId: string) {
  const offer = await createPairingOffer(ownerAgents, projectId);
  const a = new TestAgent(Date.now, srv!.origin);
  a.deviceId = (await redeemPairing(deps.agent, a.pairBody(offer.code))).device.id;
  const c = capabilities();
  await heartbeat(
    deps.agent,
    a.heartbeat(
      {},
      { ...c, engine: { ...c.engine, qualityProfiles: ["standard"] }, execution: { remoteJobs: true } },
    ),
  );
  return a;
}
const leaseOf = (a: TestAgent) => leaseJob(deps, a.request("POST", PATHS.lease, { protocol: PROTOCOL }));
const job = async (id: string) => (await owner.getReconstructionJob(id))!;

try {
  for (const [id, loc, slug] of [
    [A, locA, `remote-a-${A.slice(0, 8)}`],
    [B, locB, `remote-b-${B.slice(0, 8)}`],
  ]) {
    await pool.query("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,$4,'test')", [
      id,
      dev.id,
      slug,
      `Fictional remote-agent project ${slug}`,
    ]);
    await pool.query(
      "insert into locations (id, project_id, name, description, geography) values ($1,$2,$3,'','')",
      [loc, id, "db:remote-agent lobby"],
    );
  }
  srv = await prismServer(deps);
  const imgsA = await photos(A, 4, "a");
  const imgsB = await photos(B, 3, "b");
  const webA = web(A, imgsA);
  const webB = web(B, imgsB);
  // every request is a different ordered selection (the same selection would be the same attempt)
  const used = new Set<string>();
  const newJob = async (w: JobServiceDeps, loc: string, imgs: Asset[]) => {
    let pick: string[] = [];
    for (const a of imgs)
      for (const b of imgs)
        for (const c of imgs) {
          const ids = [a.id, b.id, c.id];
          if (new Set(ids).size === 3 && !used.has(ids.join()) && pick.length === 0) pick = ids;
        }
    used.add(pick.join());
    return createJob(w, {
      locationId: loc,
      sourceAssetIds: pick,
      provider: "local_agent_capture",
      model: null,
      options: {},
    });
  };

  // ── 1. the REAL CLI runs a job end to end, with no server credential in its environment ──
  const j1 = await newJob(webA, locA, imgsA);
  check("a Remote Local Agent job is queued (the web runs nothing)", j1.status === "queued");
  const offer = await createPairingOffer(ownerAgents, A);
  const pair = cli(["pair", "--server", srv.origin, "--code", offer.code, "--label", "Fictional rig"]);
  check("real CLI pairs", (await pair.exit) === 0, pair.output().slice(-300));
  const run = cli(["run", "--fake-tools", "--max-jobs", "1", "--poll-ms", "300"]);
  check(
    "the CLI environment has no database, Supabase, worker, relay or provider credential",
    !Object.keys(run.env).some((k) => /SUPABASE|DB_URL|WORKER|RELAY|SERVICE_ROLE|WLT_|OPENAI|GEMINI/.test(k)),
  );
  const code = await run.exit;
  check(
    "real CLI: lease → sources → engine → upload → succeeded",
    code === 0 && run.output().includes("Jobs: succeeded"),
    run.output().slice(-600),
  );
  const done = await job(j1.id);
  check(
    "job succeeded through the shared ingestion",
    done.status === "succeeded" && !!done.resultReconstructionId,
  );
  const rec = done.resultReconstructionId ? await owner.getReconstruction(done.resultReconstructionId) : null;
  const meta = (rec?.generation?.metadata ?? {}) as Record<string, unknown>;
  check(
    "immutable reconstruction: generated SPZ, unknown scale, remote provenance (no path, no lease)",
    rec?.method === "generated" &&
      rec.resultFormat === "spz" &&
      rec.calibration.scaleMethod === "unknown" &&
      meta.runner === "remote_agent" &&
      !JSON.stringify(rec.generation).match(/leaseId|[A-Za-z]:\\|\/home\//),
  );
  const resultAsset = rec ? await ownerRepo.findAsset(rec.resultAssetId) : null;
  const stored = resultAsset?.objectPath ? await sink.get(resultAsset.objectPath) : null;
  check(
    "the result is a PRIVATE Storage object under the project prefix, matching its checksum",
    !!stored &&
      resultAsset!.objectPath!.startsWith(`${A}/`) &&
      sha(stored) === resultAsset!.checksum &&
      resultAsset!.storageProvider === "supabase",
  );
  const events = (await owner.listReconstructionJobEvents(j1.id)).map((e) => e.event);
  check(
    "events: submitted, provider_running, progress, provider_succeeded, ingesting, succeeded",
    ["submitted", "provider_running", "progress", "provider_succeeded", "ingesting", "succeeded"].every((e) =>
      events.includes(e as never),
    ),
    events.join(","),
  );

  // ── 2. Postgres compare-and-set: two devices race for one job → exactly one lease ──
  const j2 = await newJob(webA, locA, imgsA);
  const [d1, d2] = [await device(A), await device(A)];
  const race = await Promise.all([leaseOf(d1), leaseOf(d2)]);
  const winners = race.filter((r) => r.lease);
  check(
    "two devices racing for one job: exactly one lease",
    winners.length === 1 && winners[0]!.lease!.jobId === j2.id,
  );
  const winner = race[0]!.lease ? d1 : d2;
  const loser = winner === d1 ? d2 : d1;
  const lease = winners[0]!.lease!;
  const again = await leaseOf(winner);
  check(
    "the holder asking again gets the SAME lease",
    again.lease?.leaseId === lease.leaseId && again.lease.resumed === true,
  );

  // ── 3. isolation: another device, another project (same owner!), a forged lease: nothing ──
  const foreign = await device(B);
  const jB = await newJob(webB, locB, imgsB);
  const fLease = await leaseOf(foreign);
  check("a project-B device leases only project B's job", fLease.lease?.jobId === jB.id);
  const src = (who: TestAgent, jobId: string, leaseId: string, n: number) =>
    codeOf(
      serveSource(deps, who.request("GET", jobPaths(jobId, leaseId).source(n), null), jobId, leaseId, n),
    );
  check(
    "source IDOR: other device / other project / forged lease / out-of-range ordinal → refused",
    (await src(loser, lease.jobId, lease.leaseId, 0)) === "lease_mismatch" &&
      (await src(foreign, lease.jobId, lease.leaseId, 0)) === "lease_mismatch" &&
      (await src(winner, lease.jobId, "0".repeat(32), 0)) === "lease_mismatch" &&
      (await src(winner, jB.id, lease.leaseId, 0)) === "lease_mismatch" &&
      (await src(winner, lease.jobId, lease.leaseId, 3)) === "source_unavailable",
  );
  const own = await serveSource(
    deps,
    winner.request("GET", jobPaths(lease.jobId, lease.leaseId).source(1), null),
    lease.jobId,
    lease.leaseId,
    1,
  );
  check("the holder gets the exact frozen photograph from private Storage", own.sha256 === sha(own.bytes));

  // ── 4. exactly once: concurrent uploads → one Asset, one reconstruction ──
  const bytes = encodeSpzFile(syntheticPlane({ n: 8 }));
  const c = capabilities();
  const result = {
    format: "spz" as const,
    sha256: sha(bytes),
    byteSize: bytes.length,
    gaussianCount: 64,
    shDegree: 0,
    inputImages: 3,
    registeredImages: 3,
    registrationRatio: 1,
    sparsePoints: 100,
    quality: "standard" as const,
    colmap: {
      version: c.toolchain.colmap.version!,
      sourceCommit: c.toolchain.colmap.fingerprint!.sourceCommit,
      binarySha256: c.toolchain.colmap.fingerprint!.binarySha256,
    },
    brush: { version: c.toolchain.brush.version! },
    spzEncoder: "@sparkjsdev/spark@0.1.10 SpzWriter",
    spzVersion: 3,
    lossless: false as const,
    clamped: { positions: 0, colors: 0, scales: 0, sh: 0 },
  };
  await progress(
    deps,
    winner.request("POST", jobPaths(lease.jobId, lease.leaseId).progress, {
      protocol: PROTOCOL,
      stage: "uploading",
      progress: 1,
      message: "Uploading",
      result,
    }),
    lease.jobId,
    lease.leaseId,
  );
  const put = () =>
    codeOf(
      uploadResult(
        deps,
        winner.request("PUT", jobPaths(lease.jobId, lease.leaseId).result, null, { rawBody: bytes }),
        lease.jobId,
        lease.leaseId,
      ),
    );
  const uploads = await Promise.all([put(), put(), put()]);
  const recs = await pool.query(
    "select count(*)::int as n from location_spatial_reconstructions where project_id = $1 and generation_json->>'jobId' = $2",
    [A, lease.jobId],
  );
  const repeat = await put();
  check(
    "concurrent uploads import ONCE; a repeat returns the existing outcome",
    uploads.includes("ok") &&
      recs.rows[0].n === 1 &&
      repeat === "ok" &&
      (await job(lease.jobId)).status === "succeeded",
    `${uploads.join(",")} / recs ${recs.rows[0].n} / repeat ${repeat}`,
  );

  // ── 5. cancel wins the race: no Asset ──
  const j5 = await newJob(webA, locA, imgsA);
  const l5 = (await leaseOf(loser)).lease!;
  check("the other device now gets the next job", l5?.jobId === j5.id);
  await progress(
    deps,
    loser.request("POST", jobPaths(l5.jobId, l5.leaseId).progress, {
      protocol: PROTOCOL,
      stage: "uploading",
      progress: 1,
      message: "Uploading",
      result,
    }),
    l5.jobId,
    l5.leaseId,
  );
  const assetsBefore = (await pool.query("select count(*)::int as n from assets where project_id = $1", [A]))
    .rows[0].n;
  await cancelJob(webA, l5.jobId);
  const afterCancel = await codeOf(
    uploadResult(
      deps,
      loser.request("PUT", jobPaths(l5.jobId, l5.leaseId).result, null, { rawBody: bytes }),
      l5.jobId,
      l5.leaseId,
    ),
  );
  const assetsAfter = (await pool.query("select count(*)::int as n from assets where project_id = $1", [A]))
    .rows[0].n;
  check(
    "a cancelled job refuses its result; no Asset is created",
    afterCancel === "job_cancelled" && assetsAfter === assetsBefore,
  );

  // ── 6. lease expiry: reaped (provider_timeout), never re-leased ──
  const j6 = await newJob(webA, locA, imgsA);
  const shortDeps = { ...deps, leaseTtlMs: 1_500 };
  const l6 = (await leaseJob(shortDeps, winner.request("POST", PATHS.lease, { protocol: PROTOCOL }))).lease!;
  await sleep(2_000);
  const reaped = await refreshJob(webA, l6.jobId);
  const third = await device(A);
  const after6 = await leaseOf(third);
  check(
    "an expired lease fails the attempt (provider_timeout) and is never re-leased",
    l6.jobId === j6.id &&
      reaped.status === "failed" &&
      reaped.errorCode === "provider_timeout" &&
      after6.lease === null,
  );

  // ── 7. revocation fails the device's active job at once ──
  const j7 = await newJob(webA, locA, imgsA);
  const l7 = (await leaseOf(third)).lease!;
  await revokeAgent(ownerAgents, A, third.deviceId);
  const failedN = await failJobsOfAgent(deps.jobs, A, dev.id, third.deviceId);
  const r7 = await job(j7.id);
  check(
    "revoking a device fails its active job (never reassigned); its next request is refused",
    l7.jobId === j7.id &&
      failedN === 1 &&
      r7.status === "failed" &&
      (await codeOf(leaseOf(third))) === "device_revoked",
  );

  // ── 8. the same-host worker's discovery never sees a remote job (and vice versa) ──
  const sameHost = createPostgresWorkerStore({ pool, sink, projectScope: A });
  const j8 = await newJob(webA, locA, imgsA);
  const sameHostQueued = await sameHost.listQueued(20);
  const remoteQueued = await deps.jobs.listQueued(A, 20);
  check(
    "same-host discovery returns no local_agent_capture job; remote discovery returns it",
    !sameHostQueued.some((r) => r.id === j8.id) && remoteQueued.some((r) => r.id === j8.id),
  );

  // ── 9. RLS: a stranger's scope reads nothing; anon reads nothing ──
  const strangerScope = await deps.jobs.scope(A, randomUUID());
  check(
    "a stranger's owner scope cannot read the job",
    (await strangerScope.repo.getReconstructionJob(j1.id)) === null,
  );
  const anon = await pool.connect();
  let anonRows = -1;
  try {
    await anon.query(rlsPreamble(null, "anon"));
    anonRows =
      (await anon.query("select 1 from reconstruction_jobs where project_id = $1", [A])).rowCount ?? 0;
  } finally {
    await anon.query("rollback").catch(() => undefined);
    anon.release();
  }
  check("anonymous: no remote job row is visible", anonRows === 0);
  check("no World Labs (or any provider) call was made", worldLabsCalls.length === 0);
} catch (e) {
  check("unexpected error", false, e instanceof Error ? `${e.message.slice(0, 300)}` : String(e));
} finally {
  if (srv) await srv.close();
  const objects = await pool.query(
    "select object_path from assets where project_id = any($1::uuid[]) and object_path is not null",
    [[A, B]],
  );
  for (const r of objects.rows) await sink.remove(String(r.object_path)).catch(() => undefined);
  await pool.query("delete from projects where id = any($1::uuid[])", [[A, B]]).catch(() => undefined);
  const left = await pool.query(
    `select (select count(*) from reconstruction_jobs where project_id = any($1::uuid[]))::int
          + (select count(*) from local_agents where project_id = any($1::uuid[]))::int
          + (select count(*) from assets where project_id = any($1::uuid[]))::int as n`,
    [[A, B]],
  );
  check("cleanup: no fictional job, device, Asset or Storage object remains", left.rows[0].n === 0);
  await rm(tmp, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  await pool.end();
}

let failed = 0;
for (const [name, ok, detail] of results) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

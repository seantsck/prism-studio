// Integration tests for Phase 2F M2D.2 reconstruction jobs against the REAL dedicated Prism Studio database
// (migration 0036: reconstruction_jobs, reconstruction_job_events, generated location_spatial_reconstructions;
// migration 0037: registry-validated provider ids, cost provenance, up to 300 ordered inputs).
//   npm run db:reconstruction-jobs
//
// Exercises (real rows, removed afterwards): owner create/read, the frozen request, the transition matrix enforced BY
// THE DATABASE, compare-and-set, terminal immutability, the never-replaced operation id, retry as a new attempt,
// the atomic job+reconstruction completion with exactly one reconstruction per job (lost race), generated provenance,
// append-only events, owner-only RLS (stranger / anon), NO worker access, cross-project rejection, new provider ids
// without a migration, the frozen cost estimate and the provider-reported actual cost, and cleanup.
// Requires `npm run db:seed` first. No provider call of any kind.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresPrevisData } from "../src/data/previs-postgres";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import {
  FREE_COST_ESTIMATE,
  orderedSources,
  type JobCostEstimate,
  type NewReconstructionJob,
} from "../src/domain/reconstruction/job";
import { UNKNOWN_CALIBRATION } from "../src/domain/previs/splat";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({ mode: "reconstruction job integration tests (rows created, then removed)", devOwner: dev.id });
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 4 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const stranger = randomUUID();
const admin = new AdminRepository(pool, dev.id);
const owner = new PostgresPrevisData(pool, rlsPreamble({ sub: dev.id }));
const strangerRepo = new PostgresPrevisData(pool, rlsPreamble({ sub: stranger }));
const now = () => new Date().toISOString();

async function raw(preamble: string, sql: string, params: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query(preamble);
    const r = await c.query(sql, params);
    return { rows: r.rows, rowCount: r.rowCount ?? 0, error: null as string | null };
  } catch (e) {
    return { rows: [], rowCount: 0, error: (e as Error).message };
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}
const err = (fn: () => Promise<unknown>) =>
  fn().then(
    () => null as string | null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
const sqlErr = (sql: string, params: unknown[] = []) =>
  pool.query(sql, params).then(
    () => null as string | null,
    (e: Error) => e.message,
  );

const created = { projectIds: [] as string[], assetIds: [] as string[], locationIds: [] as string[] };

try {
  const data = (await admin.loadProject("ojousama"))!;
  const projectId = data.project.id;

  // ── structure / security ──
  for (const table of ["reconstruction_jobs", "reconstruction_job_events"]) {
    const rls = await pool.query("select relrowsecurity from pg_class where relname = $1 and relkind = 'r'", [
      table,
    ]);
    check(`${table} exists with row-level security`, rls.rows[0]?.relrowsecurity === true);
    for (const role of ["prism_generation_worker", "prism_continuity_worker"]) {
      const exists = await pool.query("select 1 from pg_roles where rolname = $1", [role]);
      if (exists.rowCount === 0) {
        check(`${role}: not present (skipped)`, true);
        continue;
      }
      const p = await pool.query(
        `select has_table_privilege($1, $2, 'select') or has_table_privilege($1, $2, 'insert')
             or has_table_privilege($1, $2, 'update') or has_table_privilege($1, $2, 'delete') as any`,
        [role, `public.${table}`],
      );
      check(`${role} has NO privilege on ${table}`, p.rows[0].any === false);
    }
  }

  const tmpLocation = randomUUID();
  await pool.query(
    "insert into locations (id, project_id, name, description, geography) values ($1,$2,$3,'','')",
    [tmpLocation, projectId, "db:recon-jobs location"],
  );
  created.locationIds.push(tmpLocation);
  const mkAsset = async (
    name: string,
    type = "image",
    purpose = "location_ref",
    mime = "image/png",
    project = projectId,
  ) => {
    const id = randomUUID();
    await pool.query(
      `insert into assets (id, project_id, name, type, purpose, source, storage_provider, mime, checksum, metadata)
       values ($1,$2,$3,$4,$5,'upload','none',$6,$7,'{}'::jsonb)`,
      [id, project, name, type, purpose, mime, `sum-${id.slice(0, 8)}`],
    );
    created.assetIds.push(id);
    return id;
  };
  const imgs = [await mkAsset("db:recon-jobs img 0"), await mkAsset("db:recon-jobs img 1")];
  const sources = orderedSources(
    imgs.map((id) => ({
      assetId: id,
      checksum: `sum-${id.slice(0, 8)}`,
      mime: "image/png",
      width: 10,
      height: 10,
      byteSize: 4,
    })),
  );
  const newJob = (over: Partial<NewReconstructionJob> = {}): NewReconstructionJob => ({
    id: randomUUID(),
    projectId,
    locationId: tmpLocation,
    attempt: 1,
    previousJobId: null,
    provider: "mock_reconstruction",
    capability: "mock_world",
    model: "mock-1",
    resultKind: "gaussian_splat",
    sources,
    options: { displayName: null, provider: { scenario: "success" } },
    costEstimate: FREE_COST_ESTIMATE("mock-1 · multi_image · test provider"),
    status: "queued",
    userId: dev.id,
    now: now(),
    ...over,
  });

  // ── create, read by value ──
  const j1 = await owner.createReconstructionJob(newJob());
  const back = (await owner.getReconstructionJob(j1.id))!;
  check(
    "a queued job is created by the owner",
    back.status === "queued" && back.revision === 1 && back.attempt === 1,
  );
  check(
    "the ordered source snapshot round-trips by value (order preserved)",
    JSON.stringify(back.sources.map((s) => [s.ordinal, s.assetId])) ===
      JSON.stringify(imgs.map((id, i) => [i, id])),
  );
  check("the job fingerprint is stored", /^[0-9a-f]{64}$/.test(back.jobFingerprint));
  check(
    "the same attempt of the same request cannot be created twice",
    (await err(() => owner.createReconstructionJob(newJob()))) !== null,
  );

  // ── transitions (repository + database) ──
  const s1 = await owner.updateReconstructionJob(j1.id, 1, { status: "submitting" }, now());
  check("queued → submitting", s1.status === "submitting" && s1.revision === 2);
  check(
    "a stale revision is refused (compare-and-set)",
    /changed in the meantime/.test(
      (await err(() =>
        owner.updateReconstructionJob(j1.id, 1, { status: "failed", errorCode: "submit_failed" }, now()),
      )) ?? "",
    ),
  );
  check(
    "the DATABASE refuses an illegal transition (submitting → succeeded) even bypassing the app",
    /not allowed|check|violates/i.test(
      (await sqlErr(
        "update reconstruction_jobs set status = 'ingesting', revision = revision + 1 where id = $1",
        [j1.id],
      )) ?? "",
    ),
  );
  check(
    "the DATABASE refuses a revision that does not advance by one",
    /revision/i.test(
      (await sqlErr("update reconstruction_jobs set progress = 0.1 where id = $1", [j1.id])) ?? "",
    ),
  );
  const r1 = await owner.updateReconstructionJob(
    j1.id,
    2,
    { status: "running", providerOperationId: "mockop_x_1", progress: 0.2 },
    now(),
  );
  check(
    "submitting → running records the operation id and progress",
    r1.providerOperationId === "mockop_x_1" && r1.progress === 0.2,
  );
  check(
    "the operation id is never replaced (database)",
    /never replaced/i.test(
      (await sqlErr(
        "update reconstruction_jobs set provider_operation_id = 'other', revision = revision + 1 where id = $1",
        [j1.id],
      )) ?? "",
    ),
  );
  check(
    "the frozen request cannot be edited (database)",
    /frozen/i.test(
      (await sqlErr(
        "update reconstruction_jobs set source_assets_json = '[]'::jsonb, revision = revision + 1 where id = $1",
        [j1.id],
      )) ?? "",
    ),
  );
  check(
    "provider URLs never land in operation metadata (sanitised on write)",
    !/https?:/.test(
      JSON.stringify(
        (
          await owner.updateReconstructionJob(
            j1.id,
            3,
            { providerOperation: { worldId: "w1", spz: "https://cdn.x/y.spz?sig=1" } },
            now(),
          )
        ).providerOperation,
      ),
    ),
  );

  // ── atomic completion: job + generated reconstruction, exactly once ──
  const resultAsset = await mkAsset(
    "db:recon-jobs result",
    "3d",
    "spatial_reconstruction",
    "application/x-spz",
  );
  const ing = await owner.updateReconstructionJob(j1.id, 4, { status: "ingesting" }, now());
  const recIn = (id: string, asset: string) => ({
    id,
    projectId,
    locationId: tmpLocation,
    method: "generated" as const,
    resultKind: "gaussian_splat" as const,
    resultAssetId: asset,
    resultChecksum: "res-sum",
    resultFormat: "spz" as const,
    gaussianCount: 576,
    sources: sources.map((s) => ({ assetId: s.assetId, checksum: s.checksum })),
    calibration: { ...UNKNOWN_CALIBRATION },
    generation: {
      jobId: j1.id,
      attempt: 1,
      provider: "mock_reconstruction",
      capability: "mock_world",
      model: "mock-1",
      operationId: "mockop_x_1",
      metadata: { resolution: "full_res" },
    },
    userId: dev.id,
    now: now(),
  });
  const done = await owner.completeReconstructionJob({
    jobId: j1.id,
    expectedRevision: ing.revision,
    reconstruction: recIn(randomUUID(), resultAsset),
    providerResult: { resolution: "full_res" },
    now: now(),
  });
  check(
    "ingesting → succeeded together with its reconstruction",
    done.job.status === "succeeded" && done.job.resultReconstructionId === done.reconstruction.id,
  );
  check(
    "the generated reconstruction keeps the job's ORDER and its provider provenance",
    JSON.stringify(done.reconstruction.sources.map((s) => s.assetId)) === JSON.stringify(imgs) &&
      done.reconstruction.method === "generated" &&
      done.reconstruction.generation?.jobId === j1.id &&
      done.reconstruction.generation?.operationId === "mockop_x_1",
  );
  const otherAsset = await mkAsset(
    "db:recon-jobs result 2",
    "3d",
    "spatial_reconstruction",
    "application/x-spz",
  );
  check(
    "a second completion of the same job loses (no second reconstruction)",
    (await err(() =>
      owner.completeReconstructionJob({
        jobId: j1.id,
        expectedRevision: ing.revision,
        reconstruction: recIn(randomUUID(), otherAsset),
        providerResult: null,
        now: now(),
      }),
    )) !== null,
  );
  check(
    "the database allows exactly ONE reconstruction per job even when inserted directly",
    (await err(() => owner.recordReconstruction(recIn(randomUUID(), otherAsset)))) !== null,
  );
  check(
    "a generated reconstruction must name its job (database check)",
    (await sqlErr(
      `insert into location_spatial_reconstructions (project_id, location_id, schema_version, method, result_kind, result_asset_id,
         result_format, source_assets_json, calibration_json, reconstruction_fingerprint)
       values ($1,$2,'prism.spatial-reconstruction.v1','generated','gaussian_splat',$3,'spz','[]'::jsonb,'{}'::jsonb,$4)`,
      [projectId, tmpLocation, otherAsset, "d".repeat(64)],
    )) !== null,
  );
  check(
    "a finished job is immutable history (database)",
    /immutable/i.test(
      (await sqlErr("update reconstruction_jobs set progress = 0.5, revision = revision + 1 where id = $1", [
        j1.id,
      ])) ?? "",
    ),
  );
  check(
    "the reconstruction itself stays immutable",
    /immutable/i.test(
      (await sqlErr("update location_spatial_reconstructions set provider_model = 'x' where id = $1", [
        done.reconstruction.id,
      ])) ?? "",
    ),
  );

  // ── failure + retry as a NEW attempt ──
  const j2 = await owner.createReconstructionJob(
    newJob({ options: { displayName: null, provider: { scenario: "fail" } } }),
  );
  await owner.updateReconstructionJob(j2.id, 1, { status: "submitting" }, now());
  check(
    "failed without an error code is refused (database)",
    (await sqlErr(
      "update reconstruction_jobs set status = 'failed', revision = revision + 1, completed_at = now() where id = $1",
      [j2.id],
    )) !== null,
  );
  const f2 = await owner.updateReconstructionJob(
    j2.id,
    2,
    { status: "failed", errorCode: "submit_failed", errorMessage: "refused at https://x.y/z?token=1" },
    now(),
  );
  check(
    "a failure records a code and a URL-free message",
    f2.status === "failed" && f2.errorCode === "submit_failed" && !/https?:/.test(f2.errorMessage ?? ""),
  );
  const retry = await owner.createReconstructionJob(
    newJob({ attempt: 2, previousJobId: j2.id, options: f2.options }),
  );
  check(
    "retry is a new attempt row linked to the failed one; the failed one is unchanged",
    retry.attempt === 2 &&
      retry.previousJobId === j2.id &&
      (await owner.getReconstructionJob(j2.id))!.revision === f2.revision,
  );

  // ── 0037: provider identity from the registry, cost provenance, input bounds ──
  const local = await owner.createReconstructionJob(
    newJob({
      provider: "local_capture",
      capability: "local_capture",
      model: null,
      options: { displayName: null, provider: {} },
    }),
  );
  const future = await owner.createReconstructionJob(
    newJob({
      provider: "future_provider_x",
      capability: "x",
      model: null,
      options: { displayName: null, provider: {} },
    }),
  );
  check(
    "a provider id the 0036 list never named is stored with NO migration (the registry decides what is known)",
    local.provider === "local_capture" &&
      (await owner.getReconstructionJob(future.id))!.provider === "future_provider_x",
  );
  const rawJob = (provider: string, sourcesJson: string) =>
    sqlErr(
      `insert into reconstruction_jobs (project_id, location_id, schema_version, job_fingerprint, attempt, provider,
         provider_capability, requested_result_kind, source_assets_json, options_json, status)
       values ($1,$2,'prism.reconstruction-job.v1',$3,1,$4,'x','gaussian_splat',$5::jsonb,'{}'::jsonb,'queued')`,
      [projectId, tmpLocation, randomUUID().replace(/-/g, "").padEnd(64, "0"), provider, sourcesJson],
    );
  const oneSource = JSON.stringify([
    {
      ordinal: 0,
      assetId: imgs[0],
      checksum: null,
      mime: "image/png",
      width: null,
      height: null,
      byteSize: null,
    },
  ]);
  check(
    "an unsafe provider identifier is refused by the DATABASE",
    (await rawJob("Bad Id; drop", oneSource)) !== null && (await rawJob("x".repeat(65), oneSource)) !== null,
  );
  check(
    "a stored source without an input kind (pre-0037) reads back as an image",
    await (async () => {
      const fp = randomUUID().replace(/-/g, "").padEnd(64, "1");
      const r = await pool.query(
        `insert into reconstruction_jobs (project_id, location_id, schema_version, job_fingerprint, attempt, provider,
           provider_capability, requested_result_kind, source_assets_json, options_json, status)
         values ($1,$2,'prism.reconstruction-job.v1',$3,1,'meshy','x','gaussian_splat',$4::jsonb,'{}'::jsonb,'queued')
         returning id`,
        [projectId, tmpLocation, fp, oneSource],
      );
      const back = await owner.getReconstructionJob(r.rows[0].id);
      // ('meshy' was in the 0036 list and has no adapter: such history stays readable)
      return back?.sources[0]?.kind === "image" && back.provider === "meshy" && back.costEstimate === null;
    })(),
  );
  const many = (n: number) =>
    JSON.stringify(
      Array.from({ length: n }, (_, i) => ({
        ordinal: i,
        assetId: randomUUID(),
        checksum: null,
        mime: "image/png",
        width: null,
        height: null,
        byteSize: null,
      })),
    );
  check(
    "up to 300 ordered inputs are accepted (local capture); 301 are refused by the DATABASE",
    (await rawJob("local_capture", many(300))) === null &&
      (await rawJob("local_capture", many(301))) !== null,
  );
  const paidEstimate: JobCostEstimate = {
    costClass: "paid",
    usd: { min: 1.2, max: 1.264 },
    providerUnits: { unit: "credits", min: 1500, max: 1580 },
    basis: "marble-1.1 · single_image",
    pricingSource: "World Labs API pricing (docs.worldlabs.ai/api/pricing)",
    pricingCheckedAt: "2026-10-19",
  };
  const costed = await owner.createReconstructionJob(
    newJob({
      provider: "worldlabs_marble",
      capability: "worlds:generate",
      model: "marble-1.1",
      costEstimate: paidEstimate,
      options: { displayName: null, provider: { reconstructImages: false } },
    }),
  );
  check(
    "the cost estimate is persisted with its pricing source and check date",
    JSON.stringify((await owner.getReconstructionJob(costed.id))!.costEstimate) ===
      JSON.stringify(paidEstimate),
  );
  check(
    "the cost estimate is frozen with the request (database)",
    /frozen/i.test(
      (await sqlErr(
        "update reconstruction_jobs set cost_estimate_json = '{}'::jsonb, revision = revision + 1 where id = $1",
        [costed.id],
      )) ?? "",
    ),
  );
  const c1 = await owner.updateReconstructionJob(costed.id, 1, { status: "submitting" }, now());
  const c2 = await owner.updateReconstructionJob(
    costed.id,
    c1.revision,
    {
      status: "running",
      providerOperationId: "op_cost_1",
      actualCost: { usd: null, providerUnits: { unit: "credits", amount: 1580 }, reportedAt: now() },
    },
    now(),
  );
  check(
    "a provider-REPORTED actual cost is recorded separately (no actual cost exists until reported)",
    costed.actualCost === null &&
      (await owner.getReconstructionJob(c2.id))!.actualCost?.providerUnits?.amount === 1580,
  );
  check(
    "a generated reconstruction's provider is constrained to the same safe identifier shape (database)",
    String(
      (
        await pool.query(
          "select pg_get_constraintdef(oid) d from pg_constraint where conname = 'location_spatial_reconstructions_provider_check'",
        )
      ).rows[0]?.d ?? "",
    ).includes("a-z0-9_"),
  );

  // ── events ──
  await owner.appendReconstructionJobEvent({
    projectId,
    jobId: j1.id,
    event: "submitted",
    detail: { url: "https://leak.example/x", operation: "…x_1" },
    now: now(),
  });
  const evs = await owner.listReconstructionJobEvents(j1.id);
  check(
    "events are appended and sanitised (no URL)",
    evs.length === 1 && !/https?:/.test(JSON.stringify(evs)),
  );
  check(
    "events are append-only (database)",
    /append-only/i.test(
      (await sqlErr("update reconstruction_job_events set event = 'failed' where job_id = $1", [j1.id])) ??
        "",
    ),
  );

  // ── RLS ──
  check("stranger cannot read a job", (await strangerRepo.getReconstructionJob(j1.id)) === null);
  check(
    "stranger cannot list the location's jobs",
    (await strangerRepo.listReconstructionJobs(tmpLocation)).length === 0,
  );
  check("stranger cannot read events", (await strangerRepo.listReconstructionJobEvents(j1.id)).length === 0);
  check(
    "stranger cannot create a job in this project",
    (await err(() => strangerRepo.createReconstructionJob(newJob()))) !== null,
  );
  check(
    "anonymous cannot read jobs",
    (await raw(rlsPreamble(null, "anon"), "select 1 from reconstruction_jobs")).rowCount === 0,
  );

  // ── cross-project ──
  const otherProject = randomUUID();
  await pool.query("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,$4,'test')", [
    otherProject,
    dev.id,
    `db-recon-jobs-${otherProject.slice(0, 8)}`,
    "db:recon-jobs other project",
  ]);
  created.projectIds.push(otherProject);
  check(
    "a job cannot point at a location of another project",
    (await err(() => owner.createReconstructionJob(newJob({ projectId: otherProject })))) !== null,
  );
  check(
    "a job cannot retry a job of another project",
    (await err(async () => {
      const foreignLoc = randomUUID();
      await pool.query(
        "insert into locations (id, project_id, name, description, geography) values ($1,$2,'db:recon-jobs foreign','','')",
        [foreignLoc, otherProject],
      );
      created.locationIds.push(foreignLoc);
      await owner.createReconstructionJob(
        newJob({ projectId: otherProject, locationId: foreignLoc, previousJobId: j2.id, attempt: 2 }),
      );
    })) !== null,
  );

  // ── cascade ──
  await pool
    .query("delete from location_spatial_reconstructions where location_id = $1", [tmpLocation])
    .catch(() => undefined);
  await pool.query("delete from locations where id = $1", [tmpLocation]);
  created.locationIds.splice(created.locationIds.indexOf(tmpLocation), 1);
  check(
    "deleting the location removes its jobs and events",
    (
      await pool.query("select count(*)::int n from reconstruction_jobs where location_id = $1", [
        tmpLocation,
      ])
    ).rows[0].n === 0 &&
      (await pool.query("select count(*)::int n from reconstruction_job_events where job_id = $1", [j1.id]))
        .rows[0].n === 0,
  );
} finally {
  for (const id of created.locationIds) {
    await pool
      .query("delete from location_spatial_reconstructions where location_id = $1", [id])
      .catch(() => undefined);
    await pool.query("delete from locations where id = $1", [id]).catch(() => undefined);
  }
  for (const id of created.projectIds)
    await pool.query("delete from projects where id = $1", [id]).catch(() => undefined);
  for (const id of created.assetIds)
    await pool.query("delete from assets where id = $1", [id]).catch(() => undefined);
}

const leftover = await pool.query(
  `select (select count(*)::int from reconstruction_jobs j join locations l on l.id = j.location_id where l.name like 'db:recon-jobs%') as jobs,
          (select count(*)::int from assets where name like 'db:recon-jobs%') as assets,
          (select count(*)::int from locations where name like 'db:recon-jobs%') as locations,
          (select count(*)::int from projects where title like 'db:recon-jobs%') as projects`,
);
const l = leftover.rows[0];
check(
  "cleanup left no test rows",
  l.jobs === 0 && l.assets === 0 && l.locations === 0 && l.projects === 0,
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

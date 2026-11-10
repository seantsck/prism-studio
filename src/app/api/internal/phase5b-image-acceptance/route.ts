import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";
import { AdminRepository, rlsPreamble } from "@/data/postgres-repository";
import { PostgresGenerationData } from "@/data/generation-postgres";
import { PostgresCandidateData } from "@/data/candidates-postgres";
import { PostgresLocationViewData } from "@/data/location-view-postgres";
import { PostgresProductionFrameData } from "@/data/production-frame-postgres";
import type { ProjectData } from "@/domain/schemas";
import { planCandidateSet, submitCandidateSet, type CandidateSelection } from "@/generation/candidate-set";
import { readGenerationConfig } from "@/generation/config";
import { createRegistry } from "@/generation/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPECTED_REF = "lyqdxiyjperhniwhzsvg";
const PROJECT_SLUG = "ojousama";
const SHOT_CODE = "3A";
const PROVIDER = "openai-image";
const MODEL = "gpt-image-2.5-flare";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}
function safeError(err: unknown) {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, "postgresql://[redacted]@")
    .replace(/password\s*=\s*[^\s;]+/gi, "password=[redacted]");
}

async function loadData(pool: Pool) {
  const p = await pool.query("select id, user_id from projects where slug = $1", [PROJECT_SLUG]);
  if (p.rowCount !== 1) throw new Error(`Expected one ${PROJECT_SLUG} project, got ${p.rowCount ?? 0}`);
  const projectId = String(p.rows[0].id);
  const ownerId = String(p.rows[0].user_id);
  const admin = new AdminRepository(pool, ownerId);
  const base = await admin.loadProject(PROJECT_SLUG);
  if (!base) throw new Error("Ojou-sama project could not be loaded");
  const shot = base.shots.find((s) => s.shotCode === SHOT_CODE);
  if (!shot) throw new Error("Shot 3A could not be loaded");

  const owner = rlsPreamble({ sub: ownerId });
  const locationViewRepo = new PostgresLocationViewData(pool, owner);
  const productionFrameRepo = new PostgresProductionFrameData(pool, owner);
  const [{ views, selections: viewSelections }, { frames, selections: frameSelections }] = await Promise.all([
    locationViewRepo.listForProject(projectId),
    productionFrameRepo.listForProject(projectId),
  ]);
  const data: ProjectData = {
    ...base,
    locationViews: views,
    shotLocationViewSelections: viewSelections,
    productionFrames: frames,
    productionFrameSelections: frameSelections,
  };
  return { data, projectId, ownerId, shot, owner };
}

function acceptanceEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PRISM_STUDIO_GENERATION_PROVIDERS: "openai-image",
    PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "0",
    PRISM_STUDIO_ALLOW_PAID_GENERATION: "1",
    PRISM_STUDIO_MAX_GENERATION_USD: "0.50",
    PRISM_STUDIO_MAX_CANDIDATE_SET_USD: "0.50",
    PRISM_STUDIO_MAX_CANDIDATES_PER_SET: "1",
  };
}

async function existingAttempt(pool: Pool, shotId: string) {
  const r = await pool.query(
    `select a.id, a.status, a.cost_usd, a.input_asset_ids, a.package_fingerprint,
            a.created_at, j.id job_id, j.status job_status, j.estimated_cost, j.actual_cost,
            j.provider_job_id, j.last_error_code, j.last_error_category, j.last_error_message
       from generation_attempts a
       left join generation_jobs j on j.attempt_id = a.id
      where a.shot_id = $1
        and a.provider = $2
        and a.model = $3
        and a.request->>'purpose' = 'production_frame'
      order by a.created_at desc
      limit 1`,
    [shotId, PROVIDER, MODEL],
  );
  return r.rows[0] ?? null;
}

async function statusPayload(pool: Pool, attemptId: string) {
  const a = await pool.query(
    `select a.id, a.status, a.cost_usd, a.input_asset_ids, a.package_fingerprint,
            a.created_at, jsonb_array_length(coalesce(a.request->'references','[]'::jsonb)) reference_count,
            j.id job_id, j.status job_status, j.estimated_cost, j.actual_cost, j.provider_job_id,
            j.last_error_code, j.last_error_category, j.last_error_message
       from generation_attempts a
       left join generation_jobs j on j.attempt_id = a.id
      where a.id = $1`,
    [attemptId],
  );
  const outputs = await pool.query(
    `select o.asset_id, o.role, a.name, a.checksum, a.width, a.height, a.object_path
       from generation_outputs o
       join assets a on a.id = o.asset_id
      where o.attempt_id = $1
      order by o.role, o.asset_id`,
    [attemptId],
  );
  const costs = await pool.query(
    "select kind, amount, currency, basis, units, recorded_at from generation_costs where attempt_id = $1 order by recorded_at",
    [attemptId],
  );
  return { attempt: a.rows[0] ?? null, outputs: outputs.rows, costs: costs.rows };
}

export async function GET(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview") return json({ ok: false, message: "Not available outside preview" }, 404);
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl || !dbUrl.includes(EXPECTED_REF))
    return json({ ok: false, message: "Prism Studio database URL unavailable or wrong target" }, 503);

  const mode = request.nextUrl.searchParams.get("mode") ?? "plan";
  if (!["plan", "submit", "status"].includes(mode))
    return json({ ok: false, message: "mode must be plan, submit or status" }, 400);

  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false }, max: 4 });
  try {
    const { data, projectId, ownerId, shot, owner } = await loadData(pool);
    const existing = await existingAttempt(pool, shot.id);
    if (mode === "status") {
      if (!existing) return json({ ok: true, mode, exists: false });
      return json({ ok: true, mode, exists: true, ...(await statusPayload(pool, String(existing.id))) });
    }

    const env = acceptanceEnv();
    const config = readGenerationConfig(env);
    const registry = createRegistry(env, config);
    const generation = new PostgresGenerationData(pool, owner);
    const candidates = new PostgresCandidateData(pool, owner);
    const selection: CandidateSelection = {
      provider: PROVIDER,
      modelId: MODEL,
      quality: "medium",
    };
    const outcomes = await candidates.listOutcomeRecords(projectId);
    const plan = planCandidateSet({
      data,
      shotId: shot.id,
      registry,
      config,
      selections: [selection],
      outcomes,
      purpose: "production_frame",
    });
    const item = plan.items[0]!;
    const pkg = item.evaluation.pkg;
    const wired = await pool.query(
      `select asset_id from shot_reference_assets
        where shot_id = $1 and role = 'reference' order by position`,
      [shot.id],
    );
    const wiredIds = wired.rows.map((r) => String(r.asset_id));
    const packageIds = pkg.references.referenceAssetIds;
    const exactSix =
      wiredIds.length === 6 &&
      packageIds.length === 6 &&
      JSON.stringify(wiredIds) === JSON.stringify(packageIds);

    const summary = {
      shotId: shot.id,
      shotCode: shot.shotCode,
      provider: PROVIDER,
      model: MODEL,
      quality: "medium",
      allowed: plan.allowed,
      blockers: plan.blockers,
      estimateUsd: item.estimateUsd,
      confirmedTotalUsd: plan.spend.totalUsd,
      perGenerationCeilingUsd: config.paid.maxUsd,
      candidateSetCeilingUsd: config.candidateSet.maxUsd,
      referenceAssetIds: packageIds,
      wiredReferenceAssetIds: wiredIds,
      exactSix,
      selectedLocationView: pkg.references.locationView
        ? {
            viewId: pkg.references.locationView.viewId,
            name: pkg.references.locationView.name,
            assetId: pkg.references.locationView.assetId,
          }
        : null,
      packageFingerprint: plan.packageFingerprint,
      existingAttempt: existing
        ? {
            id: String(existing.id),
            status: String(existing.status),
            jobStatus: existing.job_status == null ? null : String(existing.job_status),
          }
        : null,
    };

    if (mode === "plan") return json({ ok: true, mode, summary });
    if (existing)
      return json({ ok: false, mode, message: "The one-time Shot 3A acceptance attempt already exists.", summary }, 409);
    if (!plan.allowed) return json({ ok: false, mode, message: plan.blockers[0] ?? "Candidate is blocked", summary }, 409);
    if (!exactSix)
      return json({ ok: false, mode, message: "The generation package does not exactly match the six wired references.", summary }, 409);
    if (!pkg.references.locationView || pkg.references.locationView.name !== "Entrance toward elevators")
      return json({ ok: false, mode, message: "The intended Location View is not frozen into the package.", summary }, 409);
    if (plan.spend.totalUsd == null || plan.spend.totalUsd > 0.5)
      return json({ ok: false, mode, message: "Estimated spend is absent or exceeds the $0.50 acceptance cap.", summary }, 409);

    const revision = await generation.projectRevision(PROJECT_SLUG);
    if (!revision) return json({ ok: false, mode, message: "Project revision unavailable" }, 409);
    const out = await submitCandidateSet({
      data,
      shotId: shot.id,
      registry,
      config,
      generation,
      candidates,
      selections: [selection],
      acknowledgeAll: true,
      confirmedTotalUsd: plan.spend.totalUsd,
      title: "Phase 5B hosted acceptance — Shot 3A",
      purpose: "First reference-driven Production Frame acceptance",
      userId: ownerId,
      projectRevision: revision.revision,
      generationPurpose: "production_frame",
    });
    const attemptId = out.view.members[0]?.attemptId ?? null;
    if (out.submitted !== 1 || out.failed.length || !attemptId)
      return json({ ok: false, mode, message: "Candidate set did not submit exactly one attempt.", out, summary }, 500);

    return json({
      ok: true,
      mode,
      submitted: out.submitted,
      failed: out.failed,
      setId: out.view.set.id,
      attemptId,
      summary,
      status: await statusPayload(pool, attemptId),
    });
  } catch (err) {
    return json({ ok: false, message: safeError(err) }, 500);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

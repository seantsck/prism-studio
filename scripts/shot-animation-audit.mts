// Zero-spend, READ-ONLY audit of one Shot's animation inputs: what Prism would send a video model, and whether the
// inputs are right, BEFORE any money is spent.
//   npm run audit:shot                       Shot 3A of ojousama, Runway Gen-4.5 and Gen-4 Turbo
//   npm run audit:shot -- --shot 2E --model gen4_turbo
//   npm run audit:shot -- --json             machine-readable
//   npm run audit:shot -- --strict           exit 1 unless the Shot is ready for a paid take
//
// SPENDS NOTHING and sends nothing to any provider: it only evaluates (the same pure functions the Animate panel and
// the spend gate use) and prints. It WRITES NOTHING: in supabase mode every transaction is opened READ ONLY, so a
// write would be refused by Postgres itself.
//   memory mode (default)                 the seeded demo project
//   PRISM_STUDIO_PERSISTENCE=supabase     the configured Prism Studio database (same guards as every db:* script)
//
// It answers, for the selected Production Frame:
//   1. Do the Character identity, the wardrobe Look and the Location View exist as stored images, and where did each
//      come from (uploaded original / generated reference)?
//   2. Was the Production Frame actually generated from them (its attempt's frozen inputs)?
//   3. Exactly what would the provider receive: endpoint, images, transport, prompt, duration, estimated cost?
//   4. Which earlier takes started from this frame, how were they judged, and is this request identical to one?
import pg from "pg";
import { PostgresCandidateData } from "../src/data/candidates-postgres";
import { PostgresCharacterContinuityData } from "../src/data/character-continuity-postgres";
import { PostgresLocationViewData } from "../src/data/location-view-postgres";
import { MemoryRepository } from "../src/data/memory-repository";
import { AdminRepository } from "../src/data/postgres-repository";
import { PostgresProductionFrameData } from "../src/data/production-frame-postgres";
import { buildShotContext } from "../src/domain/context";
import { assembleGenerationPackage } from "../src/domain/generation-package";
import { animationSource } from "../src/domain/generation/animation";
import { catalogModel } from "../src/domain/generation/models/catalog";
import { evaluateModelFit } from "../src/domain/generation/models/matrix";
import type { OutcomeRecord } from "../src/domain/generation/performance";
import { notesNotSent, parseFrozenProviderPrompt } from "../src/domain/generation/provider-prompt";
import { REFERENCE_ORIGIN_LABEL, shotReferenceIntegrity } from "../src/domain/generation/reference-integrity";
import { isPreSpendAcknowledgement, priorTakes } from "../src/domain/generation/retake";
import type { GenerationRequest } from "../src/domain/generation/schemas";
import type { ProjectData } from "../src/domain/schemas";
import { readGenerationConfig } from "../src/generation/config";
import { createRegistry } from "../src/generation/registry";
import { evaluateShotForModel, prepareSubmission } from "../src/generation/submission";
import { startScript } from "./lib/safety.mjs";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const slug = opt("project", "ojousama");
const shotCode = opt("shot", "3A");
const modelIds = args.includes("--model") ? [opt("model", "gen4.5")] : ["gen4.5", "gen4_turbo"];
const asJson = flag("json");
const supabase = process.env.PRISM_STUDIO_PERSISTENCE === "supabase";

// ───────── load (read-only) ─────────
let pool: pg.Pool | null = null;
async function load(): Promise<{ data: ProjectData; outcomes: OutcomeRecord[] }> {
  if (!supabase) {
    const repo = new MemoryRepository();
    const data = await repo.loadProject(slug);
    if (!data) throw new Error(`No project "${slug}" in the seeded demo data.`);
    const pf = await repo.productionFrames.listForProject(data.project.id);
    const lv = await repo.locationViews.listForProject(data.project.id);
    const cc = await repo.characterContinuity.listForProject(data.project.id);
    return {
      data: {
        ...data,
        productionFrames: pf.frames,
        productionFrameSelections: pf.selections,
        locationViews: lv.views,
        shotLocationViewSelections: lv.selections,
        characterContinuityLocks: cc.locks,
        shotCharacterContinuitySelections: cc.selections,
      },
      outcomes: await repo.candidates.listOutcomeRecords(data.project.id),
    };
  }
  // not on the production allow-list (that list is the owner's to extend): DEV / staging / rehearsal targets only
  const url = startScript({ mode: "shot animation audit (READ-ONLY, zero spend)" });
  pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  // every transaction this script opens is READ ONLY: Postgres itself would refuse a write
  const READ_ONLY = "begin transaction read only";
  class ReadOnlyAdminRepository extends AdminRepository {
    protected override preamble(): string {
      return READ_ONLY;
    }
  }
  const owner = await pool.query("select id, user_id from projects where slug = $1 limit 1", [slug]);
  if (!owner.rows[0]) throw new Error(`No project "${slug}" in this database.`);
  const projectId = String(owner.rows[0].id);
  const data = await new ReadOnlyAdminRepository(pool, String(owner.rows[0].user_id)).loadProject(slug);
  if (!data) throw new Error(`Project "${slug}" could not be loaded.`);
  const pf = await new PostgresProductionFrameData(pool, READ_ONLY).listForProject(projectId);
  const lv = await new PostgresLocationViewData(pool, READ_ONLY).listForProject(projectId);
  const cc = await new PostgresCharacterContinuityData(pool, READ_ONLY).listForProject(projectId);
  return {
    data: {
      ...data,
      productionFrames: pf.frames,
      productionFrameSelections: pf.selections,
      locationViews: lv.views,
      shotLocationViewSelections: lv.selections,
      characterContinuityLocks: cc.locks,
      shotCharacterContinuitySelections: cc.selections,
    },
    outcomes: await new PostgresCandidateData(pool, READ_ONLY).listOutcomeRecords(projectId),
  };
}

// ───────── evaluate (pure; a registry that can price Runway but can never reach it) ─────────
// The provider is marked worker-backed so no credential is read here, and paid generation is "on" with a ceiling ONLY
// so the estimate and the frozen request can be computed. Nothing is queued: `prepareSubmission` builds a record that
// this script prints and discards.
const auditEnv = {
  PRISM_STUDIO_GENERATION_PROVIDERS: "runway",
  PRISM_STUDIO_WORKER_BACKED_PROVIDERS: "runway",
  PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
  PRISM_STUDIO_MAX_GENERATION_USD: "5",
};
const config = readGenerationConfig(auditEnv);
const registry = createRegistry(auditEnv, config);

const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : "—");

try {
  const { data, outcomes } = await load();
  const shot = data.shots.find((s) => s.shotCode === shotCode);
  if (!shot) throw new Error(`No Shot "${shotCode}" in project "${slug}".`);
  const ctx = buildShotContext(data, shot.id);
  const pkg = assembleGenerationPackage(ctx);
  const integrity = shotReferenceIntegrity(ctx, pkg, data.attempts);
  const source = animationSource(pkg);
  const frame = ctx.selectedProductionFrame;
  const asset = (id: string | null) => (id ? ctx.assets.get(id) : undefined);

  const models = modelIds.map((modelId) => {
    const model = registry.model("runway", modelId);
    if (!model) return { modelId, error: `Unknown Runway model ${modelId}.` };
    // the same recommended adaptation the Animate comparison previews (never silently applied in the product)
    const fit = evaluateModelFit({
      pkg,
      model,
      catalog: catalogModel("runway", modelId),
      availability: registry.availabilityOf(model),
      options: {
        protectedNotes: ctx.shot.generation.protectedComposition,
        purpose: "animate_production_frame",
      },
    });
    const base = {
      data,
      shotId: shot.id,
      registry,
      provider: "runway",
      modelId,
      purpose: "animate_production_frame" as const,
      adaptation: fit.adaptationChoice,
      verdicts: outcomes,
    };
    const evaluation = evaluateShotForModel({ ...base, acknowledged: [] });
    const acknowledgements = evaluation.gate.unacknowledged;
    const prepared = prepareSubmission({
      ...base,
      acknowledged: acknowledgements.map((f) => f.id),
      userId: null,
      idempotencyKey: "audit-only-never-submitted",
      config,
    });
    const request = (prepared.input?.attempt.request ?? null) as unknown as GenerationRequest | null;
    const adapter = registry.adapter("runway")!;
    const compiled =
      request && prepared.input?.attempt.promptPlan
        ? adapter.compileRequest(request, prepared.input.attempt.promptPlan)
        : null;
    const prompt = parseFrozenProviderPrompt(request?.providerOptions?.prismProviderPrompt);
    return {
      modelId,
      displayName: model.displayName,
      blockers: evaluation.gate.blockers.map((b) => b.message),
      adaptation: fit.adaptationChoice ?? null,
      estimateUsd: prepared.input?.estimate.amount ?? evaluation.estimate?.amount ?? null,
      estimateBasis: prepared.input?.estimate.basis ?? evaluation.estimate?.basis ?? null,
      endpoint: compiled?.endpoint ?? null,
      durationMs: request?.durationMs ?? null,
      imagesSent: compiled?.attachments ?? [],
      referenceImagesSent: request?.references.length ?? 0,
      transport: compiled?.fields.startFrameTransport ?? null,
      prompt: prompt
        ? {
            policy: `${prompt.policy.id}@v${prompt.policy.version}`,
            ok: prompt.ok,
            problem: prompt.problem,
            length: prompt.length,
            limit: prompt.budget.limit,
            text: prompt.text,
            notesNotSent: notesNotSent(prompt),
          }
        : null,
      preSpend: acknowledgements.filter((f) => isPreSpendAcknowledgement(f.id)),
      otherAcknowledgements: acknowledgements.filter((f) => !isPreSpendAcknowledgement(f.id)),
      priorTakes: request
        ? priorTakes({ attempts: data.attempts, verdicts: outcomes, shotId: shot.id, request })
        : [],
    };
  });

  const outstanding = [
    ...(source.ok ? [] : source.issues.map((i) => i.message)),
    // "no frame selected" is already the source issue above
    ...(integrity.lineage.status === "verified" || integrity.lineage.status === "none"
      ? []
      : [integrity.lineage.message]),
    ...integrity.slots
      .filter((s) => s.kind !== "location" && s.status === "missing")
      .map((s) => `${s.subject} — ${s.label}: ${s.detail}`),
  ];
  const report = {
    mode: supabase ? "supabase (read-only)" : "memory (seeded demo)",
    project: slug,
    shot: { code: shot.shotCode, title: shot.title, durationMs: pkg.timing.durationMs },
    productionFrame: frame
      ? {
          version: frame.version,
          source: frame.source,
          assetId: frame.assetId,
          width: frame.width,
          height: frame.height,
          freshness: pkg.references.productionFrame?.freshness ?? "unknown",
          changedParts: pkg.references.productionFrame?.changedParts ?? [],
          sourceAttemptId: frame.sourceGenerationAttemptId,
        }
      : null,
    references: integrity.slots.map((s) => ({
      ...s,
      width: asset(s.assetId)?.width ?? null,
      height: asset(s.assetId)?.height ?? null,
    })),
    lineage: integrity.lineage,
    models,
    readyForPaidTake: outstanding.length === 0,
    outstanding,
  };

  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    const hr = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(3, 74 - t.length))}`);
    console.log(`SHOT ANIMATION AUDIT · ${report.mode} · zero spend, nothing sent, nothing written`);
    console.log(
      `${slug} · Shot ${shot.shotCode} "${shot.title}" · ${Number((pkg.timing.durationMs / 1000).toFixed(2))} s`,
    );

    hr("1. References (what a Production Frame should be made from)");
    for (const s of report.references)
      console.log(
        `  ${s.status === "ready" ? "IMAGE     " : "WORDS ONLY"}  ${s.subject} — ${s.label}` +
          (s.assetId
            ? `  [${short(s.assetId)} · ${s.width ?? "?"}×${s.height ?? "?"} · ${s.origin ? REFERENCE_ORIGIN_LABEL[s.origin] : "unknown origin"}]`
            : "") +
          `\n              ${s.detail}`,
      );
    if (report.references.length === 0)
      console.log("  (this Shot has no Character or Location to reference)");

    hr("2. Production Frame and its lineage");
    if (report.productionFrame) {
      const f = report.productionFrame;
      console.log(
        `  v${f.version} · ${f.source} · ${f.width}×${f.height} · asset ${short(f.assetId)} · ${f.freshness}` +
          (f.changedParts.length ? ` (changed: ${f.changedParts.join(", ")})` : ""),
      );
    }
    console.log(`  ${integrity.lineage.status.toUpperCase()}: ${integrity.lineage.message}`);
    for (const s of integrity.lineage.consumed) console.log(`    used      ${s.subject} — ${s.label}`);
    for (const s of integrity.lineage.missing) console.log(`    NOT used  ${s.subject} — ${s.label}`);
    if (!source.ok) for (const i of source.issues) console.log(`  BLOCKED: ${i.message}`);

    for (const m of models) {
      hr(`3. What ${"displayName" in m ? m.displayName : m.modelId} would receive`);
      if ("error" in m) {
        console.log(`  ${m.error}`);
        continue;
      }
      for (const b of m.blockers) console.log(`  BLOCKED: ${b}`);
      if (!m.endpoint) continue;
      console.log(
        `  ${m.endpoint} · ${(m.durationMs ?? 0) / 1000} s · estimate $${m.estimateUsd?.toFixed(2) ?? "?"}`,
      );
      console.log(`    (${m.estimateBasis})`);
      console.log(
        `  images sent: ${m.imagesSent.map((a) => `${a.role} ${short(a.assetId)}`).join(", ") || "none"}` +
          ` · reference images sent: ${m.referenceImagesSent}`,
      );
      if (m.transport) console.log(`  first-frame transport: ${JSON.stringify(m.transport)}`);
      if (m.prompt) {
        console.log(
          `  prompt (${m.prompt.policy}, ${m.prompt.length}/${m.prompt.limit}${m.prompt.ok ? "" : ", REFUSED"}):`,
        );
        console.log(`    ${m.prompt.text}`);
        if (m.prompt.problem) console.log(`    PROBLEM: ${m.prompt.problem}`);
        for (const n of m.prompt.notesNotSent) console.log(`    not sent: "${n.source}" — ${n.reason}`);
      }
      for (const c of m.preSpend) console.log(`  CONFIRM BEFORE SPEND: ${c.label}\n    ${c.impact}`);
      console.log(
        `  other acknowledgements: ${m.otherAcknowledgements.map((f) => f.id).join(", ") || "none"}`,
      );
      if (m.priorTakes.length) {
        console.log("  earlier takes from this frame:");
        for (const t of m.priorTakes)
          console.log(
            `    #${t.attemptNumber} ${t.provider}/${t.model} · ${t.status} · ${t.decision}` +
              (t.reasons.length ? ` (${t.reasons.join(", ")})` : "") +
              ` · ${t.promptPolicy ?? "plan prompt"}${t.identical ? " · IDENTICAL REQUEST" : ""}`,
          );
      } else console.log("  earlier takes from this frame: none");
    }

    hr("Verdict");
    if (report.readyForPaidTake)
      console.log(
        "  READY for a bounded paid take: frame selected and current, lineage verified, references stored.",
      );
    else {
      console.log("  NOT READY for a paid take:");
      for (const o of outstanding) console.log(`    - ${o}`);
    }
    console.log(
      "  (Lineage is about inputs, not pixels: a person still has to look at the frame and the clip.)",
    );
  }
  if (flag("strict") && !report.readyForPaidTake) process.exitCode = 1;
} finally {
  await pool?.end();
}

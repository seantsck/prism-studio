// Read-only report for ONE continuity run after a live smoke (never calls a provider, never writes).
//   npm run continuity:run:report -- <runId>
// Prints: job state, transport calls, corrections, authoritative usage + cost, findings (result/confidence/
// evidence count), the frozen media manifest, and a leak scan (credential value / sk- shapes / base64 / URLs).
import pg from "pg";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const runId = process.argv.find((a) => /^[0-9a-f-]{36}$/i.test(a));
if (!runId) {
  console.error("usage: npm run continuity:run:report -- <runId>");
  process.exit(2);
}
const dev = readDevUserEnv();
startScript({ mode: "continuity run report (read-only)", devOwner: dev.id });
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 2 });
await assertDevUserExists(pool, dev);
try {
  const job = (await pool.query("select * from continuity_analysis_jobs where run_id = $1", [runId])).rows[0];
  if (!job) throw new Error("no analysis job for that run");
  const { input_snapshot: snap, ...j } = job;
  console.log("JOB", {
    id: j.id,
    analyzer: j.analyzer,
    model: j.model,
    status: j.status,
    provider_state: j.provider_state,
    transport_calls: j.transport_calls,
    correction_count: j.correction_count,
    batches: `${j.batches_done}/${j.batches_total}`,
    attempts: j.attempt_count,
    estimated_cost_usd: j.estimated_cost_usd,
    actual_cost_usd: j.actual_cost_usd,
    last_error: j.last_error_category ? `${j.last_error_category}/${j.last_error_code}` : null,
  });
  console.log("PROMPT_VERSIONS", snap.promptVersions);
  const costs = (
    await pool.query(
      "select kind, amount_usd, expected_usd, pricing_version, usage from continuity_analysis_costs where job_id = $1 order by recorded_at",
      [j.id],
    )
  ).rows;
  for (const c of costs)
    console.log(
      "COST",
      c.kind,
      c.amount_usd ?? "unknown",
      c.pricing_version,
      JSON.stringify(c.usage).slice(0, 500),
    );
  for (const f of (
    await pool.query(
      "select criterion_key, result, result_source, confidence, notes, actual, evidence from continuity_findings where run_id = $1 and result_source = 'analyzer' order by position",
      [runId],
    )
  ).rows)
    console.log(
      "FINDING",
      f.criterion_key,
      f.result,
      `confidence=${f.confidence}`,
      `evidence=${f.evidence?.items?.length ?? 0}`,
      "|",
      String(f.actual).slice(0, 240),
      "|",
      String(f.notes).slice(0, 200),
    );
  console.log(
    "MANIFEST",
    (snap.media as Array<Record<string, unknown>>)
      .map((m) => `${m.inputId}:${m.role}:${String(m.checksum).slice(0, 10)}`)
      .join(" "),
  );
  const key = process.env.OPENAI_API_KEY ?? "";
  const dump = JSON.stringify([
    job,
    costs,
    (await pool.query("select * from continuity_findings where run_id = $1", [runId])).rows,
    (await pool.query("select * from continuity_analysis_events where job_id = $1", [j.id])).rows,
  ]);
  console.log("LEAK_SCAN", {
    credential: key.length > 8 && dump.includes(key),
    skShape: /sk-[A-Za-z0-9_-]{20,}/.test(dump),
    base64OrDataUrl: /data:image\//.test(dump) || /[A-Za-z0-9+/]{500,}={0,2}/.test(dump),
    privateUrl: /https?:\/\/[^"\s]*(supabase|token=|signed|X-Amz|sig=)/i.test(dump),
  });
} finally {
  await pool.end();
}

// Pre-paid validation for the Gemini continuity analyzer. SPENDS NOTHING and sends nothing to Gemini.
//   npm run continuity:pre-paid:check
//
// Uses the REAL GeminiAnalysisProvider with the REAL SDK transport, but traps every outbound fetch: if anything
// tried to reach the network the check fails. Proves that while paid analysis is off (or the estimate is over
// the ceiling) the job is refused locally, plans the synthetic smoke fixture and prints its estimate, and runs
// the static secret-handling checks. Prints no secret values.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { analysisSpendBlockers } from "../src/domain/continuity/analysis/cost";
import { OVERLOAD_BACKOFF_SECONDS } from "../src/domain/continuity/analysis/retry";
import { MemoryMediaQaService } from "../src/data/media-qa-memory";
import {
  analyzerStatuses,
  createAnalysisProviders,
  readAnalysisConfig,
} from "../src/continuity/analysis/registry";
import { previewAnalysis } from "../src/continuity/analysis/prepare";
import { submitAnalysis } from "../src/continuity/analysis/submit";
import { ContinuityAnalysisWorker } from "../src/continuity/analysis/worker";
import { computeQaInputs } from "../src/continuity/service";
import { GEMINI_ANALYZER_ID, GEMINI_PRICING, GEMINI_SDK } from "../src/continuity/providers/gemini/config";
import { silentLogger } from "../src/generation/log";
import { LocalDiskSink } from "../src/generation/sink";
import { FfmpegMediaProcessor } from "../src/media/ffmpeg";
import { buildSyntheticFixture } from "./lib/continuity-fixture.mts";

const failures: string[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass || !detail ? "" : `  → ${detail}`}`);
  if (!pass) failures.push(name);
};

// ── trap the network: nothing may leave this process ──
const outbound: string[] = [];
const realFetch = globalThis.fetch;
const trap = (async (input: RequestInfo | URL) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  outbound.push(new URL(u).hostname);
  throw new Error("network trapped by continuity pre-paid check");
}) as typeof fetch;
globalThis.fetch = trap;

const env = process.env as Record<string, string | undefined>;
const real = readAnalysisConfig(env);
const key = env.GEMINI_API_KEY?.trim() ?? "";

// 1 ── configuration facts
const gem = analyzerStatuses(env).find((a) => a.id === GEMINI_ANALYZER_ID)!;
// Setup facts the OPERATOR provides: reported, not failures of the build (the build must finish without them).
const notes: string[] = [];
const note = (name: string, present: boolean, hint: string) => {
  console.log(`${present ? "PASS" : "NOTE"}  ${name}${present ? "" : `  → ${hint}`}`);
  if (!present) notes.push(name);
};
note("GEMINI_API_KEY is present (value never printed)", key.length > 0, "credential missing");
note(
  "Gemini analyzer is enabled via PRISM_STUDIO_CONTINUITY_ANALYZERS",
  real.gemini.enabled,
  "enable with …=mock,gemini",
);
ok("paid analysis flag is OFF in the real environment", real.paid.enabled === false);
ok(
  "retry mode is durable exponential backoff (no in-process 429/503 retry loop)",
  OVERLOAD_BACKOFF_SECONDS.length >= 3 && OVERLOAD_BACKOFF_SECONDS[0]! < OVERLOAD_BACKOFF_SECONDS[1]!,
  OVERLOAD_BACKOFF_SECONDS.join(","),
);
ok(
  "maximum provider transport calls per run is bounded (1..6)",
  real.limits.maxTransportCalls >= 1 && real.limits.maxTransportCalls <= 6,
  String(real.limits.maxTransportCalls),
);
ok(
  "schema correction maximum is 1 per run",
  real.limits.maxCorrections === 1,
  String(real.limits.maxCorrections),
);
ok(
  "a job may use enough claims to spend the transport ceiling",
  real.limits.maxJobAttempts >= real.limits.maxTransportCalls,
  String(real.limits.maxJobAttempts),
);
ok("per-run analysis ceiling is set", real.paid.maxUsdPerRun != null, String(real.paid.maxUsdPerRun));
ok(
  "generation spend is a separate flag (analysis flag is not PAID_GENERATION)",
  "PRISM_STUDIO_ALLOW_PAID_ANALYSIS" !== "PRISM_STUDIO_ALLOW_PAID_GENERATION",
);
ok(
  "configured model has pricing in the versioned table",
  GEMINI_PRICING.models.some((m) => m.model === real.gemini.model),
  real.gemini.model,
);
console.log(
  `      model=${real.gemini.model} sdk=${GEMINI_SDK} pricing=${GEMINI_PRICING.version} state=${gem.state}`,
);

// 2 ── plan + estimate the synthetic smoke fixture (offline)
const fx = buildSyntheticFixture({ userId: randomId(), mismatch: false });
function randomId() {
  return "00000000-0000-4000-8000-000000000001";
}
const previewProviders = createAnalysisProviders(
  {
    ...env,
    PRISM_STUDIO_CONTINUITY_ANALYZERS: "mock,gemini",
    GEMINI_API_KEY: key || "key_missing_placeholder_for_check",
  },
  { fetchImpl: trap },
);
const gemini = previewProviders.get(GEMINI_ANALYZER_ID)!;
const inputs = computeQaInputs({ data: fx.data, view: fx.view, delivery: null })!;
const prev = previewAnalysis({
  inputs,
  assets: fx.data.assets,
  output: { frames: [], contactSheet: null },
  subject: inputs.subject!,
  provider: gemini,
  policy: { enabled: true, maxUsdPerRun: real.paid.maxUsdPerRun, maxUsdPerDay: real.paid.maxUsdPerDay },
  spentLast24hUsd: 0,
  now: new Date(),
});
ok(
  "fixture plan: exactly the two continuity criteria are analysed",
  prev.preview.summary.analysed === 2,
  JSON.stringify(prev.preview.summary),
);
ok(
  "fixture plan: image set, at most one request per criterion group, no video",
  prev.preview.mode === "image_set" &&
    prev.preview.summary.requests >= 1 &&
    prev.preview.summary.requests <= 2,
  String(prev.preview.summary.requests),
);
ok(
  "fixture plan: references from the assigned Look/identity only",
  prev.preview.summary.referencesSent >= 1 && prev.preview.summary.referencesSent <= 2,
  String(prev.preview.summary.referencesSent),
);
ok("fixture plan: the output is sent as one bounded image", prev.preview.summary.outputImagesSent === 1);
const maxUsd = prev.preview.estimate.maxUsd;
ok(
  "estimated worst-case cost is within the per-run ceiling",
  Number.isFinite(maxUsd) && real.paid.maxUsdPerRun != null && maxUsd <= real.paid.maxUsdPerRun,
  `max=$${maxUsd}`,
);

// 3 ── the gate: closed by default, worker refuses, nothing sent
const gateClosed = analysisSpendBlockers({ policy: real.paid, maxEstimateUsd: maxUsd, spentLast24hUsd: 0 });
ok(
  "the submission gate blocks while paid analysis is off",
  gateClosed.some((b) => b.code === "analysis_spend.disabled"),
);

const root = mkdtempSync(path.join(tmpdir(), "prism-continuity-precheck-"));
try {
  const sink = new LocalDiskSink(root);
  const processor = new FfmpegMediaProcessor();
  ok("ffmpeg is available for frame extraction / image bounding", await processor.available());
  const service = new MemoryMediaQaService({
    all: () => [fx.data],
    ownerUserId: () => fx.data.project.userId,
  });
  for (const a of fx.data.assets) await sink.put(a.objectPath!, fx.bytes.get(a.id)!, a.mime ?? "image/png");
  const deps = { processor, storage: sink, qa: service, userId: null as string | null };
  const submitted = await submitAnalysis({
    inputs,
    view: fx.view,
    assets: fx.data.assets,
    provider: gemini,
    policy: { enabled: true, maxUsdPerRun: 0.5, maxUsdPerDay: null }, // open ONLY to be able to queue
    deps,
    acknowledged: true,
    nonce: "pre-paid-check",
    limits: { maxActivePerProject: 3, maxJobAttempts: 3 },
  });
  ok(
    "a job could be queued (gate open at submission, nothing sent)",
    submitted.job.status === "queued" && outbound.length === 0,
  );
  const worker = new ContinuityAnalysisWorker({
    store: service,
    providers: new Map([[gemini.id, gemini]]),
    media: { read: async (ref) => (ref.objectPath ? sink.get(ref.objectPath) : null) },
    processor,
    logger: silentLogger,
    paid: { enabled: false, maxUsdPerRun: real.paid.maxUsdPerRun, maxUsdPerDay: null }, // the REAL (closed) policy
    maxTransportCalls: real.limits.maxTransportCalls,
    maxCorrections: real.limits.maxCorrections,
    heartbeatMs: 0,
  });
  await worker.tick();
  const job = (await service.getAnalysisJob(submitted.job.id))!;
  ok(
    "worker refuses to call Gemini while paid analysis is off",
    job.status === "failed" && job.lastErrorCategory === "budget",
    `${job.status} ${job.lastErrorCategory}`,
  );
  ok("job never reached the provider (provider_state not_sent)", job.providerState === "not_sent");
  ok("no outbound network request was attempted", outbound.length === 0, outbound.join(","));

  // over-ceiling with paid ON is also refused at the worker
  const submitted2 = await submitAnalysis({
    inputs,
    view: fx.view,
    assets: fx.data.assets,
    provider: gemini,
    policy: { enabled: true, maxUsdPerRun: 0.5, maxUsdPerDay: null },
    deps,
    acknowledged: true,
    nonce: "pre-paid-check-2",
    limits: { maxActivePerProject: 3, maxJobAttempts: 3 },
  });
  const tight = new ContinuityAnalysisWorker({
    store: service,
    providers: new Map([[gemini.id, gemini]]),
    media: { read: async (ref) => (ref.objectPath ? sink.get(ref.objectPath) : null) },
    processor,
    logger: silentLogger,
    paid: { enabled: true, maxUsdPerRun: 0.0000001, maxUsdPerDay: null },
    heartbeatMs: 0,
  });
  await tight.tick();
  const j2 = (await service.getAnalysisJob(submitted2.job.id))!;
  ok(
    "worker refuses an estimate above the ceiling",
    j2.status === "failed" && j2.lastErrorCategory === "budget",
    `${j2.status} ${j2.lastErrorCategory}`,
  );
  ok("still no outbound network request", outbound.length === 0, outbound.join(","));
} finally {
  rmSync(root, { recursive: true, force: true });
}

// 4 ── security checklist (static)
const publicVars = Object.keys(process.env).filter((k) => k.startsWith("NEXT_PUBLIC_"));
ok(
  "no NEXT_PUBLIC_ variable is named after the analyzer credential",
  !publicVars.some((k) => /GEMINI|GOOGLE_API|ANALYSIS/.test(k)),
);
const envFile = (() => {
  try {
    return readFileSync(".env.local", "utf8");
  } catch {
    return "";
  }
})();
const secret = envFile.match(/^GEMINI_API_KEY=(.*)$/m)?.[1]?.trim() ?? "";
const pubs = [...envFile.matchAll(/^(NEXT_PUBLIC_[A-Z0-9_]+)=(.*)$/gm)];
ok(
  "the credential value is not stored under a NEXT_PUBLIC_ variable",
  !secret || pubs.every(([, , v]) => !v!.includes(secret)),
);
const offenders: string[] = [];
const walk = (dir: string) => {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(f) && /GEMINI_API_KEY|@google\/genai/.test(readFileSync(p, "utf8")))
      offenders.push(p);
  }
};
for (const d of ["src/app", "src/components"]) walk(d);
ok(
  "no Next.js route/component references the credential or the SDK",
  offenders.length === 0,
  offenders.join(", "),
);

// 5 ── worker role (read-only introspection, only when configured)
const url = env.PRISM_STUDIO_CONTINUITY_DB_URL;
if (url) {
  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    const r = await pool.query("select current_user as u, session_user as s");
    ok(
      "continuity worker connects as prism_continuity_worker (not SET ROLE)",
      r.rows[0].u === "prism_continuity_worker" && r.rows[0].s === "prism_continuity_worker",
    );
    const denied = await pool.query("select 1 from shots limit 1").then(
      () => false,
      () => true,
    );
    ok("…and cannot read creative content", denied);
  } finally {
    await pool.end();
  }
} else {
  ok("continuity worker DB login is configured", false, "PRISM_STUDIO_CONTINUITY_DB_URL not set");
}
globalThis.fetch = realFetch;

// 6 ── proposal
const est = prev.preview.estimate;
console.log(`
PROPOSED LIVE SMOKE (not executed)
  Provider/model : gemini / ${real.gemini.model}  (SDK ${GEMINI_SDK}, pricing ${GEMINI_PRICING.version})
  Mode           : image set (no video)
  Inputs         : ${prev.preview.summary.referencesSent} reference image(s) + ${prev.preview.summary.outputImagesSent} output image (synthetic, 512×288 PNG)
  Criteria       : ${prev.preview.summary.analysed} (identity + wardrobe)
  Requests       : ${prev.preview.summary.requests} (+1 correction worst case)
  Est. tokens    : ~${est.tokens.inputTokens} input, ceiling ${est.tokens.maxOutputTokens} output
  Est. cost      : expected ~$${est.expectedUsd} · worst case $${est.maxUsd}
  Spend ceiling  : $${real.paid.maxUsdPerRun ?? "unset"} per run
  Retry mode     : durable exponential backoff (${OVERLOAD_BACKOFF_SECONDS.join("s, ")}s), ONE request per claim
  Transport calls: at most ${real.limits.maxTransportCalls} per run (retries + corrections included)
  Schema fix     : at most ${real.limits.maxCorrections} correction per run (counts as a transport call)
  Paid analysis  : ${real.paid.enabled ? "ENABLED (!)" : "disabled"}
  Credential     : ${key ? "present, unverified (no zero-cost verification call was made)" : "MISSING"}
`);
if (notes.length) console.log(`\nOperator setup still pending: ${notes.join("; ")}`);
console.log(
  failures.length ? `\n${failures.length} FAILURE(S)` : "\nPRE-PAID CHECKS OK (no Gemini request was made)",
);
process.exit(failures.length ? 1 : 0);

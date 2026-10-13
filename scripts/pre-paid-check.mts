// Pre-paid validation for the Runway adapter. SPENDS NOTHING and sends nothing to Runway.
//   npm run pre-paid:check
//
// Uses the REAL RunwayProvider with the real SDK client factory, but traps every outbound fetch: if anything
// tried to reach Runway the check fails. Proves that while paid generation is off (or the estimate is over the
// ceiling) a submission is blocked locally, and runs the static secret-handling checks. Prints no secret values.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { buildShotContext } from "../src/domain/context";
import { approvalSnapshot } from "../src/domain/fingerprint";
import { silentLogger } from "../src/generation/log";
import { gen45Model, RunwayProvider } from "../src/generation/providers/runway/adapter";
import { encodeMockPng } from "../src/generation/providers/mock-image";
import { ModelRegistry } from "../src/generation/registry";
import { assertSafeUrl } from "../src/generation/safe-fetch";
import { SinkConfigError, createOutputSink } from "../src/generation/sink";
import { evaluateShotForModel } from "../src/generation/submission";
import { GenerationWorker } from "../src/generation/worker";
import { readGenerationConfig } from "../src/generation/config";
import { makeHarness } from "../src/generation/__tests__/helpers";

const failures: string[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass || !detail ? "" : `  → ${detail}`}`);
  if (!pass) failures.push(name);
};

// ── trap the network: nothing may leave this process toward Runway ──
const outbound: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  outbound.push(new URL(u).hostname);
  throw new Error("network trapped by pre-paid check");
}) as typeof fetch;

const runwayKey = process.env.RUNWAYML_API_SECRET?.trim() ?? "";
const runtimeEnv = readGenerationConfig({ ...process.env, NODE_ENV: "development" });

// ───────── 1. configuration facts ─────────
ok("RUNWAYML_API_SECRET is present", runwayKey.length > 0);
ok("paid generation flag is OFF in the real environment", runtimeEnv.paid.enabled === false);
ok("per-generation ceiling is set", runtimeEnv.paid.maxUsd === 0.5, `maxUsd=${runtimeEnv.paid.maxUsd}`);

// ───────── 2. gate + worker blocking, with the REAL adapter and a trapped network ─────────
const harnessEnv = {
  PRISM_STUDIO_GENERATION_PROVIDERS: "runway",
  RUNWAYML_API_SECRET: runwayKey || "key_missing_placeholder_for_check",
  PRISM_STUDIO_ALLOW_PAID_GENERATION: "true", // ONLY to be able to queue a job; the worker below is closed
  PRISM_STUDIO_MAX_GENERATION_USD: "0.50",
  PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
};
const real = new RunwayProvider({ env: harnessEnv });
const h = makeHarness(harnessEnv, { extraAdapters: [real] });
const data0 = await h.data();
const shot = data0.shots.find((s) => s.shotCode === "1A")!;
const png = encodeMockPng(32, 18, 9);
const startId = buildShotContext(data0, shot.id).approvedFrame?.assetId ?? null;
const asset = data0.assets.find((a) => a.id === startId);
if (asset) {
  const p = `pre-paid/${asset.id}.png`;
  await h.sink.put(p, png);
  await h.repo.upsert(data0.project.id, "assets", {
    ...asset,
    objectPath: p,
    mime: "image/png",
    byteSize: png.length,
    checksum: createHash("sha256").update(png).digest("hex"),
    storageProvider: "local",
    bucket: null,
  });
}
await h.repo.upsert(data0.project.id, "shots", {
  ...shot,
  composition: { ...shot.composition, aspectRatio: "16:9" },
  updatedAt: new Date(h.clock.now.getTime() - 1000).toISOString(),
});
{
  const after = await h.data();
  const ctx = buildShotContext(after, shot.id);
  if (ctx.approvedFrame) {
    const snap = approvalSnapshot(ctx);
    await h.repo.upsert(after.project.id, "frames", {
      ...ctx.approvedFrame,
      approvedFingerprint: snap.fingerprint,
      approvedSnapshot: snap.snapshot,
    });
  }
}

// 2a. UI/server gate with the REAL environment configuration (paid off)
{
  const data = await h.data();
  const closed = readGenerationConfig({ ...harnessEnv, PRISM_STUDIO_ALLOW_PAID_GENERATION: "false" });
  const registry = new ModelRegistry([real], closed, harnessEnv);
  const ev = evaluateShotForModel({ data, shotId: shot.id, registry, provider: "runway", modelId: "gen4.5" });
  ok(
    "submission gate blocks Runway while paid generation is off",
    ev.gate.blockers.some((b) => b.code === "spend.disabled"),
  );
  ok("model is not offered to users while paid generation is off", ev.availability?.available === false);
  ok(
    "estimate for the 4 s Shot 1A is computed locally",
    ev.estimate?.amount === 0.48,
    String(ev.estimate?.amount),
  );
}

// 2b. a queued job + a worker whose gate is CLOSED → nothing is sent
{
  const { jobId } = await h.submit("1A", "gen4.5", { provider: "runway" });
  ok("a Runway job could be queued (gate open at submission)", Boolean(jobId));
  const closedCfg = { ...h.config, paid: { enabled: false, maxUsd: 0.5 } };
  const w = new GenerationWorker({
    store: h.repo.generation,
    registry: new ModelRegistry([real], closedCfg, harnessEnv),
    sink: h.sink,
    config: closedCfg,
    logger: silentLogger,
    clock: () => h.clock.now,
    heartbeatMs: 0,
  });
  await w.tick();
  const job = (await h.repo.generation.getJob(jobId!))!;
  ok(
    "worker refuses to call Runway while paid generation is off",
    job.status === "failed" &&
      ["provider_unavailable", "spend_gate_blocked"].includes(job.lastErrorCode ?? ""),
    `${job.status} ${job.lastErrorCode}`,
  );
}
// 2c. paid ON but the estimate is above the ceiling → still blocked at the worker
{
  const { jobId } = await (async () => {
    // free the shot's active slot first (previous job is terminal already)
    return h.submit("1A", "gen4.5", { provider: "runway", key: "pre-paid-over-limit-0001" });
  })();
  const tight = { ...h.config, paid: { enabled: true, maxUsd: 0.1 } };
  const w = new GenerationWorker({
    store: h.repo.generation,
    registry: new ModelRegistry([real], tight, harnessEnv),
    sink: h.sink,
    config: tight,
    logger: silentLogger,
    clock: () => h.clock.now,
    heartbeatMs: 0,
  });
  await w.tick();
  const job = (await h.repo.generation.getJob(jobId!))!;
  ok(
    "worker refuses an estimate above the ceiling",
    job.status === "failed" && job.lastErrorCode === "spend_gate_blocked",
    `${job.status} ${job.lastErrorCode}`,
  );
}
ok("no network request was attempted during the checks above", outbound.length === 0, outbound.join(","));

// ───────── 3. credential/startup + security checklist ─────────
{
  const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  let refused = false;
  try {
    await createOutputSink(
      {
        NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable,
        PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY: publishable || "sb_publishable_placeholder0000",
      },
      "supabase",
    );
  } catch (e) {
    refused = e instanceof SinkConfigError;
  }
  ok("worker Storage refuses a publishable/anon key", refused);
}
{
  const m = gen45Model();
  ok(
    "ambiguous-submit protection: Runway declares NO idempotency",
    m.capabilities.operational.idempotency === false,
  );
  ok("cancellation is declared (look-first adapter)", m.capabilities.operational.cancellation === true);
  let blocked = false;
  try {
    assertSafeUrl("https://169.254.169.254/latest", { allowedHosts: real.allowedOutputHosts() });
  } catch {
    blocked = true;
  }
  ok("safe-fetch refuses metadata/private targets and off-list hosts", blocked);
  ok(
    "output host allow-list is explicit (provisional: CloudFront + runwayml.com)",
    real.allowedOutputHosts().every((x) => x !== "*") &&
      real.allowedOutputHosts().includes("*.cloudfront.net"),
  );
}
{
  // secrets must never sit in a public variable or be referenced by browser-reachable code
  const env = readFileSync(".env.local", "utf8");
  const secretNames = [
    "PRISM_STUDIO_WORKER_DB_PASSWORD",
    "PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY",
    "RUNWAYML_API_SECRET",
  ];
  const values = secretNames
    .map((k) => env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "")
    .filter((v) => v.length >= 8);
  const pub = [...env.matchAll(/^(NEXT_PUBLIC_[A-Z0-9_]+)=(.*)$/gm)];
  ok(
    "no secret value is stored under a NEXT_PUBLIC_ variable",
    pub.every(([, , v]) => !values.some((s) => v!.includes(s))),
  );
  ok(
    "no NEXT_PUBLIC_ variable is named after a worker/provider secret",
    !pub.some(([, k]) => /WORKER|RUNWAY|SECRET|SERVICE_ROLE/.test(k!)),
  );
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f)) {
        const t = readFileSync(p, "utf8");
        if (/RUNWAYML_API_SECRET|PRISM_STUDIO_WORKER_(DB|SUPABASE|SERVICE)/.test(t)) offenders.push(p);
      }
    }
  };
  for (const d of ["src/app", "src/components"]) walk(d);
  ok(
    "no Next.js route/component references a worker or Runway secret",
    offenders.length === 0,
    offenders.join(", "),
  );
}
globalThis.fetch = realFetch;
console.log(
  failures.length ? `\n${failures.length} FAILURE(S)` : "\nPRE-PAID CHECKS OK (no Runway request was made)",
);
process.exit(failures.length ? 1 : 0);

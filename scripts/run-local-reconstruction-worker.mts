// Prism Studio LOCAL reconstruction worker (Phase 2F M2D.3B). SAME-HOST ONLY: it runs on the machine that runs the
// Prism server, with the same persistence configuration, work root and installed tools.
//   npm run local:reconstruction-worker                  run until Ctrl+C / SIGTERM (claims queued local_capture jobs)
//   npm run local:reconstruction-worker -- --until-idle  process the queued local jobs, then exit
//   npm run local:reconstruction-worker -- --check       probe the toolchain and print readiness; claims nothing
//
// It is a separate long-lived process: a browser tab is never the worker, and closing the browser does not stop a
// reconstruction. It refuses to start unless PRISM_LOCAL_RECONSTRUCTION_WORKER_ENABLED=1, so a hosted deployment
// never starts local compute by accident. It never installs, downloads or builds a tool. Nothing secret is printed.
//
// Authority (same-host v1): the server's own guarded database connection (SUPABASE_DB_URL, Prism Studio project
// only), used for ONE narrow discovery query; every job read/write runs as the job owner under RLS. Storage uses the
// existing worker credential (PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY). This model must NOT be distributed to another
// machine: a remote Local Agent (M2D.3C) needs a paired, scoped protocol instead.
import path from "node:path";
import pg from "pg";
import { createOutputSink, SinkConfigError } from "../src/generation/sink";
import { readEngineLimits } from "../src/lib/reconstruction/local/engine";
import type { ToolCommand } from "../src/lib/reconstruction/local/process";
import { probeLocalToolchain } from "../src/lib/reconstruction/local/toolchain";
import { resolveWorkRoot } from "../src/lib/reconstruction/local/workspace";
import { createPostgresWorkerStore } from "../src/lib/reconstruction/local-worker/postgres-store";
import { summarizeToolchain, WorkerLockError } from "../src/lib/reconstruction/local-worker/runtime";
import { isLocalWorkerEnabled, WORKER_ENABLED_ENV } from "../src/lib/reconstruction/local-worker/status";
import { LocalReconstructionWorker } from "../src/lib/reconstruction/local-worker/worker";
import { assertProjectRef, installRedactingHandlers, printBanner } from "./lib/safety.mjs";

installRedactingHandlers();
const args = new Set(process.argv.slice(2));
const untilIdle = args.has("--until-idle");
const check = args.has("--check");
const env = process.env;

const refuse = (message: string): never => {
  console.error(message);
  process.exit(2);
};

if (!isLocalWorkerEnabled(env))
  refuse(
    `The local reconstruction worker is switched off. Set ${WORKER_ENABLED_ENV}=1 on THIS machine to run it.`,
  );
if (env.PRISM_STUDIO_PERSISTENCE !== "supabase")
  refuse(
    "The local reconstruction worker needs PRISM_STUDIO_PERSISTENCE=supabase: it is a separate process and cannot " +
      "share the Prism server's in-memory data.",
  );
const url = env.SUPABASE_DB_URL ?? "";
assertProjectRef(url, "SUPABASE_DB_URL");
const workRoot = resolveWorkRoot(env);
const projectScope = env.PRISM_LOCAL_RECONSTRUCTION_PROJECT_ID?.trim() || null;

// TEST-ONLY: the automated worker E2E runs the M2D.3A fake tools (Node scripts) in place of colmap.exe/brush_app.exe.
// Refused unless NODE_ENV=test; a real run never uses it.
const fakeTools = args.has("--fake-tools");
if (fakeTools && env.NODE_ENV !== "test") refuse("--fake-tools is a test seam and requires NODE_ENV=test.");
const FAKES = path.resolve("src/lib/reconstruction/local/__tests__/fakes");
const commandFor = fakeTools
  ? (tool: "colmap" | "brush"): ToolCommand => ({
      executable: process.execPath,
      prefixArgs: [path.join(FAKES, tool === "colmap" ? "fake-colmap.mjs" : "fake-brush.mjs")],
      env:
        tool === "colmap"
          ? { FAKE_COLMAP_MODE: env.FAKE_COLMAP_MODE ?? "success" }
          : { FAKE_BRUSH_MODE: env.FAKE_BRUSH_MODE ?? "success" },
    })
  : undefined;
const probeEnv =
  fakeTools && env.PRISM_LOCAL_TEST_SYSTEM_ROOT
    ? { ...env, SystemRoot: env.PRISM_LOCAL_TEST_SYSTEM_ROOT }
    : env;
const probe = () => probeLocalToolchain({ env: probeEnv, commandFor });

printBanner({
  mode: `local reconstruction worker${check ? " (check only)" : untilIdle ? " (until idle)" : ""}${fakeTools ? " — FAKE TOOLS (test)" : ""}`,
  url,
});

if (check) {
  const p = await probe();
  const s = summarizeToolchain(p, new Date().toISOString());
  console.log(`Toolchain:  ${s.state}`);
  console.log(
    `  COLMAP:   ${p.colmap.installed ? `${p.colmap.version ?? "?"} · provenance ${p.colmap.provenance}` : "not found"}${p.colmap.reason ? ` · ${p.colmap.reason}` : ""}`,
  );
  console.log(
    `  Brush:    ${p.brush.installed ? `${p.brush.version ?? "?"}${p.brush.compatible ? "" : " · unsupported"}` : "not found"}${p.brush.reason ? ` · ${p.brush.reason}` : ""}`,
  );
  console.log(
    `  GPU:      Vulkan loader ${p.gpu.loaderPresent === null ? "unknown" : p.gpu.loaderPresent ? "present" : "missing"}`,
  );
  process.exit(s.state === "ready" ? 0 : 1);
}

let sink;
try {
  sink = await createOutputSink(env, "supabase");
} catch (err) {
  if (err instanceof SinkConfigError) refuse(`Storage is not configured for this worker: ${err.message}`);
  throw err;
}
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 4 });
const worker = new LocalReconstructionWorker({
  store: createPostgresWorkerStore({ pool, sink, projectScope }),
  workRoot,
  probe,
  limits: readEngineLimits(env),
});

console.log(`Worker:      ${worker.workerId} (same-host)`);
console.log(`Work root:   ${workRoot}`);
console.log(`Storage:     ${sink.name} (private bucket ${sink.bucket})`);
console.log(`Scope:       ${projectScope ? `project ${projectScope}` : "all projects on this Prism server"}`);
console.log("Runs:        one reconstruction at a time; local_capture jobs only");

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) {
    console.log(`${signal}: forced exit`);
    process.exit(130);
  }
  stopping = true;
  console.log(
    `${signal}: stopping (an active reconstruction is aborted and recorded; Ctrl+C again forces exit)`,
  );
  void worker.stop();
};
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const)
  process.on(signal, () => shutdown(signal));

try {
  await worker.start();
} catch (err) {
  await pool.end().catch(() => undefined);
  if (err instanceof WorkerLockError) refuse(err.message);
  throw err;
}
if (untilIdle) {
  const n = await worker.runUntilIdle();
  console.log(`processed ${n} local job(s)`);
  await worker.stop();
} else {
  console.log("worker running; Ctrl+C to stop");
  await worker.run();
}
await pool.end();
console.log("worker stopped");

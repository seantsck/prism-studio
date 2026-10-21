import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser } from "@playwright/test";
import { profileDir, resolveAgentHome } from "@/lib/local-agent/agent/home";
import { readConfig } from "@/lib/local-agent/agent/store";
import { probeLocalToolchain, type LocalToolchainProbe } from "../local/toolchain";
import { resolveWorkRoot } from "../local/work-root";
import { probeHardware, type HardwareFacts } from "./hardware";
import { finalVerdict, humanReviewSchema } from "./human";
import { AcceptanceInputError, checkOutputDirectory, scanPhotoDirectory } from "./photos";
import { assessHardware, fmtGiB } from "./policy";
import { buildReadiness, formatReadiness } from "./readiness";
import { bundleRenderPage, renderSpzWithSpark, RENDER_LAUNCH_ARGS } from "./render";
import { acceptanceReportSchema, machineVerdict } from "./report";
import { newAcceptanceRunId, readReport, runAcceptance, writeReport, type AcceptanceInput } from "./runner";
import { renderSyntheticRoom } from "./synthetic";

/**
 * `npm run local:acceptance:<command>` (Phase 2F M2D.3D1). Operator-only, CLI-only; never imported by the web app or
 * the agent. Commands:
 *
 *   check     readiness report (hosted config, Local Agent profile, toolchain, hardware, gates A/B/C)
 *   smoke     REAL_SMOKE: the real toolchain on a tiny synthetic (or --input) dataset; requires --real
 *   room      REAL_ROOM: the real toolchain on a chosen photo directory; requires --real
 *   render    the Spark render acceptance of a finished run's SPZ (updates its report)
 *   verdict   combines a run's report with its filled-in human-review.json into the final verdict
 *
 * REAL commands refuse to run inside automated tests (NODE_ENV=test / VITEST), print exactly which tools they will
 * start, how many photographs and where the output goes, and call no network service of any kind.
 */

export interface CliDeps {
  argv: string[];
  env: Record<string, string | undefined>;
  repoRoot: string;
  out: (line: string) => void;
  err: (line: string) => void;
  probeToolchain?: (env: Record<string, string | undefined>) => Promise<LocalToolchainProbe>;
  probeHardware?: (diskPath: string) => Promise<HardwareFacts>;
  launchBrowser?: () => Promise<Browser>;
  now?: () => number;
}

export const USAGE = `Prism reconstruction acceptance (local only; no network provider, no paid call)

  npm run local:acceptance:check   [-- --profile <name>] [--diagnostic] [--json]
  npm run local:acceptance:smoke   -- --real [--output <abs dir>] [--input <abs tiny photo dir>]
                                      [--keep-intermediates] [--no-render] [tool flags]
  npm run local:acceptance:room    -- --real --input <abs photo dir> --output <abs new dir>
                                      [--keep-intermediates] [--no-render] [--accept-hardware-risk] [tool flags]
  npm run local:acceptance:render  -- --output <abs run dir>
  npm run local:acceptance:verdict -- --output <abs run dir>

  tool flags: --colmap <abs colmap.exe> --colmap-manifest <abs manifest.json> --brush <abs brush_app.exe>
              (otherwise PRISM_COLMAP_PATH, PRISM_COLMAP_PROVENANCE_PATH, PRISM_BRUSH_PATH)`;

const FLAGS = new Set([
  "--real",
  "--diagnostic",
  "--json",
  "--keep-intermediates",
  "--no-render",
  "--accept-hardware-risk",
]);
const VALUED = new Set(["--profile", "--output", "--input", "--colmap", "--colmap-manifest", "--brush"]);

function parse(argv: string[]) {
  const [command, ...rest] = argv;
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (FLAGS.has(a)) flags.add(a);
    else if (VALUED.has(a) && rest[i + 1] !== undefined) values.set(a, rest[++i]!);
    else throw new AcceptanceInputError(`Unknown or incomplete argument: ${a.slice(0, 40)}`);
  }
  return { command, flags, values };
}

const inTests = (env: Record<string, string | undefined>) => env.NODE_ENV === "test" || !!env.VITEST;

export async function runAcceptanceCli(d: CliDeps): Promise<number> {
  try {
    return await dispatch(d);
  } catch (e) {
    if (e instanceof AcceptanceInputError) {
      d.err(`REFUSED: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

async function dispatch(d: CliDeps): Promise<number> {
  const { command, flags, values } = parse(d.argv);
  const env = { ...d.env };
  // explicit tool flags win over the environment (absolute paths only; the probe re-checks them)
  if (values.has("--colmap")) env.PRISM_COLMAP_PATH = values.get("--colmap");
  if (values.has("--colmap-manifest")) env.PRISM_COLMAP_PROVENANCE_PATH = values.get("--colmap-manifest");
  if (values.has("--brush")) env.PRISM_BRUSH_PATH = values.get("--brush");
  const probeTc = d.probeToolchain ?? ((e) => probeLocalToolchain({ env: e }));
  const probeHw = d.probeHardware ?? ((p) => probeHardware({ diskPath: p, env }));

  switch (command) {
    case "check":
      return check(d, env, flags, values, probeTc, probeHw);
    case "smoke":
    case "room":
      return real(d, command, env, flags, values, probeTc, probeHw);
    case "render":
      return renderCmd(d, values);
    case "verdict":
      return verdictCmd(d, values);
    default:
      d.out(USAGE);
      return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
}

/** The nearest existing directory of `p` (statfs needs one). */
async function existingAncestor(p: string): Promise<string> {
  const { stat } = await import("node:fs/promises");
  let cur = path.resolve(p);
  for (;;) {
    if ((await stat(cur).catch(() => null))?.isDirectory()) return cur;
    const up = path.dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
}

async function check(
  d: CliDeps,
  env: Record<string, string | undefined>,
  flags: Set<string>,
  values: Map<string, string>,
  probeTc: NonNullable<CliDeps["probeToolchain"]>,
  probeHw: NonNullable<CliDeps["probeHardware"]>,
): Promise<number> {
  const profile = values.get("--profile") ?? "default";
  let config = null;
  let problem: string | null = null;
  try {
    config = await readConfig(profileDir(resolveAgentHome(env, d.repoRoot), profile));
  } catch (e) {
    problem = e instanceof Error ? e.message.slice(0, 200) : "The agent profile could not be read.";
  }
  const workRoot = resolveWorkRoot(env, d.repoRoot);
  const [toolchain, hardware] = await Promise.all([probeTc(env), probeHw(await existingAncestor(workRoot))]);
  const report = buildReadiness({ env, hardware, toolchain, agent: { profile, config, problem } });
  if (flags.has("--json")) d.out(JSON.stringify(report, null, 2));
  else
    d.out(
      formatReadiness(report, {
        diagnostic: flags.has("--diagnostic"),
        toolPaths: { colmap: toolchain.colmap.absolutePath, brush: toolchain.brush.absolutePath },
      }),
    );
  return report.readyForRealAcceptance ? 0 : 1;
}

async function real(
  d: CliDeps,
  command: "smoke" | "room",
  env: Record<string, string | undefined>,
  flags: Set<string>,
  values: Map<string, string>,
  probeTc: NonNullable<CliDeps["probeToolchain"]>,
  probeHw: NonNullable<CliDeps["probeHardware"]>,
): Promise<number> {
  const mode = command === "smoke" ? "REAL_SMOKE" : "REAL_ROOM";
  if (!flags.has("--real"))
    throw new AcceptanceInputError(
      `${mode} runs the REAL native tools (COLMAP on the CPU, Brush on the GPU) for minutes to hours. Re-run with --real to confirm.`,
    );
  if (inTests(d.env))
    throw new AcceptanceInputError(`${mode} never runs inside automated tests (NODE_ENV=test / VITEST).`);

  // ── inputs and output ──
  const inputDir = values.get("--input");
  if (command === "room" && !inputDir)
    throw new AcceptanceInputError("room needs --input <absolute photo directory>.");
  let output = values.get("--output");
  if (command === "room" && !output)
    throw new AcceptanceInputError("room needs --output <absolute new directory>.");
  if (!output) {
    const root = resolveWorkRoot(env, d.repoRoot);
    output = path.join(
      path.dirname(root),
      "acceptance",
      `smoke-${newAcceptanceRunId(new Date(d.now?.() ?? Date.now())).slice(4)}`,
    );
  }
  await checkOutputDirectory(output, { repoRoot: d.repoRoot, inputDir });

  let inputs: AcceptanceInput[];
  let datasetKind: "synthetic" | "photos";
  let skippedNote = "";
  if (inputDir) {
    const scan = await scanPhotoDirectory(inputDir, { repoRoot: d.repoRoot });
    inputs = scan.photos.map((p) => ({
      ordinal: p.ordinal,
      source: { kind: "file", path: p.path },
      mime: p.mime,
      sha256: p.sha256,
      byteSize: p.byteSize,
      width: p.width,
      height: p.height,
    }));
    datasetKind = "photos";
    const s = scan.skipped;
    if (s.links + s.directories + s.notImages)
      skippedNote = ` (skipped: ${s.links} links, ${s.directories} folders, ${s.notImages} non-image files; none were read)`;
  } else {
    const { createHash } = await import("node:crypto");
    inputs = renderSyntheticRoom().map((v, ordinal) => ({
      ordinal,
      source: { kind: "bytes", bytes: v.png },
      mime: "image/png",
      sha256: createHash("sha256").update(v.png).digest("hex"),
      byteSize: v.png.length,
      width: 512,
      height: 384,
    }));
    datasetKind = "synthetic";
  }

  // ── gates: toolchain READY, hardware not UNSUPPORTED (and practical for a room unless the risk is accepted) ──
  const [toolchain, hardware] = await Promise.all([probeTc(env), probeHw(await existingAncestor(output))]);
  const assessment = assessHardware(hardware, {
    roomInputBytes: command === "room" ? inputs.reduce((n, i) => n + i.byteSize, 0) : undefined,
  });
  if (toolchain.overall !== "ready") {
    d.err(`REFUSED: the toolchain is ${toolchain.overall.toUpperCase()}, not READY.`);
    if (toolchain.colmap.reason) d.err(`  COLMAP: ${toolchain.colmap.reason}`);
    if (toolchain.brush.reason) d.err(`  Brush: ${toolchain.brush.reason}`);
    d.err("  Run npm run local:acceptance:check for the full report.");
    return 2;
  }
  if (assessment.tier === "UNSUPPORTED") {
    d.err("REFUSED: this machine is UNSUPPORTED for real reconstruction:");
    for (const r of assessment.reasons) d.err(`  - ${r}`);
    return 2;
  }
  if (
    command === "room" &&
    assessment.decision !== "READY_FOR_REAL_RUN" &&
    !flags.has("--accept-hardware-risk")
  ) {
    d.err(`REFUSED: hardware is ${assessment.tier}, not practical for a room run:`);
    for (const r of assessment.reasons) d.err(`  - ${r}`);
    d.err("  Use a PRACTICAL machine, or re-run with --accept-hardware-risk after reading these reasons.");
    return 2;
  }

  // ── the plan, stated before anything runs ──
  d.out(`${mode}: REAL LOCAL COMPUTE`);
  d.out("  NETWORK PROVIDER CALLS: 0   PAID CALLS: 0   UPLOADS: 0");
  d.out(`  tools that will run (no shell):`);
  d.out(`    COLMAP ${toolchain.colmap.version}  ${toolchain.commands.colmap!.executable}`);
  d.out(`    Brush  ${toolchain.brush.version}  ${toolchain.commands.brush!.executable}`);
  d.out(
    `  inputs: ${inputs.length} ${datasetKind === "synthetic" ? "synthetic views (generated in memory)" : "photographs (read only; copied into the workspace, originals never written)"}${skippedNote}`,
  );
  d.out(`  output: ${output}`);
  d.out(`  Brush profile: ${mode === "REAL_SMOKE" ? "acceptance_smoke (tiny training run)" : "standard"}`);
  d.out(
    `  hardware: ${assessment.tier}; free disk ${hardware.disk.freeBytes === null ? "unknown" : fmtGiB(hardware.disk.freeBytes)}`,
  );

  const ctl = new AbortController();
  const onSig = () => ctl.abort();
  process.once("SIGINT", onSig);
  let res;
  try {
    res = await runAcceptance({
      mode,
      datasetKind,
      inputs,
      outputDir: output,
      toolchain,
      hardware,
      assessment,
      keepIntermediates: flags.has("--keep-intermediates"),
      signal: ctl.signal,
      log: (l) => d.out(`  … ${l}`),
      now: d.now,
    });
  } finally {
    process.off("SIGINT", onSig);
  }
  if (res.spzPath && !flags.has("--no-render")) await renderInto(d, output);
  const report = await readReport(output);
  d.out(
    `  outcome: ${report.outcome.status}${report.outcome.error ? ` (${report.outcome.error.code} at ${report.outcome.error.stage})` : ""}`,
  );
  d.out(`  machine verdict: ${report.verdict.machine}`);
  for (const r of report.verdict.machineReasons) d.out(`    - ${r}`);
  d.out(`  final verdict: ${report.verdict.final}`);
  d.out(`  report: ${path.join(output, "acceptance-report.json")}`);
  if (mode === "REAL_ROOM" && report.outcome.status === "succeeded")
    d.out(
      "  next: import the SPZ into Prism, fill in human-review.json, then npm run local:acceptance:verdict",
    );
  return report.outcome.status === "succeeded" ? 0 : 1;
}

async function renderInto(d: CliDeps, output: string): Promise<void> {
  const report = await readReport(output);
  const spz = new Uint8Array(await readFile(path.join(output, "splat.spz")));
  let browser: Browser | null = null;
  let detail: NonNullable<typeof report.validation.sparkRenderDetail>;
  let status: "pass" | "fail" | "not_run";
  const started = Date.now();
  try {
    const bundle = await bundleRenderPage(d.repoRoot);
    browser = await (
      d.launchBrowser ??
      (async () => (await import("@playwright/test")).chromium.launch({ args: RENDER_LAUNCH_ARGS }))
    )();
    const r = await renderSpzWithSpark({ spz, bundle, browser, outDir: output });
    status = r.status;
    detail = {
      gaussianCount: r.gaussianCount,
      frames: r.frames,
      webglRenderer: r.webgl.renderer?.slice(0, 200) ?? null,
      reasons: r.reasons.map((x) => x.slice(0, 300)),
    };
    d.out(
      `  Spark render: ${r.status.toUpperCase()} (${r.frames.map((f) => `${f.name} ${Math.round(f.coverage * 100)}%`).join(", ")})`,
    );
  } catch (e) {
    status = "not_run";
    detail = {
      gaussianCount: null,
      frames: [],
      webglRenderer: null,
      reasons: [`The render harness could not start: ${(e as Error).message.slice(0, 200)}`],
    };
    d.err(`  Spark render NOT RUN: ${detail.reasons[0]} (npx playwright install chromium)`);
  } finally {
    await browser?.close().catch(() => undefined);
  }
  const updated = {
    ...report,
    validation: { ...report.validation, sparkRender: status, sparkRenderDetail: detail },
  };
  updated.timingsMs = { ...updated.timingsMs, render_acceptance: Date.now() - started };
  const mv = machineVerdict(updated);
  const room = updated.mode === "REAL_ROOM" && mv.verdict !== "FAIL";
  await writeReport(
    output,
    acceptanceReportSchema.parse({
      ...updated,
      verdict: {
        machine: mv.verdict,
        machineReasons: mv.reasons,
        final: room ? "PENDING_HUMAN_REVIEW" : mv.verdict,
        finalReasons: room ? ["Awaiting the human review."] : mv.reasons,
      },
    }),
  );
}

async function renderCmd(d: CliDeps, values: Map<string, string>): Promise<number> {
  const output = values.get("--output");
  if (!output || !path.isAbsolute(output))
    throw new AcceptanceInputError("render needs --output <absolute run directory>.");
  await renderInto(d, output);
  return (await readReport(output)).validation.sparkRender === "pass" ? 0 : 1;
}

async function verdictCmd(d: CliDeps, values: Map<string, string>): Promise<number> {
  const output = values.get("--output");
  if (!output || !path.isAbsolute(output))
    throw new AcceptanceInputError("verdict needs --output <absolute run directory>.");
  const report = await readReport(output);
  let review = null;
  const raw = await readFile(path.join(output, "human-review.json"), "utf8").catch(() => null);
  if (raw) {
    const j = JSON.parse(raw) as Record<string, unknown>;
    // the reference copy of the checklist is not part of the answers
    delete j.checklist;
    delete j.limitation;
    const parsed = humanReviewSchema.safeParse(j);
    if (!parsed.success)
      throw new AcceptanceInputError("human-review.json is not a valid review (see its checklist).");
    review = parsed.data;
  }
  const f = finalVerdict(report, review);
  await writeReport(output, {
    ...report,
    verdict: { ...report.verdict, final: f.verdict, finalReasons: f.reasons.map((x) => x.slice(0, 300)) },
  });
  d.out(`FINAL VERDICT: ${f.verdict}`);
  for (const r of f.reasons) d.out(`  - ${r}`);
  await writeFile(
    path.join(output, "verdict.txt"),
    `${f.verdict}\n${f.reasons.map((r) => `- ${r}`).join("\n")}\n`,
  );
  return f.verdict === "FAIL" ? 1 : 0;
}

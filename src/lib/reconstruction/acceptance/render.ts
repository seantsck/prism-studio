import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Page } from "@playwright/test";
import type { RenderOutcome } from "./render-page";

/**
 * The REAL Spark render acceptance (M2D.3D1): renders an SPZ through Prism's production splat runtime in headless
 * Chromium and saves the frames for a human.
 *
 *   - the page and its bundle (three + @sparkjsdev/spark 0.1.10 + Prism's SplatRuntime) are built locally with esbuild
 *     and served from intercepted routes on a reserved `.invalid` origin; EVERY other request is aborted (no network)
 *   - WebGL runs on SwiftShader (the same software renderer the automated browser tests use), so the result does not
 *     depend on a desktop session or GPU driver; it proves the FILE renders, not this machine's GPU speed
 *   - PASS = it loaded with no load failure, no page error, no WebGL error, and the overview frame is not empty.
 *     Visual quality is never inferred from pixels: the human review decides that from the saved frames.
 */

export const SPARK_VERSION = "0.1.10";
const ORIGIN = "http://prism-acceptance.invalid";
export const MIN_OVERVIEW_COVERAGE = 0.005;

export interface SparkRenderResult {
  status: "pass" | "fail";
  reasons: string[];
  gaussianCount: number | null;
  frames: Array<{ name: string; coverage: number; file: string | null }>;
  errors: string[];
  blockedRequests: number;
  webgl: { renderer: string | null; version: string | null };
  spark: typeof SPARK_VERSION;
  durationMs: number;
}

/** Bundles the browser entry (Prism's production SplatRuntime + three + Spark) into one ESM string. */
export async function bundleRenderPage(repoRoot: string): Promise<string> {
  const esbuild = await import("esbuild");
  const r = await esbuild.build({
    entryPoints: [path.join(repoRoot, "src", "lib", "reconstruction", "acceptance", "render-page.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
    alias: { "@": path.join(repoRoot, "src") },
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".wasm": "binary" },
  });
  return r.outputFiles[0]!.text;
}

export const RENDER_LAUNCH_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
];

/**
 * Renders `spz` on `page` (a fresh page is created from `browser` if no page is given). Frames are written to
 * `outDir` (render-overview.png, render-interior.png) when given.
 */
export async function renderSpzWithSpark(o: {
  spz: Uint8Array;
  bundle: string;
  page?: Page;
  browser?: Browser;
  outDir?: string;
  timeoutMs?: number;
}): Promise<SparkRenderResult> {
  const started = Date.now();
  const page = o.page ?? (await o.browser!.newPage());
  const errors: string[] = [];
  let blocked = 0;
  page.on("pageerror", (e) => errors.push(`page error: ${e.message.slice(0, 300)}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console error: ${m.text().slice(0, 300)}`);
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      blocked++;
      return route.abort();
    }
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000"><script type="module" src="/app.js"></script></body>',
      });
    if (url.pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: o.bundle });
    if (url.pathname === "/splat.spz")
      return route.fulfill({ contentType: "application/octet-stream", body: Buffer.from(o.spz) });
    return route.fulfill({ status: 404, body: "" });
  });
  let outcome: RenderOutcome | null = null;
  try {
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => typeof window.__prismAcceptanceRender === "function", null, {
      timeout: o.timeoutMs ?? 120_000,
    });
    outcome = await page.evaluate((u) => window.__prismAcceptanceRender!(u), "/splat.spz");
  } catch (e) {
    errors.push(`render harness: ${(e as Error).message.slice(0, 300)}`);
  } finally {
    if (!o.page) await page.close().catch(() => undefined);
  }

  const frames: SparkRenderResult["frames"] = [];
  if (outcome && o.outDir) await mkdir(o.outDir, { recursive: true });
  for (const f of outcome?.frames ?? []) {
    let file: string | null = null;
    if (o.outDir) {
      file = `render-${f.name}.png`;
      await writeFile(path.join(o.outDir, file), Buffer.from(f.dataUrl.split(",")[1] ?? "", "base64"));
    }
    frames.push({ name: f.name, coverage: Math.round(f.coverage * 10_000) / 10_000, file });
  }
  const reasons: string[] = [];
  if (!outcome) reasons.push("The render harness did not complete.");
  else {
    if (outcome.loadFailures.length) reasons.push(...outcome.loadFailures.map((x) => `load: ${x}`));
    if (outcome.glErrors.length) reasons.push(`WebGL errors: ${outcome.glErrors.join(", ")}`);
    const overview = outcome.frames.find((f) => f.name === "overview");
    if (!overview || overview.coverage < MIN_OVERVIEW_COVERAGE)
      reasons.push("The overview frame is empty: the Production Camera does not see the splat.");
  }
  if (errors.length) reasons.push(...errors);
  return {
    status: reasons.length ? "fail" : "pass",
    reasons,
    gaussianCount: outcome?.gaussianCount ?? null,
    frames,
    errors,
    blockedRequests: blocked,
    webgl: outcome?.webgl ?? { renderer: null, version: null },
    spark: SPARK_VERSION,
    durationMs: Date.now() - started,
  };
}

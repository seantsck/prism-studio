import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeSpzFile, syntheticPlane } from "@/lib/splat/synthetic";
import { bundleRenderPage, MIN_OVERVIEW_COVERAGE, renderSpzWithSpark, RENDER_LAUNCH_ARGS } from "../render";

/**
 * The Spark render acceptance harness, against a synthetic SPZ: Prism's PRODUCTION SplatRuntime (Spark 0.1.10) in
 * headless Chromium (SwiftShader), with every network request refused. It proves the harness itself; the real SPZ
 * of a REAL run goes through the same function.
 */

let browser: Browser;
let bundle: string;
let tmp: string;
beforeAll(async () => {
  [bundle, browser] = await Promise.all([
    bundleRenderPage(process.cwd()),
    chromium.launch({ args: RENDER_LAUNCH_ARGS }),
  ]);
  tmp = await mkdtemp(path.join(os.tmpdir(), "prism-acceptance-render-"));
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("Spark render acceptance (production SplatRuntime, headless, offline)", { timeout: 120_000 }, () => {
  it("renders a valid SPZ: the Production Camera sees it, no WebGL or page error, frames saved for a human", async () => {
    const r = await renderSpzWithSpark({
      spz: encodeSpzFile(syntheticPlane({ n: 40 })),
      bundle,
      browser,
      outDir: tmp,
    });
    expect(r.reasons).toEqual([]);
    expect(r.status).toBe("pass");
    expect(r.gaussianCount).toBe(1600);
    expect(r.spark).toBe("0.1.10");
    expect(r.errors).toEqual([]);
    // nothing left the page: every resource came from the intercepted, local origin
    expect(r.blockedRequests).toBe(0);
    const overview = r.frames.find((f) => f.name === "overview")!;
    expect(overview.coverage).toBeGreaterThan(MIN_OVERVIEW_COVERAGE);
    expect((await readdir(tmp)).sort()).toEqual(["render-interior.png", "render-overview.png"]);
    const png = await readFile(path.join(tmp, "render-overview.png"));
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("a corrupt SPZ fails truthfully (production validation refuses it before Spark parses it)", async () => {
    const bytes = encodeSpzFile(syntheticPlane({ n: 8 }));
    bytes[bytes.length - 10] ^= 0xff;
    bytes[20] ^= 0xff;
    const r = await renderSpzWithSpark({ spz: bytes.subarray(0, bytes.length - 40), bundle, browser });
    expect(r.status).toBe("fail");
    expect(r.reasons.join(" ")).toMatch(/load: corrupt|empty/);
    expect(r.frames).toEqual([]);
  });
});

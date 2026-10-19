import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 2F M2D.2 — reference images → reconstruction job → spatial environment, memory mode.
 *
 * Only the FREE deterministic mock provider runs (World Labs is unconfigured on this server and paid generation is
 * off), so no request can reach a reconstruction provider. Everything else is real: the UI, the server actions that
 * derive every status, private storage, Prism's splat validation, the immutable reconstruction, the Set and the
 * GenerationPackage.
 */
test.use({
  launchOptions: {
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  },
});
test.describe.configure({ mode: "serial" });

const EP = "/projects/ojousama/episodes/ep-1";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const STAMP = Date.now();
const NAMES = [`recon-front-${STAMP}.png`, `recon-left-${STAMP}.png`, `recon-right-${STAMP}.png`];

async function openSet(page: Page, code = "3A") {
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: code, exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  const shotUrl = page.url().split("?")[0]!;
  await page.goto(`${shotUrl}?section=set`);
  await page.getByTestId("open-in-3d-set").click();
  await page.waitForURL(/\/locations\/[0-9a-f-]{36}\/3d\?shot=/);
  await ready(page);
  return { setUrl: page.url(), shotId: /\/shots\/([0-9a-f-]{36})/.exec(shotUrl)![1]! };
}

async function ready(page: Page) {
  await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(page.getByTestId("reconstruction-jobs")).toHaveAttribute("data-loaded", "true", {
    timeout: 30_000,
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (
            window as unknown as { __prismSet: { splat: { sceneLoaded(): boolean } } }
          ).__prismSet.splat.sceneLoaded(),
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
}

const spatial = <T>(page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    ([m, a]) =>
      (
        window as unknown as { __prismSet: { spatial: Record<string, (...x: unknown[]) => unknown> } }
      ).__prismSet.spatial[m as string](...(a as unknown[])),
    [method, args] as const,
  ) as Promise<T>;
const splatInfo = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __prismSet: {
          splat: {
            info(): {
              liveSplats: number;
              splatObjects: Array<{ id: string; scale: number[] }>;
              stats: Array<{ format: string }>;
            };
          };
        };
      }
    ).__prismSet.splat.info(),
  );
const setInput = async (page: Page, testId: string, value: string) => {
  const input = page.getByTestId(testId);
  await input.fill(value);
  await input.press("Enter");
};
const splatItem = (page: Page) => page.getByTestId("outliner-item").filter({ hasText: "gaussian splat" });
const job = (page: Page, id: string) => page.locator(`[data-testid="recon-job"][data-job-id="${id}"]`);
const sourceOrder = (page: Page) =>
  page.getByTestId("recon-source").evaluateAll((els) => els.map((e) => e.getAttribute("data-asset-id")));

async function generate(page: Page, scenario: string, names: string[]) {
  await page.getByTestId("recon-provider").selectOption("mock_reconstruction");
  while (await page.getByTestId("recon-source-remove").count())
    await page.getByTestId("recon-source-remove").first().click();
  for (const n of names) await page.getByTestId("recon-add-source").filter({ hasText: n }).click();
  await page.getByTestId("recon-mock-scenario").selectOption(scenario);
  await expect(page.getByTestId("recon-generate")).toBeEnabled({ timeout: 30_000 });
  const before = await page
    .getByTestId("recon-job")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-job-id")));
  await page.getByTestId("recon-generate").click();
  await expect
    .poll(async () => (await page.getByTestId("recon-job").count()) > before.length, { timeout: 30_000 })
    .toBe(true);
  const ids = await page
    .getByTestId("recon-job")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-job-id")));
  return ids.find((id) => !before.includes(id))!;
}

let setUrl = "";
let shotId = "";
let firstJob = "";
let imageIds: string[] = [];

test.describe("reconstruction jobs (mock provider, no provider cost)", () => {
  test("Location reference images exist in the private library", async ({ page }) => {
    for (const name of NAMES) {
      await page.goto("/projects/ojousama/assets");
      await page.locator("input[type=file]").setInputFiles({ name, mimeType: "image/png", buffer: PNG });
      await page.locator("select[name=purpose]").first().selectOption("location_ref");
      await page.getByRole("button", { name: "Upload asset" }).click();
      await expect(page.getByText(name).first()).toBeVisible({ timeout: 30_000 });
    }
  });

  test("provider status: World Labs is honestly 'not configured' and cannot be submitted", async ({
    page,
  }) => {
    ({ setUrl, shotId } = await openSet(page));
    await page.getByTestId("recon-provider").selectOption("worldlabs_marble");
    await expect(page.getByTestId("recon-provider-status")).toHaveAttribute("data-state", "not_configured");
    await expect(page.getByTestId("recon-gate")).toContainText("World Labs is not configured");
    await expect(page.getByTestId("recon-generate")).toBeDisabled();
    // it never reveals anything but configured / not configured
    await expect(page.getByTestId("reconstruction-jobs")).not.toContainText(/WLT_API_KEY|api key/i);
  });

  test("ordered sources → mock job → progress → resume after navigation → validated result → Set untouched → Use as Spatial Environment → package", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(400_000);
    const origin = new URL(baseURL!).origin;
    const foreign: string[] = [];
    page.on("request", (r) => {
      const u = r.url();
      if (!u.startsWith("data:") && !u.startsWith("blob:") && new URL(u).origin !== origin) foreign.push(u);
    });
    await page.goto(setUrl);
    await ready(page);
    // start from an empty saved Set so "unchanged" is unambiguous
    await spatial(page, "clearScene");
    await page.getByTestId("save-set").click();
    await expect(page.getByTestId("set-status")).toContainText(/Saved — revision/, { timeout: 60_000 });
    const savedBefore = await page.getByTestId("virtual-set").getAttribute("data-saved-fingerprint");

    // choose three images, then reorder: the primary image changes
    await page.getByTestId("recon-provider").selectOption("mock_reconstruction");
    await expect(page.getByTestId("recon-provider-status")).toHaveAttribute("data-state", "ready");
    for (const n of NAMES) await page.getByTestId("recon-add-source").filter({ hasText: n }).click();
    const initial = await sourceOrder(page);
    expect(initial).toHaveLength(3);
    imageIds = initial as string[];
    await page.getByTestId("recon-source-down").first().click(); // [1,0,2]
    await page.getByTestId("recon-source-primary").nth(2).click(); // [2,1,0]
    const ordered = await sourceOrder(page);
    expect(ordered).toEqual([imageIds[2], imageIds[1], imageIds[0]]);
    await expect(page.getByTestId("recon-source").first()).toHaveAttribute("data-primary", "true");
    await expect(page.getByTestId("recon-cost")).toContainText("No provider cost");

    await page.getByTestId("recon-mock-scenario").selectOption("success");
    const existing = await page
      .getByTestId("recon-job")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-job-id")));
    await page.getByTestId("recon-generate").click();
    await expect
      .poll(async () => (await page.getByTestId("recon-job").count()) > existing.length, { timeout: 30_000 })
      .toBe(true);
    firstJob = (
      await page.getByTestId("recon-job").evaluateAll((els) => els.map((e) => e.getAttribute("data-job-id")))
    ).find((id) => !existing.includes(id))!;
    await expect(job(page, firstJob)).toHaveAttribute("data-status", /queued|submitting|running/);
    await expect(job(page, firstJob)).toHaveAttribute("data-status", "running", { timeout: 30_000 });
    // progress is reported while it runs (read from THIS job's bar, after at least one provider poll)
    const progressOf = async () =>
      Number((await job(page, firstJob).getByTestId("recon-progress").getAttribute("data-progress")) ?? "0");
    await expect.poll(progressOf, { timeout: 30_000 }).toBeGreaterThan(0);
    const p1 = await progressOf();

    // navigate away and back: the SAME job resumes from its stored operation id
    await page.getByRole("link", { name: "← Locations" }).click();
    await page.waitForURL(/\/locations$/);
    await page.goto(setUrl);
    await ready(page);
    await expect(job(page, firstJob)).toBeVisible();
    await expect(job(page, firstJob)).toHaveAttribute("data-status", "succeeded", { timeout: 90_000 });
    expect(p1).toBeGreaterThan(0);

    // the result is a validated private Asset + immutable reconstruction... and the Set has NOT changed
    await job(page, firstJob).click();
    await expect(page.getByTestId("recon-result")).toContainText("SPZ");
    await expect(page.getByTestId("recon-result")).toContainText("scale unknown");
    await expect(page.getByTestId("recon-thumb")).toHaveCount(3);
    for (const src of await page
      .getByTestId("recon-thumb")
      .evaluateAll((els) => els.map((e) => (e as HTMLImageElement).getAttribute("src"))))
      expect(src).toMatch(/^\/api\/assets\/[0-9a-f-]{36}$/);
    await expect(splatItem(page)).toHaveCount(0);
    expect(await page.getByTestId("virtual-set").getAttribute("data-saved-fingerprint")).toBe(savedBefore);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-dirty", "false");

    // ONLY the explicit action places it
    await page.getByTestId("recon-use").click();
    await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("set-status")).toContainText("Spatial environment added");
    const info = await splatInfo(page);
    expect(info.liveSplats).toBe(1);
    expect(info.stats.at(-1)!.format).toBe("spz");
    await splatItem(page).click();
    await expect(page.getByTestId("splat-scale-status")).toContainText("unknown units"); // metric scale NOT assumed
    await expect(page.getByTestId("splat-provenance")).toContainText("generated");
    await setInput(page, "inspector-pos-x", "0.5");
    await page.getByTestId("save-set").click();
    await expect(page.getByTestId("set-status")).toContainText(/Saved — revision/, { timeout: 60_000 });
    expect(await page.getByTestId("virtual-set").getAttribute("data-saved-fingerprint")).not.toBe(
      savedBefore,
    );

    // Production Camera + master frame
    await setInput(page, "camera-pos-x", "0");
    await setInput(page, "camera-pos-y", "1");
    await setInput(page, "camera-pos-z", "6");
    await setInput(page, "camera-rot-x", "0");
    await setInput(page, "camera-rot-y", "0");
    await setInput(page, "camera-rot-z", "0");
    await page.getByTestId("link-shot-camera").click();
    await expect(page.getByTestId("set-status")).toContainText(/Production camera linked/, {
      timeout: 60_000,
    });
    const frames = page.getByTestId("master-frame-image");
    const n = await frames.count();
    await page.getByTestId("capture-master-frame").click();
    await expect(frames).toHaveCount(n + 1, { timeout: 90_000 });
    const px = await page.evaluate(
      async (src) => {
        const bmp = await createImageBitmap(await (await fetch(src)).blob());
        const c = document.createElement("canvas");
        c.width = bmp.width;
        c.height = bmp.height;
        const g = c.getContext("2d", { willReadFrequently: true })!;
        g.drawImage(bmp, 0, 0);
        return [
          Array.from(g.getImageData(956 + 120, 400, 1, 1).data.slice(0, 3)),
          Array.from(g.getImageData(15, 15, 1, 1).data.slice(0, 3)),
        ];
      },
      (await frames.first().getAttribute("src"))!,
    );
    expect(
      Math.max(...px[0]!.map((v, i) => Math.abs(v - px[1]![i]!))),
      "the reconstruction is in the master frame",
    ).toBeGreaterThan(30);

    // a visible generated splat is still a splat: exact control passes stay blocked (M2C gate unchanged)
    await expect(page.getByTestId("capture-spatial-passes")).toBeDisabled();
    await expect(page.getByTestId("spatial-gate")).toContainText(
      "Gaussian splat environments are not supported yet",
    );

    // the package carries the job/provider provenance ONLY through the selected environment
    const res = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
    expect(res.ok()).toBe(true);
    const pkg = (await res.json()) as {
      prompt: { positive: string };
      spatialReference?: {
        spatialEnvironment?: {
          sourceReferenceAssetIds: string[];
          calibration: { scaleMethod: string };
          generation?: {
            method: string;
            jobId: string;
            provider: string;
            operationId: string | null;
            attempt: number;
          };
        };
      };
    };
    const env = pkg.spatialReference!.spatialEnvironment!;
    expect(env.generation).toMatchObject({
      method: "generated",
      jobId: firstJob,
      provider: "mock_reconstruction",
      attempt: 1,
    });
    expect(env.generation!.operationId).toMatch(/^mockop_success_/);
    expect(env.sourceReferenceAssetIds).toEqual(ordered); // the job's ORDER, primary first
    expect(env.calibration.scaleMethod).toBe("unknown");
    expect(JSON.stringify(pkg.spatialReference)).not.toMatch(/https?:|blob:|signature|token=/i);
    expect(pkg.prompt.positive).not.toMatch(/splat|gaussian|reconstruction|mock/i);
    expect(JSON.stringify(pkg)).not.toContain("reconstruction_jobs");

    expect(foreign, "no request leaves the Prism origin").toEqual([]);
  });

  test("a failing job, a retry as a NEW attempt, and a cancelled job leave the chosen environment untouched", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page.goto(setUrl);
    await ready(page);
    await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
    const saved = await page.getByTestId("virtual-set").getAttribute("data-saved-fingerprint");

    // history: the first job is retained
    await expect(job(page, firstJob)).toHaveAttribute("data-status", "succeeded");

    const failing = await generate(page, "fail", NAMES.slice(0, 2));
    await expect(job(page, failing)).toHaveAttribute("data-status", "failed", { timeout: 60_000 });
    await job(page, failing).click();
    await expect(page.getByTestId("recon-error")).toContainText("failed this reconstruction on purpose");

    await page.getByTestId("recon-retry").click();
    await expect(page.locator(`[data-testid="recon-job"][data-previous-job-id="${failing}"]`)).toHaveCount(
      1,
      {
        timeout: 30_000,
      },
    );
    await expect(job(page, failing)).toHaveAttribute("data-status", "failed"); // the failed attempt is history
    await expect(
      page.locator(`[data-testid="recon-job"][data-previous-job-id="${failing}"]`),
    ).toHaveAttribute("data-status", "failed", {
      timeout: 60_000,
    });

    const slow = await generate(page, "slow", NAMES.slice(0, 1));
    await expect(job(page, slow)).toHaveAttribute("data-status", "running", { timeout: 30_000 });
    await job(page, slow).click();
    await page.getByTestId("recon-cancel").click();
    await expect(job(page, slow)).toHaveAttribute("data-status", "cancelled", { timeout: 30_000 });
    await page.waitForTimeout(2500);
    await expect(job(page, slow)).toHaveAttribute("data-status", "cancelled"); // stays cancelled

    // invalid and oversize results are refused by Prism, never stored
    const invalid = await generate(page, "invalid", NAMES.slice(0, 1));
    await expect(job(page, invalid)).toHaveAttribute("data-status", "failed", { timeout: 60_000 });
    await job(page, invalid).click();
    await expect(page.getByTestId("recon-error")).toContainText("not a valid splat");
    const oversize = await generate(page, "oversize", NAMES.slice(0, 1));
    await expect(job(page, oversize)).toHaveAttribute("data-status", "failed", { timeout: 60_000 });
    await job(page, oversize).click();
    await expect(page.getByTestId("recon-error")).toContainText("larger than Prism");

    // the chosen environment and the saved Set never moved
    await expect(splatItem(page)).toHaveCount(1);
    expect(await page.getByTestId("virtual-set").getAttribute("data-saved-fingerprint")).toBe(saved);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-dirty", "false");
  });

  test("replacing an existing spatial environment needs an explicit confirmation", async ({ page }) => {
    test.setTimeout(200_000);
    await page.goto(setUrl);
    await ready(page);
    await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
    const second = await generate(page, "success", NAMES.slice(1, 3));
    await expect(job(page, second)).toHaveAttribute("data-status", "succeeded", { timeout: 90_000 });
    await job(page, second).click();
    const before = (await splatInfo(page)).splatObjects[0]!.id;
    await page.getByTestId("recon-use").click();
    await expect(page.getByTestId("recon-replace")).toBeVisible();
    expect((await splatInfo(page)).splatObjects[0]!.id).toBe(before); // nothing replaced yet
    await page.getByTestId("recon-replace-confirm").click();
    await expect
      .poll(async () => (await splatInfo(page)).splatObjects[0]?.id, { timeout: 60_000 })
      .not.toBe(before);
    await expect(splatItem(page)).toHaveCount(1);
    // the previous job and its reconstruction stay in history
    await expect(job(page, firstJob)).toHaveAttribute("data-status", "succeeded");
  });
});

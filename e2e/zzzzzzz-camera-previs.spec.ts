import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 2F M2A — camera motion + local previs, end to end (memory mode, no provider calls).
 * Shot → camera path (keyframes, lens) → persistence → deterministic playback → editor-only overlay →
 * local previs render + encode → private asset → stale detection → GenerationPackage cameraMotion.
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

const PROJECT = "/projects/ojousama";
const EP = `${PROJECT}/episodes/ep-1`;

async function openSetFromShot(page: Page) {
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: "3A", exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  const shotUrl = page.url().split("?")[0];
  await page.goto(`${shotUrl}?section=set`);
  await page.getByTestId("open-in-3d-set").click();
  await page.waitForURL(/\/locations\/[0-9a-f-]{36}\/3d\?shot=/);
  await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  return { shotUrl, setUrl: page.url() };
}

const setInput = async (page: Page, testId: string, value: string) => {
  const input = page.getByTestId(testId);
  await input.fill(value);
  await input.press("Enter");
};

type Hook = {
  productionCamera(): { position: number[]; rotation: number[]; focalLengthMm: number } | null;
  navigationCamera(): { position: number[]; rotation: number[]; fov: number } | null;
  setNavigationCamera(p: number[], l: number[]): void;
  overlay(): { present: boolean; onEditorLayerOnly: boolean };
};
const prod = (page: Page) =>
  page.evaluate(() => (window as unknown as { __prismSet: Hook }).__prismSet.productionCamera());
const nav = (page: Page) =>
  page.evaluate(() => (window as unknown as { __prismSet: Hook }).__prismSet.navigationCamera());
const overlay = (page: Page) =>
  page.evaluate(() => (window as unknown as { __prismSet: Hook }).__prismSet.overlay());

const duration = async (page: Page) =>
  Number(await page.getByTestId("timeline-track").getAttribute("data-duration-ms"));

async function clickTimeline(page: Page, fraction: number) {
  const box = (await page.getByTestId("timeline-track").boundingBox())!;
  await page.mouse.click(
    box.x + Math.min(box.width - 2, Math.max(2, box.width * fraction)),
    box.y + box.height - 3,
  );
}

const kfTimes = async (page: Page) =>
  (
    await page
      .getByTestId("kf-marker")
      .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-time-ms"))))
  )
    .slice()
    .sort((a, b) => a - b);

const meanDiff = (page: Page, a: string, b: string) =>
  page.evaluate(
    async ([x, y]) => {
      const load = (src: string) =>
        new Promise<ImageData>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement("canvas");
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const g = c.getContext("2d")!;
            g.drawImage(img, 0, 0);
            resolve(g.getImageData(0, 0, c.width, c.height));
          };
          img.onerror = () => reject(new Error("image failed"));
          img.src = src;
        });
      const [p, q] = await Promise.all([load(x), load(y)]);
      let total = 0;
      for (let i = 0; i < p.data.length; i += 4)
        total += Math.abs(p.data[i] - q.data[i]) + Math.abs(p.data[i + 1] - q.data[i + 1]);
      return total / (p.width * p.height);
    },
    [a, b],
  );

test.describe("camera motion and local previs", () => {
  let setUrl = "";
  let shotUrl = "";
  let shotId = "";
  let dur = 0;

  test("authors a three-keyframe camera path with a lens move and saves it", async ({ page }) => {
    test.setTimeout(120_000);
    const opened = await openSetFromShot(page);
    setUrl = opened.setUrl;
    shotUrl = opened.shotUrl;
    shotId = /\/shots\/([0-9a-f-]{36})/.exec(shotUrl)![1];
    const set = page.getByTestId("virtual-set");
    await page.getByTestId("load-test-set").click();
    await expect(set).toHaveAttribute("data-dirty", "true");

    // KF1: wide on 35 mm
    await setInput(page, "camera-pos-x", "3");
    await setInput(page, "camera-pos-y", "1.7");
    await setInput(page, "camera-pos-z", "9");
    await setInput(page, "camera-focal", "35");
    await page.getByTestId("create-camera-path").click();
    await expect(page.getByTestId("kf-marker")).toHaveCount(1);
    dur = await duration(page);
    expect(dur).toBeGreaterThan(0);

    // KF2: push in, 50 mm
    await setInput(page, "camera-pos-x", "1.4");
    await setInput(page, "camera-pos-z", "4");
    await setInput(page, "camera-focal", "50");
    await clickTimeline(page, 0.5);
    await page.getByTestId("kf-add").click();
    await expect(page.getByTestId("kf-marker")).toHaveCount(2);
    await setInput(page, "kf-time", String(Math.round(dur / 2)));

    // KF3: closer, 70 mm
    await setInput(page, "camera-pos-x", "0");
    await setInput(page, "camera-pos-z", "0.5");
    await setInput(page, "camera-focal", "70");
    await page.getByTestId("to-end").click();
    await page.getByTestId("kf-add").click();
    await expect(page.getByTestId("kf-marker")).toHaveCount(3);
    expect(await kfTimes(page)).toEqual([0, Math.round(dur / 2), dur]);

    // the editor shows the path in the set (editor-only layer) and the lens readout
    expect(await overlay(page)).toEqual({ present: true, onEditorLayerOnly: true });
    await expect(page.getByTestId("lens-display")).toContainText("70 mm");

    await page.getByTestId("save-path").click();
    await expect(page.getByTestId("path-status")).toContainText("Camera path saved — revision 1", {
      timeout: 30_000,
    });
  });

  test("the path persists across navigation with its keyframe values", async ({ page }) => {
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(page.getByTestId("kf-marker")).toHaveCount(3);
    expect(await kfTimes(page)).toEqual([0, Math.round(dur / 2), dur]);
    await page.getByTestId("kf-marker").nth(1).click();
    await expect(page.getByTestId("kf-focal")).toHaveValue("50");
    await expect(page.getByTestId("kf-pos-x")).toHaveValue("1.4");
    await expect(page.getByTestId("path-state")).toContainText("Saved revision 1");
    await expect(page.getByTestId("path-stale")).toHaveCount(0);
  });

  test("scrubbing and playback evaluate the production camera; the editor camera stays independent", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    const navStart = await nav(page);
    // exact keyframe evaluation
    await page.getByTestId("kf-marker").nth(1).click();
    await expect.poll(async () => (await prod(page))?.focalLengthMm).toBeCloseTo(50, 3);
    const mid = (await prod(page))!;
    expect(mid.position[0]).toBeCloseTo(1.4, 3);
    expect(mid.position[2]).toBeCloseTo(4, 3);
    await page.getByTestId("kf-marker").nth(0).click();
    await expect.poll(async () => (await prod(page))?.focalLengthMm).toBeCloseTo(35, 3);
    // between keyframes the lens is between the two
    await clickTimeline(page, 0.25);
    const quarter = (await prod(page))!;
    expect(quarter.focalLengthMm).toBeGreaterThan(35);
    expect(quarter.focalLengthMm).toBeLessThan(50);
    expect(quarter.position[2]).toBeLessThan(9);
    expect(quarter.position[2]).toBeGreaterThan(4);

    // the operator navigates elsewhere: scrubbing never moves the navigation camera
    await page.evaluate(() =>
      (window as unknown as { __prismSet: Hook }).__prismSet.setNavigationCamera([26, 20, -24], [0, 0, 0]),
    );
    const navMoved = await nav(page);
    expect(JSON.stringify(navMoved)).not.toBe(JSON.stringify(navStart));
    await page.getByTestId("kf-marker").nth(2).click();
    await expect.poll(async () => (await prod(page))?.focalLengthMm).toBeCloseTo(70, 3);
    expect(JSON.stringify(await nav(page))).toBe(JSON.stringify(navMoved));

    // play: the lens rises smoothly and monotonically to 70 mm, still without touching the editor camera
    await page.getByTestId("to-start").click();
    await page.getByTestId("play-path").click();
    const lenses: number[] = [];
    const deadline = Date.now() + dur + 8000;
    while (Date.now() < deadline) {
      const c = await prod(page);
      if (c) lenses.push(c.focalLengthMm);
      if ((await page.getByTestId("camera-motion").getAttribute("data-playing")) === "false") break;
      await page.waitForTimeout(60);
    }
    // the loop reads the lens BEFORE it checks the playing flag, so the last frame can land in between:
    // read the settled end state once playback has actually stopped
    await expect(page.getByTestId("camera-motion")).toHaveAttribute("data-playing", "false");
    const settled = await prod(page);
    if (settled) lenses.push(settled.focalLengthMm);
    expect(lenses.length).toBeGreaterThan(5);
    for (let i = 1; i < lenses.length; i++) expect(lenses[i]).toBeGreaterThanOrEqual(lenses[i - 1] - 1e-6);
    expect(lenses.some((l) => l > 36 && l < 69)).toBe(true);
    expect(lenses.at(-1)!).toBeCloseTo(70, 1);
    expect(JSON.stringify(await nav(page))).toBe(JSON.stringify(navMoved));
    // playing a path never leaves the scene "dirty": the authored camera is what gets saved
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-dirty", "false");
  });

  test("the path overlay is editor-only: master frames match with it on and off", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await page.getByTestId("link-shot-camera").click();
    await expect(page.getByTestId("set-status")).toContainText("Production camera linked", {
      timeout: 30_000,
    });
    const frames = page.getByTestId("master-frame-image");
    const capture = async () => {
      const n = await frames.count();
      await page.getByTestId("capture-master-frame").click();
      await expect(frames).toHaveCount(n + 1, { timeout: 30_000 });
      return (await frames.first().getAttribute("src"))!;
    };
    expect((await overlay(page)).present).toBe(true);
    const withOverlay = await capture();
    await page.getByTestId("path-overlay-toggle").uncheck();
    await expect.poll(async () => (await overlay(page)).present).toBe(false);
    const withoutOverlay = await capture();
    expect(await meanDiff(page, withOverlay, withoutOverlay)).toBeLessThan(0.5);
    await page.getByTestId("path-overlay-toggle").check();
  });

  test("renders a local previs in the browser: private asset, same-origin only", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    const origin = new URL(baseURL!).origin;
    const foreign: string[] = [];
    page.on("request", (r) => {
      const u = r.url();
      if (u.startsWith("data:") || u.startsWith("blob:")) return;
      if (new URL(u).origin !== origin) foreign.push(u);
    });
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    const navBefore = JSON.stringify(await nav(page));
    // the seeded take audio has no stored file; audio previs is covered by zzzzzzzz-previs-audio.spec.ts
    if (await page.getByTestId("include-audio").isEnabled())
      await page.getByTestId("include-audio").uncheck();
    await page.getByTestId("render-previs").click();
    await expect(page.getByTestId("previs-progress")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("path-status")).toContainText(/Previs saved privately \(956×400/, {
      timeout: 220_000,
    });
    await expect(page.getByTestId("previs-video")).toBeVisible();
    await expect(page.getByTestId("previs-current")).toBeVisible();
    const src = (await page.getByTestId("previs-video").getAttribute("src"))!;
    const res = await page.request.get(src);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/^video\/(mp4|webm)/);
    expect((await res.body()).length).toBeGreaterThan(2000);
    await expect(page.getByTestId("previs-player")).toContainText(/956×400/);
    await expect(page.getByTestId("previs-player")).toContainText(/(mp4|webm)\//);
    expect(foreign, "no request leaves the origin").toEqual([]);
    // rendering never touched the editor camera
    expect(JSON.stringify(await nav(page))).toBe(navBefore);
  });

  test("the shot shows its latest previs; editing the path marks it stale and keeps history", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto(`${shotUrl}?section=set`);
    await expect(page.getByTestId("shot-previs")).toBeVisible();
    await expect(page.getByTestId("shot-previs-stale")).toHaveCount(0);
    await expect(page.getByTestId("shot-camera-motion")).toContainText("3 keyframes");

    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await page.getByTestId("kf-marker").nth(2).click();
    await setInput(page, "kf-focal", "85");
    await expect(page.getByTestId("path-state")).toContainText("unsaved changes");
    await page.getByTestId("save-path").click();
    await expect(page.getByTestId("path-status")).toContainText("Camera path saved — revision 2", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("previs-stale")).toBeVisible();

    await page.goto(`${shotUrl}?section=set`);
    await expect(page.getByTestId("shot-previs-stale")).toBeVisible();

    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    // the seeded take audio has no stored file; audio previs is covered by zzzzzzzz-previs-audio.spec.ts
    if (await page.getByTestId("include-audio").isEnabled())
      await page.getByTestId("include-audio").uncheck();
    await page.getByTestId("render-previs").click();
    await expect(page.getByTestId("path-status")).toContainText(/Previs saved privately/, {
      timeout: 220_000,
    });
    await expect(page.getByTestId("previs-current")).toBeVisible();
    await expect(page.getByTestId("previs-history-item")).toHaveCount(1);
    await expect(page.getByTestId("previs-history-item").first()).toContainText("path r1");
  });

  test("the generation package freezes cameraMotion; a later path edit does not alter the old package", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    type Pkg = {
      provenance: { fingerprint: string };
      spatialReference?: {
        cameraMotion?: {
          cameraPathRevision: number;
          cameraPathFingerprint: string;
          durationMs: number;
          frameRate: number;
          focalLengthBasis: string;
          previsAssetId: string | null;
          keyframes: Array<{ focalLengthMm: number }>;
        };
      };
    };
    const get = async () => {
      const r = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
      expect(r.ok()).toBe(true);
      return (await r.json()) as Pkg;
    };
    const a = await get();
    const aText = JSON.stringify(a);
    const m = a.spatialReference!.cameraMotion!;
    expect(m.cameraPathRevision).toBe(2);
    expect(m.keyframes).toHaveLength(3);
    expect(m.keyframes[2].focalLengthMm).toBe(85);
    expect(m.focalLengthBasis).toBe("vertical-sensor-24mm");
    expect(m.previsAssetId).toBeTruthy(); // the latest previs was rendered from exactly this path

    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await page.getByTestId("kf-marker").nth(2).click();
    await setInput(page, "kf-focal", "60");
    await page.getByTestId("save-path").click();
    await expect(page.getByTestId("path-status")).toContainText("Camera path saved — revision 3", {
      timeout: 30_000,
    });

    const b = await get();
    const mb = b.spatialReference!.cameraMotion!;
    expect(mb.cameraPathRevision).toBe(3);
    expect(mb.cameraPathFingerprint).not.toBe(m.cameraPathFingerprint);
    expect(b.provenance.fingerprint).not.toBe(a.provenance.fingerprint);
    expect(mb.keyframes[2].focalLengthMm).toBe(60);
    expect(mb.previsAssetId).toBeNull(); // no previs has been rendered from the new path yet
    // the earlier package, as captured, is untouched
    expect(JSON.stringify(a)).toBe(aText);
    expect(a.spatialReference!.cameraMotion!.keyframes[2].focalLengthMm).toBe(85);
  });
});

import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 2F M1 hardening: the reused ArtCraft viewport controls work inside Prism, and a master frame comes from
 * the frozen production camera rather than wherever the operator has navigated. Memory mode, no providers.
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
  return page.url();
}

type Pt = { x: number; y: number };
const project = (page: Page, id: string, offset?: { x: number; y: number; z: number }) =>
  page.evaluate(
    ([i, o]) =>
      (
        window as unknown as { __prismSet: { project: (i: string, o?: unknown) => Pt | null } }
      ).__prismSet.project(i as string, o ?? undefined),
    [id, offset ?? null] as const,
  );

const selectedObjectId = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="outliner-item"][data-selected="true"]');
    return el?.getAttribute("data-object-id") ?? null;
  });

const setInput = async (page: Page, testId: string, value: string) => {
  const input = page.getByTestId(testId);
  await input.fill(value);
  await input.press("Enter");
};

const num = async (page: Page, testId: string) => Number(await page.getByTestId(testId).inputValue());

async function drag(page: Page, from: Pt, to: Pt) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++)
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await page.mouse.up();
}

test.describe("reused ArtCraft viewport controls and the production camera", () => {
  let setUrl = "";

  test("a translate-gizmo drag moves the object, persists on save and survives reload", async ({ page }) => {
    setUrl = await openSetFromShot(page);
    const set = page.getByTestId("virtual-set");
    await page.getByTestId("add-box").click();
    const id = await selectedObjectId(page);
    expect(id).toBeTruthy();
    await page.getByTestId("mode-move").click();
    const before = {
      x: await num(page, "inspector-pos-x"),
      y: await num(page, "inspector-pos-y"),
      z: await num(page, "inspector-pos-z"),
    };

    const origin = (await project(page, id!))!;
    const px = (await project(page, id!, { x: 1, y: 0, z: 0 }))!;
    const len = Math.hypot(px.x - origin.x, px.y - origin.y);
    const dir = { x: (px.x - origin.x) / len, y: (px.y - origin.y) / len };

    // the gizmo arrow sits some distance out along the X axis; probe until a drag grabs it
    let moved = false;
    for (const d of [27, 23, 31, 19, 35, 40, 15, 45]) {
      const start = { x: origin.x + dir.x * d, y: origin.y + dir.y * d };
      const end = { x: start.x + dir.x * 70, y: start.y + dir.y * 70 };
      await drag(page, start, end);
      const x = await num(page, "inspector-pos-x");
      if (Math.abs(x - before.x) > 0.05) {
        moved = true;
        break;
      }
      // a missed drag may have deselected; reselect through the outliner
      await page.locator(`[data-testid="outliner-item"][data-object-id="${id}"]`).click();
    }
    expect(moved, "dragging the X translate arrow changed the object's X").toBe(true);
    const after = {
      x: await num(page, "inspector-pos-x"),
      y: await num(page, "inspector-pos-y"),
      z: await num(page, "inspector-pos-z"),
    };
    // constrained to one axis
    expect(after.x).toBeGreaterThan(before.x + 0.05);
    expect(Math.abs(after.y - before.y)).toBeLessThan(0.01);
    expect(Math.abs(after.z - before.z)).toBeLessThan(0.01);

    await expect(set).toHaveAttribute("data-dirty", "true");
    await page.getByTestId("save-set").click();
    await expect(page.getByTestId("set-status")).toContainText(/Saved — revision/);

    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await page.locator(`[data-testid="outliner-item"][data-object-id="${id}"]`).click();
    expect(await num(page, "inspector-pos-x")).toBeCloseTo(after.x, 2);
    expect(await num(page, "inspector-pos-y")).toBeCloseTo(after.y, 2);
  });

  test("a rotate-gizmo drag turns the object and the rotation persists", async ({ page }) => {
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await page.getByTestId("add-cylinder").click();
    const id = (await selectedObjectId(page))!;
    expect(id).toBeTruthy();
    await page.getByTestId("mode-rotate").click();
    const rot = async () => ({
      x: await num(page, "inspector-rot-x"),
      y: await num(page, "inspector-rot-y"),
      z: await num(page, "inspector-rot-z"),
    });
    const before = await rot();
    const origin = (await project(page, id))!;
    const px = (await project(page, id, { x: 1, y: 0, z: 0 }))!;
    const len = Math.hypot(px.x - origin.x, px.y - origin.y);
    const radial = { x: (px.x - origin.x) / len, y: (px.y - origin.y) / len };
    const tangent = { x: -radial.y, y: radial.x };

    let turned = false;
    for (const d of [45, 55, 65, 35, 75, 85, 95, 110]) {
      for (const sign of [1, -1]) {
        const start = { x: origin.x + radial.x * d * sign, y: origin.y + radial.y * d * sign };
        await drag(page, start, { x: start.x + tangent.x * 70, y: start.y + tangent.y * 70 });
        const r = await rot();
        if (Math.abs(r.x - before.x) + Math.abs(r.y - before.y) + Math.abs(r.z - before.z) > 1) {
          turned = true;
          break;
        }
        await page.locator(`[data-testid="outliner-item"][data-object-id="${id}"]`).click();
      }
      if (turned) break;
    }
    expect(turned, "dragging a rotate ring changed the object's rotation").toBe(true);
    const after = await rot();

    await page.getByTestId("save-set").click();
    await expect(page.getByTestId("set-status")).toContainText(/Saved — revision/);
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await page.locator(`[data-testid="outliner-item"][data-object-id="${id}"]`).click();
    expect(await num(page, "inspector-rot-x")).toBeCloseTo(after.x, 0);
    expect(await num(page, "inspector-rot-y")).toBeCloseTo(after.y, 0);
    expect(await num(page, "inspector-rot-z")).toBeCloseTo(after.z, 0);
  });

  test("the scale control stays available", async ({ page }) => {
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await page.locator('[data-testid="outliner-item"]').first().click();
    await page.getByTestId("mode-scale").click();
    await expect(page.getByTestId("mode-scale")).toHaveClass(/btn-primary/);
    await expect(page.getByTestId("inspector-scale-x")).toBeVisible();
  });

  test("a master frame comes from the production camera, not the editor camera", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(setUrl);
    const set = page.getByTestId("virtual-set");
    await expect(set).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    // a landmark to frame: the Hotel Canopy Test Set is around the origin
    await page.getByTestId("load-test-set").click();
    await expect(set).toHaveAttribute("data-dirty", "true");

    // production camera B: a pose looking toward the origin from the front
    await setInput(page, "camera-pos-x", "0");
    await setInput(page, "camera-pos-y", "1.6");
    await setInput(page, "camera-pos-z", "7");
    await setInput(page, "camera-focal", "35");
    await page.getByTestId("link-shot-camera").click();
    await expect(page.getByTestId("set-status")).toContainText("Production camera linked");

    const frames = page.getByTestId("master-frame-image");
    const capture = async () => {
      const n = await frames.count();
      await page.getByTestId("capture-master-frame").click();
      await expect(frames).toHaveCount(n + 1, { timeout: 30_000 });
      return (await frames.first().getAttribute("src"))!;
    };
    const diff = (a: string, b: string) =>
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
              img.onerror = () => reject(new Error("image failed: " + src));
              img.src = src;
            });
          const [p, q] = await Promise.all([load(x), load(y)]);
          let total = 0;
          for (let i = 0; i < p.data.length; i += 4)
            total += Math.abs(p.data[i] - q.data[i]) + Math.abs(p.data[i + 1] - q.data[i + 1]);
          return { w: p.width, h: p.height, mean: total / (p.width * p.height) };
        },
        [a, b],
      );
    const hook = () =>
      page.evaluate(() => (window as unknown as { __prismSet: unknown }).__prismSet !== undefined);
    expect(await hook()).toBe(true);
    const nav = () =>
      page.evaluate(() =>
        (window as unknown as { __prismSet: { navigationCamera(): unknown } }).__prismSet.navigationCamera(),
      );

    // editor camera A: wherever the operator happens to be; capture #1
    const navA = await nav();
    const first = await capture();

    // move the editor/navigation camera somewhere obviously different, then capture again
    await page.evaluate(() =>
      (
        window as unknown as { __prismSet: { setNavigationCamera(p: number[], l: number[]): void } }
      ).__prismSet.setNavigationCamera([28, 22, -26], [0, 0, 0]),
    );
    const navB = await nav();
    expect(JSON.stringify(navB)).not.toBe(JSON.stringify(navA));
    const second = await capture();
    // capture leaves the navigation camera exactly where the operator put it
    expect(JSON.stringify(await nav())).toBe(JSON.stringify(navB));

    const same = await diff(first, second);
    expect(same.w).toBe(1912);
    expect(same.h).toBe(800);
    expect(same.mean, "same production camera: same frame wherever the editor camera is").toBeLessThan(0.5);

    // a different production camera must give a different frame (capture follows the production camera)
    await setInput(page, "camera-pos-x", "4");
    await setInput(page, "camera-focal", "60");
    await page.getByTestId("link-shot-camera").click();
    await expect(page.getByTestId("set-status")).toContainText("Production camera linked");
    const third = await capture();
    const different = await diff(first, third);
    expect(different.mean).toBeGreaterThan(3);
  });

  test("the 3D set makes only same-origin requests and no vendored resource is missing", async ({
    page,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin;
    const foreign: string[] = [];
    const missing: string[] = [];
    page.on("request", (r) => {
      const u = r.url();
      if (u.startsWith("data:") || u.startsWith("blob:")) return;
      if (new URL(u).origin !== origin) foreign.push(u);
    });
    page.on("response", (r) => {
      if (r.status() >= 400 && r.url().startsWith(origin))
        missing.push(`${r.status()} ${new URL(r.url()).pathname}`);
    });
    await openSetFromShot(page);
    await page.getByTestId("add-box").click();
    await page.getByTestId("toggle-camera-view").click();
    await page.getByTestId("toggle-camera-view").click();
    expect(foreign, "no request leaves the origin").toEqual([]);
    expect(missing, "no vendored-engine resource is missing").toEqual([]);
  });
});

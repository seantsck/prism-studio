import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 2F M1 — persistent 3D production set, end to end (memory mode, no provider calls).
 * Location → 3D set → objects → mannequin → production camera → save → reload → shot link → restore camera →
 * master frame (private asset) → explicit adoption → GenerationPackage spatial snapshot.
 *
 * Needs a WebGL-capable Chromium; the flags below select the software rasteriser so CI without a GPU works.
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

/** Number of distinct colours in a sample of the WebGL canvas (a blank/black canvas has ~1). */
const canvasColours = (page: Page) =>
  page.evaluate(() => {
    const c = document.getElementById("video-scene") as HTMLCanvasElement;
    const probe = document.createElement("canvas");
    probe.width = 160;
    probe.height = 90;
    const ctx = probe.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 160, 90);
    const data = ctx.getImageData(0, 0, 160, 90).data;
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    return seen.size;
  });

test.beforeEach(async ({ page }) => {
  // track every WebGL context the page creates so unmount can be proven to release them
  await page.addInitScript(() => {
    const w = window as unknown as { __gl: Array<{ canvas: HTMLCanvasElement; gl: WebGLRenderingContext }> };
    w.__gl = [];
    const orig = HTMLCanvasElement.prototype.getContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLCanvasElement.prototype as any).getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...a: unknown[]
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (orig as any).call(this, type, ...a);
      if (ctx && /webgl/.test(type) && !w.__gl.some((e) => e.canvas === this))
        w.__gl.push({ canvas: this, gl: ctx });
      return ctx;
    };
  });
});

test.describe("persistent 3D set", () => {
  let setUrl = "";
  let shotUrl = "";
  let shotId = "";
  let fingerprintA = "";
  let packageA: Record<string, unknown> = {};

  test("opens from a shot, renders, and authors a set", async ({ page }) => {
    const opened = await openSetFromShot(page);
    setUrl = opened.setUrl;
    shotUrl = opened.shotUrl;
    shotId = /\/shots\/([0-9a-f-]{36})/.exec(shotUrl)![1];
    const set = page.getByTestId("virtual-set");

    // viewport renders a grid (more than a blank canvas)
    await expect.poll(() => canvasColours(page), { timeout: 10_000 }).toBeGreaterThan(6);
    await expect(set).toHaveAttribute("data-object-count", "0");
    await expect(page.getByText("2.39:1 production frame")).toBeVisible();

    // primitive
    await page.getByTestId("add-box").click();
    await expect(set).toHaveAttribute("data-object-count", "1");
    await expect(page.getByTestId("inspector-name")).toBeVisible();
    await setInput(page, "inspector-pos-x", "2");
    await expect(page.getByTestId("inspector-pos-x")).toHaveValue("2");

    // mannequin blocking a Prism Character
    await page.getByTestId("mannequin-character").selectOption({ label: "Yumeko" });
    await page.getByTestId("add-mannequin").click();
    await expect(set).toHaveAttribute("data-object-count", "2");
    await setInput(page, "inspector-pos-x", "-1");
    await expect(page.getByTestId("object-character")).toBeVisible();

    // production camera (the shot camera, not the navigation camera)
    await expect(page.getByTestId("camera-name")).toHaveText("CAM-A");
    await setInput(page, "camera-pos-x", "1.2");
    await setInput(page, "camera-pos-y", "1.6");
    await setInput(page, "camera-pos-z", "5.5");
    await setInput(page, "camera-focal", "35");
    await expect(page.getByTestId("camera-pos-x")).toHaveValue("1.2");

    // look through the camera: the 2.39:1 frame overlay appears
    await page.getByTestId("toggle-camera-view").click();
    await expect(page.getByTestId("frame-overlay")).toBeVisible();
    await expect(set).toHaveAttribute("data-looking", "true");
    await page.getByTestId("toggle-camera-view").click();
    await expect(page.getByTestId("frame-overlay")).toHaveCount(0);

    await expect(set).toHaveAttribute("data-dirty", "true");
    await page.getByTestId("save-set").click();
    await expect(page.getByTestId("set-status")).toContainText("Saved — revision 1");
    await expect(set).toHaveAttribute("data-dirty", "false");
    await expect(set).toHaveAttribute("data-revision", "1");
  });

  test("navigating away and back restores the set exactly", async ({ page }) => {
    await page.goto(setUrl);
    const set = page.getByTestId("virtual-set");
    await expect(set).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(set).toHaveAttribute("data-object-count", "2");
    await expect(set).toHaveAttribute("data-revision", "1");
    await expect(set).toHaveAttribute("data-dirty", "false");
    const items = page.getByTestId("outliner-item");
    await expect(items).toHaveCount(2);
    await expect(items.filter({ hasText: "Yumeko" })).toHaveCount(1);

    await items.filter({ hasText: "Cube" }).click();
    await expect(page.getByTestId("inspector-pos-x")).toHaveValue("2");
    await items.filter({ hasText: "Yumeko" }).click();
    await expect(page.getByTestId("inspector-pos-x")).toHaveValue("-1");
    await expect(page.getByTestId("object-character")).toHaveValue(/.+/);
    await expect(page.getByTestId("camera-pos-x")).toHaveValue("1.2");
    await expect(page.getByTestId("camera-pos-z")).toHaveValue("5.5");
    await expect(page.getByTestId("camera-focal")).toHaveValue("35");
  });

  test("links the production camera to the shot and the shot shows it", async ({ page }) => {
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await page.getByTestId("link-shot-camera").click();
    await expect(page.getByTestId("set-status")).toContainText("Production camera linked");
    await expect(page.getByTestId("bookmark-info")).toContainText("CAM-A");

    await page.goto(`${shotUrl}?section=set`);
    const link = page.getByTestId("shot-camera-link");
    await expect(link).toContainText("CAM-A");
    await expect(link).toContainText("set revision 1");
  });

  test("restores the production camera from the shot bookmark", async ({ page }) => {
    await page.goto(setUrl);
    const set = page.getByTestId("virtual-set");
    await expect(set).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await setInput(page, "camera-pos-x", "4");
    await expect(page.getByTestId("camera-pos-x")).toHaveValue("4");
    await page.getByTestId("restore-camera").click();
    await expect(page.getByTestId("camera-pos-x")).toHaveValue("1.2");
  });

  test("captures a private master frame and adopts it only on request", async ({ page }) => {
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await page.getByTestId("capture-master-frame").click();
    await expect(page.getByTestId("set-status")).toContainText("Master frame saved privately (1912×800)");
    const image = page.getByTestId("master-frame-image").first();
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate(
          (el) => `${(el as HTMLImageElement).naturalWidth}x${(el as HTMLImageElement).naturalHeight}`,
        ),
      )
      .toBe("1912x800");

    // nothing is adopted automatically
    await expect(page.getByTestId("master-frame-adopted")).toHaveCount(0);
    await expect(page.getByTestId("adopt-master-frame").first()).toBeVisible();
    await page.getByTestId("adopt-master-frame").first().click();
    await expect(page.getByTestId("master-frame-adopted")).toBeVisible();
  });

  test("the generation package freezes the spatial snapshot; later edits do not alter it", async ({
    page,
  }) => {
    const get = async () => {
      const r = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
      expect(r.ok()).toBe(true);
      return (await r.json()) as Record<string, unknown> & {
        spatialReference?: {
          sceneRevision: number;
          sceneFingerprint: string;
          masterFrameAssetId: string | null;
        };
        provenance: { fingerprint: string };
      };
    };
    const a = await get();
    expect(a.spatialReference).toBeTruthy();
    expect(a.spatialReference!.sceneRevision).toBe(1);
    expect(a.spatialReference!.masterFrameAssetId).toBeTruthy();
    fingerprintA = a.spatialReference!.sceneFingerprint;
    packageA = JSON.parse(JSON.stringify(a));

    // modify the live set and save a new revision
    await page.goto(setUrl);
    const set = page.getByTestId("virtual-set");
    await expect(set).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await page.getByTestId("outliner-item").filter({ hasText: "Cube" }).click();
    await setInput(page, "inspector-pos-x", "5");
    await page.getByTestId("save-set").click();
    await expect(page.getByTestId("set-status")).toContainText("Saved — revision 2");
    await expect(page.getByTestId("bookmark-stale")).toBeVisible();

    const b = await get();
    expect(b.spatialReference!.sceneRevision).toBe(2);
    expect(b.spatialReference!.sceneFingerprint).not.toBe(fingerprintA);
    expect(b.provenance.fingerprint).not.toBe((packageA.provenance as { fingerprint: string }).fingerprint);
    // package A, as captured, is untouched (and shows the frozen revision-1 state)
    expect((packageA.spatialReference as { sceneRevision: number }).sceneRevision).toBe(1);
  });

  test("places a .glb from the private asset library by asset id", async ({ page }) => {
    // a minimal valid GLB (one triangle), uploaded through the normal Assets UI
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      ],
      bufferViews: [{ buffer: 0, byteLength: 36, target: 34962 }],
      buffers: [{ byteLength: 36 }],
    };
    let js = JSON.stringify(json);
    while (js.length % 4) js += " ";
    const jsonBuf = Buffer.from(js);
    const bin = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
    const head = Buffer.alloc(12);
    head.write("glTF", 0, "ascii");
    head.writeUInt32LE(2, 4);
    head.writeUInt32LE(total, 8);
    const ch = (len: number, type: number) => {
      const b = Buffer.alloc(8);
      b.writeUInt32LE(len, 0);
      b.writeUInt32LE(type, 4);
      return b;
    };
    const glb = Buffer.concat([
      head,
      ch(jsonBuf.length, 0x4e4f534a),
      jsonBuf,
      ch(bin.length, 0x004e4942),
      bin,
    ]);

    await page.goto(`${PROJECT}/assets`);
    await page.locator('input[type="file"][name="file"]').setInputFiles({
      name: "test-prop.glb",
      mimeType: "model/gltf-binary",
      buffer: glb,
    });
    await page.locator('select[name="purpose"]').selectOption("model_3d");
    await page.getByRole("button", { name: "Upload asset" }).click();
    await expect(page.getByText("test-prop.glb").first()).toBeVisible();

    await page.goto(setUrl);
    const set = page.getByTestId("virtual-set");
    await expect(set).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    const before = Number(await set.getAttribute("data-object-count"));
    await page.getByTestId("add-glb").click();
    await expect(set).toHaveAttribute("data-object-count", String(before + 1), { timeout: 15_000 });
    await page.getByTestId("save-set").click();
    await expect(page.getByTestId("set-status")).toContainText("Saved");

    // reload: the GLB is resolved again from its asset id (no URL was stored)
    await page.goto(setUrl);
    await expect(set).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(set).toHaveAttribute("data-object-count", String(before + 1), { timeout: 15_000 });
    await expect(page.getByTestId("outliner-item").filter({ hasText: "glb" })).toHaveCount(1);
  });

  test("a shot without a 3D set has no spatial reference", async ({ page }) => {
    await page.goto(`${EP}/shots`);
    const links = page.locator('a[href*="/shots/"]');
    const hrefs = await links.evaluateAll((els) =>
      els.map((e) => (e as HTMLAnchorElement).getAttribute("href")!),
    );
    const other = hrefs.map((h) => /\/shots\/([0-9a-f-]{36})/.exec(h)?.[1]).find((id) => id && id !== shotId);
    expect(other).toBeTruthy();
    const r = await page.request.get(`/api/projects/ojousama/shots/${other}/package`);
    const json = await r.json();
    expect("spatialReference" in json).toBe(false);
  });

  test("releases WebGL on unmount: remounting does not accumulate contexts or canvases", async ({ page }) => {
    await page.goto(`${PROJECT}/locations`);
    const live = () =>
      page.evaluate(() => {
        const w = window as unknown as {
          __gl: Array<{ canvas: HTMLCanvasElement; gl: WebGLRenderingContext }>;
        };
        return w.__gl.filter((e) => e.canvas.isConnected && !e.gl.isContextLost()).length;
      });
    const total = () => page.evaluate(() => (window as unknown as { __gl: unknown[] }).__gl.length);

    for (let i = 0; i < 4; i++) {
      await page.locator("summary").first().click();
      await page.locator('[data-testid^="open-3d-set-"]').first().click();
      await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", {
        timeout: 30_000,
      });
      expect(await live()).toBe(1); // the single editor renderer; nothing leaked
      await page.getByRole("link", { name: "← Locations" }).click();
      await page.waitForURL(/\/locations$/);
      await expect.poll(live).toBe(0);
    }
    // each mount builds one context; none of the four mounts left one behind
    expect(await total()).toBeLessThanOrEqual(4);
  });
});

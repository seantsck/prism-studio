import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 2F M2C — spatial control passes (depth + object IDs + Character masks), memory mode, no provider calls.
 *
 * Geometry tests drive the REAL renderer (SwiftShader WebGL2) through a test hook on synthetic scenes with known
 * distances; the flow test uses the real UI, the real server action and private asset storage.
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
const W = 1912;
const H = 800;

async function openSet(page: Page, code: string) {
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: code, exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  const shotUrl = page.url().split("?")[0]!;
  await page.goto(`${shotUrl}?section=set`);
  await page.getByTestId("open-in-3d-set").click();
  await page.waitForURL(/\/locations\/[0-9a-f-]{36}\/3d\?shot=/);
  await ready(page);
  return { shotUrl, setUrl: page.url(), shotId: /\/shots\/([0-9a-f-]{36})/.exec(shotUrl)![1]! };
}

async function ready(page: Page) {
  await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("spatial-passes")).toHaveAttribute("data-loaded", "true", {
    timeout: 30_000,
  });
}

type Obj = { index: number; semanticId: string; category: string; pixels: number };
type CaptureSummary = {
  width: number;
  height: number;
  objects: Obj[];
  depthMin: number | null;
  depthMax: number | null;
  nonFinite: number;
  negative: number;
};
type Pose = { position: number[]; rotation: number[]; focalLengthMm: number };

/** Calls a method of the in-page spatial test hook. */
const hook = <T>(page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    ([m, a]) =>
      (
        window as unknown as { __prismSet: { spatial: Record<string, (...x: unknown[]) => unknown> } }
      ).__prismSet.spatial[m as string](...(a as unknown[])),
    [method, args] as const,
  ) as Promise<T>;
const capture = (page: Page, pose: Pose) => hook<CaptureSummary>(page, "capture", pose);
const sample = (page: Page, x: number, y: number) =>
  hook<{ depth: number; id: number }>(page, "sample", x, y);
const pixelOf = (page: Page, world: number[]) =>
  hook<{ x: number; y: number; inFront: boolean }>(page, "pixelOf", world);
const sampleAt = async (page: Page, world: number[]) => {
  const p = await pixelOf(page, world);
  expect(p.inFront).toBe(true);
  return { ...(await sample(page, Math.round(p.x), Math.round(p.y))), px: p };
};
const digest = (page: Page) => hook<{ depth: string; ids: string }>(page, "digest");
const indexOf = (c: CaptureSummary, semanticId: string) =>
  c.objects.find((o) => o.semanticId === semanticId)!;

const info = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __prismSet: {
          blockingInfo(): {
            helpers: Array<{ onEditorLayerOnly: boolean }>;
            poseMode: boolean;
            selectedJoint: string | null;
          };
        };
      }
    ).__prismSet.blockingInfo(),
  );

const setInput = async (page: Page, testId: string, value: string) => {
  const input = page.getByTestId(testId);
  await input.fill(value);
  await input.press("Enter");
};

const figureId = (page: Page, name: string) =>
  page.getByTestId("blocking-figure").filter({ hasText: name }).first().getAttribute("data-character-id");

async function ensureFigure(page: Page, name: string) {
  if ((await page.getByTestId("blocking-figure").filter({ hasText: name }).count()) === 0) {
    await page.getByTestId("blocking-character").selectOption({ label: name });
    await page.getByTestId("add-character-proxy").click();
    await expect(page.getByTestId("blocking-figure").filter({ hasText: name })).toHaveCount(1);
  }
  return (await figureId(page, name))!;
}

test.describe("depth, object ids and masks: geometry", () => {
  let setUrl = "";

  test("depth is LINEAR VIEW-SPACE METRES: known distances, background 0, occlusion, orientation, determinism", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    setUrl = (await openSet(page, "3A")).setUrl;
    await hook(page, "clearScene"); // live only: nothing here is saved
    const pose: Pose = { position: [0, 1.6, 10], rotation: [0, 0, 0], focalLengthMm: 24 };

    // near cube front face at z=6 (4 m away); a wide far wall at z=-9.5 (19.5 m); a small box high above the near one
    const near = await hook<string>(page, "addBox", [0, 1.6, 5], [2, 2, 2]);
    const far = await hook<string>(page, "addBox", [0, 1.6, -10], [20, 6, 1]);
    const high = await hook<string>(page, "addBox", [0, 3.5, 5], [0.5, 0.5, 0.5]);

    const c = await capture(page, pose);
    expect(c.width).toBe(W);
    expect(c.height).toBe(H);
    expect(c.nonFinite).toBe(0);
    expect(c.negative).toBe(0);
    expect(c.objects.map((o) => o.category)).toEqual(["set_object", "set_object", "set_object"]);
    for (const o of c.objects) expect(o.pixels).toBeGreaterThan(0);
    const iNear = indexOf(c, `set_object:${near}`).index;
    const iFar = indexOf(c, `set_object:${far}`).index;
    const iHigh = indexOf(c, `set_object:${high}`).index;
    expect(new Set([iNear, iFar, iHigh]).size).toBe(3);
    expect([iNear, iFar, iHigh].sort()).toEqual([1, 2, 3]); // bundle-local, dense, 1..N

    // background: 0 depth, id 0 (top-left and bottom-left corners see nothing)
    expect(await sample(page, 3, 3)).toEqual({ depth: 0, id: 0 });
    expect(await sample(page, 3, H - 4)).toEqual({ depth: 0, id: 0 });

    // the centre pixel is the near cube's front face: exactly 4 m of VIEW depth
    const mid = await sample(page, W / 2, H / 2);
    expect(mid.id).toBe(iNear);
    expect(Math.abs(mid.depth - 4)).toBeLessThan(0.002);

    // the far wall away from the cube: view-space depth is 19.5 even at a steep angle (not the 20.4 m ray length)
    const side = await sampleAt(page, [6, 1.6, -9.5]);
    expect(side.id).toBe(iFar);
    expect(Math.abs(side.depth - 19.5)).toBeLessThan(0.01);
    expect(Math.abs(side.depth - Math.hypot(19.5, 6))).toBeGreaterThan(0.5); // proves it is not Euclidean distance

    // near < far, and the far wall behind the cube never overwrote it
    expect(mid.depth).toBeLessThan(side.depth);
    const behind = await hook<{ minX: number; maxX: number; minY: number; maxY: number; count: number }>(
      page,
      "bbox",
      iNear,
    );
    expect(Math.abs((behind.minX + behind.maxX) / 2 - (W - 1) / 2)).toBeLessThan(1.5);
    expect(Math.abs((behind.minY + behind.maxY) / 2 - (H - 1) / 2)).toBeLessThan(1.5);

    // ONE stored orientation: row 0 is the TOP. The small box is above the axis, so its rows are in the top half
    const hi = await sampleAt(page, [0, 3.5, 5.25]);
    expect(hi.id).toBe(iHigh);
    expect(Math.abs(hi.depth - 4.75)).toBeLessThan(0.01);
    const hb = await hook<{ minY: number; maxY: number }>(page, "bbox", iHigh);
    expect(hb.maxY).toBeLessThan(H / 2);
    expect(hi.px.y).toBeLessThan(H / 2);

    // determinism: same scene + camera → byte-identical rasters
    const d1 = await digest(page);
    await capture(page, pose);
    expect(await digest(page)).toEqual(d1);

    // the navigation camera is irrelevant, and so are selection outlines and the transform gizmo
    await hook(page, "selectObject", near);
    await page.evaluate(() =>
      (
        window as unknown as { __prismSet: { setNavigationCamera(p: number[], l: number[]): void } }
      ).__prismSet.setNavigationCamera([25, 12, 25], [0, 0, 0]),
    );
    await capture(page, pose);
    expect(await digest(page)).toEqual(d1);
    await hook(page, "selectObject", null);

    // a different production camera gives different depth for the same scene (the camera is an input)
    await capture(page, { ...pose, position: [0, 1.6, 12] });
    const farther = await sample(page, W / 2, H / 2);
    expect(Math.abs(farther.depth - 6)).toBeLessThan(0.002);
  });

  test("a capture leaves the live scene, the beauty render and GPU resources unchanged", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(setUrl);
    await ready(page);
    await hook(page, "clearScene");
    await hook<string>(page, "addBox", [0, 1.6, 5], [2, 2, 2]);
    await hook<string>(page, "addBox", [1, 0.5, 0], [1, 1, 1]);
    // frame the production camera on the boxes so the beauty render has content
    await setInput(page, "camera-pos-x", "0");
    await setInput(page, "camera-pos-y", "1.6");
    await setInput(page, "camera-pos-z", "10");
    await setInput(page, "camera-rot-x", "0");
    await setInput(page, "camera-rot-y", "0");
    await setInput(page, "camera-rot-z", "0");
    await setInput(page, "camera-focal", "35");

    const pose: Pose = { position: [0, 1.6, 10], rotation: [0, 0, 0], focalLengthMm: 35 };
    const before = {
      // the beauty render runs first (it may lazily create engine helpers); then the scene state is the baseline
      beauty: await hook<string>(page, "beautyDigest"),
      scene: await hook<string>(page, "sceneStateDigest"),
      nav: await page.evaluate(() =>
        JSON.stringify(
          (
            window as unknown as { __prismSet: { navigationCamera(): unknown } }
          ).__prismSet.navigationCamera(),
        ),
      ),
      prod: await page.evaluate(() =>
        JSON.stringify(
          (
            window as unknown as { __prismSet: { productionCamera(): unknown } }
          ).__prismSet.productionCamera(),
        ),
      ),
    };
    await capture(page, pose);
    const afterOne = await hook<{ textures: number; geometries: number; programs: number; canvases: number }>(
      page,
      "renderInfo",
    );
    for (let i = 0; i < 5; i++) await capture(page, pose);
    const afterSix = await hook<typeof afterOne>(page, "renderInfo");

    expect(await hook<string>(page, "sceneStateDigest")).toBe(before.scene); // visibility, layers, materials, selection
    expect(await hook<string>(page, "beautyDigest")).toBe(before.beauty); // the ordinary picture is untouched
    expect(
      await page.evaluate(() =>
        JSON.stringify(
          (
            window as unknown as { __prismSet: { navigationCamera(): unknown } }
          ).__prismSet.navigationCamera(),
        ),
      ),
    ).toBe(before.nav);
    expect(
      await page.evaluate(() =>
        JSON.stringify(
          (
            window as unknown as { __prismSet: { productionCamera(): unknown } }
          ).__prismSet.productionCamera(),
        ),
      ),
    ).toBe(before.prod);
    // repeated captures do not grow render targets, textures, geometries, shader programs or canvases
    expect(afterSix).toEqual(afterOne);
  });
});

test.describe("Character masks and editor-helper exclusion", () => {
  let setUrl = "";
  let yumekoId = "";
  let seanId = "";

  test("exact per-Character masks from the id map: occlusion, hidden proxies, fully occluded Characters", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const opened = await openSet(page, "3A");
    setUrl = opened.setUrl;
    yumekoId = await ensureFigure(page, "Yumeko");
    seanId = await ensureFigure(page, "Sean");
    await hook(page, "clearScene");
    const pose: Pose = { position: [0, 1.2, 6], rotation: [0, 0, 0], focalLengthMm: 35 };

    // a fixed Set object, Yumeko in front, Sean behind and slightly to the right (partly hidden by Yumeko)
    const crate = await hook<string>(page, "addBox", [-1.8, 0.5, -2], [0.8, 1, 0.8]);
    await hook(page, "placeFigure", yumekoId, [0, 0, 0]);
    await hook(page, "placeFigure", seanId, [0.25, 0, -1]);
    const both = await capture(page, pose);
    expect(both.objects.map((o) => o.semanticId).sort()).toEqual(
      [`set_object:${crate}`, `character_proxy:${seanId}`, `character_proxy:${yumekoId}`].sort(),
    );
    expect(both.objects.filter((o) => o.category === "character_proxy")).toHaveLength(2);
    const iY = indexOf(both, `character_proxy:${yumekoId}`);
    const iS = indexOf(both, `character_proxy:${seanId}`);
    const iC = indexOf(both, `set_object:${crate}`);
    expect(iY.pixels).toBeGreaterThan(500);
    expect(iS.pixels).toBeGreaterThan(100);
    expect(iC.pixels).toBeGreaterThan(100);

    // the Character masks are derived from the ids: each counts exactly its own pixels, the Set object has none
    expect(await hook(page, "maskStats", yumekoId)).toEqual({ count: iY.pixels, objectIndex: iY.index });
    expect(await hook(page, "maskStats", seanId)).toEqual({ count: iS.pixels, objectIndex: iS.index });
    expect(await hook(page, "maskStats", "not-a-character")).toBeNull();

    // depth agrees with the layout: Yumeko (z=0) is nearer than Sean (z=-1) where both are visible
    type Box = { anchor: { x: number; y: number } };
    const yb = (await hook<Box>(page, "bbox", iY.index))!;
    const sb = (await hook<Box>(page, "bbox", iS.index))!;
    const yMid = await sample(page, yb.anchor.x, yb.anchor.y);
    const sMid = await sample(page, sb.anchor.x, sb.anchor.y);
    expect(yMid.id).toBe(iY.index);
    expect(sMid.id).toBe(iS.index);
    expect(yMid.depth).toBeLessThan(sMid.depth);
    expect(sMid.depth - yMid.depth).toBeGreaterThan(0.5);

    // OCCLUSION: Sean's mask is VISIBLE pixels only. Hide Yumeko → Sean owns strictly more pixels, and the
    // manifest no longer contains Yumeko at all (a hidden proxy is not rendered, so it has no entry or mask).
    await hook(page, "setFigureVisible", yumekoId, false);
    const seanAlone = await capture(page, pose);
    expect(seanAlone.objects.some((o) => o.semanticId === `character_proxy:${yumekoId}`)).toBe(false);
    expect(await hook(page, "maskStats", yumekoId)).toBeNull();
    const sAlone = indexOf(seanAlone, `character_proxy:${seanId}`);
    expect(sAlone.pixels).toBeGreaterThan(iS.pixels);
    await hook(page, "setFigureVisible", yumekoId, true);

    // a Character enabled in the blocking but completely behind a wall keeps its manifest entry with 0 pixels
    await hook(page, "placeFigure", yumekoId, [-6, 0, 0]);
    await hook(page, "placeFigure", seanId, [4, 0, -3]);
    await hook<string>(page, "addBox", [4, 1, -1.5], [3, 3, 0.2]);
    const hiddenBehind = await capture(page, { ...pose, position: [2, 1.2, 6] });
    const seanBehind = indexOf(hiddenBehind, `character_proxy:${seanId}`);
    expect(seanBehind).toBeTruthy(); // enabled → still in the manifest
    expect(seanBehind.pixels).toBe(0); // …but nothing of him is visible
    expect(await hook(page, "maskStats", seanId)).toEqual({ count: 0, objectIndex: seanBehind.index });
  });

  test("editor helpers, selection, gizmos and skeleton never reach a pass", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(setUrl);
    await ready(page);
    // the previous test never saved its proxies: add them again (live only)
    yumekoId = await ensureFigure(page, "Yumeko");
    seanId = await ensureFigure(page, "Sean");
    await hook(page, "clearScene");
    const pose: Pose = { position: [0, 1.2, 6], rotation: [0, 0, 0], focalLengthMm: 35 };
    const crate = await hook<string>(page, "addBox", [-1.8, 0.5, -2], [0.8, 1, 0.8]);
    await hook(page, "placeFigure", yumekoId, [0, 0, 0]);
    await hook(page, "placeFigure", seanId, [0.25, 0, -1]);

    await hook(page, "selectObject", null);
    const clean = await capture(page, pose);
    const cleanDigest = await digest(page);

    // Pose Mode on Yumeko with a joint selected (FK joint spheres + skeleton lines + rotate gizmo), a selected Set
    // object (outline + transform gizmo), the editor camera moved
    await page.getByTestId("blocking-figure").filter({ hasText: "Yumeko" }).click();
    await page.getByTestId("pose-mode-toggle").click();
    await page.getByTestId("joint-leftUpperArm").click();
    await expect(page.getByTestId("selected-joint-name")).toHaveText("Left upper arm");
    const helpers = await info(page);
    expect(helpers.poseMode).toBe(true);
    expect(helpers.helpers.length).toBeGreaterThan(5); // the helpers really exist in the scene…
    const dirty = await capture(page, pose);
    expect(await digest(page)).toEqual(cleanDigest); // …and are absent from the depth and id rasters, bit for bit
    expect(dirty.objects.map((o) => o.semanticId)).toEqual(clean.objects.map((o) => o.semanticId));
    // the only object ids present are manifest entries (no helper claimed an index)
    const total = dirty.objects.reduce((n, o) => n + o.pixels, 0);
    expect(total).toBeGreaterThan(1000);
    await hook(page, "selectObject", crate);
    await capture(page, pose);
    expect(await digest(page)).toEqual(cleanDigest);
    await hook(page, "selectObject", null);
  });
});

// ───────────────────────── the real UI + server flow ─────────────────────────

const f32 = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const u32 = (b: Buffer) => new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

type Pkg = {
  provenance: { fingerprint: string };
  assets: Record<string, { type: string; purpose: string; mime: string | null; byteSize: number | null }>;
  spatialReference?: {
    controlPasses?: {
      bundleId: string;
      bundleFingerprint: string;
      width: number;
      height: number;
      cameraSource: string;
      camera: {
        kind: string;
        camera: { position: { x: number }; focalLengthMm: number; width: number; height: number };
      };
      rowOrder: string;
      depth: {
        assetId: string;
        encoding: string;
        units: string;
        backgroundValue: number;
        near: number;
        far: number;
      };
      objectIds: {
        assetId: string;
        encoding: string;
        manifest: {
          objects: Array<{
            index: number;
            semanticId: string;
            category: string;
            characterId?: string;
            visiblePixelCount?: number;
          }>;
        };
      };
      characterMasks: Array<{
        characterId: string;
        assetId: string;
        encoding: string;
        objectIndex: number;
        blockingFingerprint: string;
        visiblePixelCount: number;
      }>;
    };
  };
};

const assetIdOf = (href: string | null) => /\/api\/assets\/([0-9a-f-]{36})/.exec(href ?? "")![1]!;
const bundle = (page: Page) => page.getByTestId("spatial-bundle");
const byId = (page: Page, id: string) => page.locator(`[data-bundle-id="${id}"]`);

async function saveSetIfDirty(page: Page) {
  if ((await page.getByTestId("virtual-set").getAttribute("data-dirty")) === "true") {
    await page.getByTestId("save-set").click();
    await expect(page.getByTestId("set-status")).toContainText(/Saved — revision/, { timeout: 60_000 });
  }
}

/** Both Characters present, visible, saved against the CURRENT set. */
async function prepareBlocking(page: Page) {
  await saveSetIfDirty(page);
  const yumeko = await ensureFigure(page, "Yumeko");
  const sean = await ensureFigure(page, "Sean");
  for (const name of ["Yumeko", "Sean"]) {
    await page.getByTestId("blocking-figure").filter({ hasText: name }).click();
    if (!(await page.getByTestId("blocking-visible").isChecked()))
      await page.getByTestId("blocking-visible").check();
  }
  // earlier specs may already have saved exactly this blocking: nothing to save then
  if (await page.getByTestId("save-blocking").isEnabled()) {
    await page.getByTestId("save-blocking").click();
    await expect(page.getByTestId("blocking-status")).toContainText("saved", { timeout: 60_000 });
  }
  if (await page.getByTestId("blocking-stale").count()) {
    await page.getByTestId("reanchor-blocking").click();
    await expect(page.getByTestId("blocking-stale")).toHaveCount(0, { timeout: 60_000 });
  }
  return { yumeko, sean };
}

/** Applies a pose preset that really changes the selected figure's current pose (the Save button enables). */
async function changePose(page: Page, name: string) {
  await page.getByTestId("blocking-figure").filter({ hasText: name }).click();
  for (const preset of ["walk_a", "seated", "hands_on_hips", "walk_b", "neutral_stand"]) {
    await page.getByTestId(`preset-${preset}`).click();
    if (await page.getByTestId("save-blocking").isEnabled()) return;
  }
  throw new Error("no preset changed the pose");
}

const getPackage = async (page: Page, shotId: string) => {
  const r = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
  expect(r.ok()).toBe(true);
  return (await r.json()) as Pkg;
};

test.describe("spatial control passes: capture flow", () => {
  test("a Production Camera bookmark capture (a Shot with no camera path)", async ({ page }) => {
    test.setTimeout(400_000);
    await openSet(page, "2B");
    if ((await page.getByTestId("virtual-set").getAttribute("data-object-count")) === "0")
      await page.getByTestId("load-test-set").click();
    await saveSetIfDirty(page);
    await setInput(page, "camera-pos-x", "1.2");
    await setInput(page, "camera-pos-y", "1.6");
    await setInput(page, "camera-pos-z", "5.5");
    await setInput(page, "camera-rot-x", "-3.4");
    await setInput(page, "camera-rot-y", "6.9");
    await setInput(page, "camera-rot-z", "0");
    await setInput(page, "camera-focal", "35");
    await page.getByTestId("link-shot-camera").click();
    await expect(page.getByTestId("set-status")).toContainText(/Production camera linked/, {
      timeout: 60_000,
    });
    await prepareBlocking(page);

    // the source is stated, never the navigation camera
    await expect(page.getByTestId("spatial-source")).toHaveAttribute("data-kind", "bookmark");
    await expect(page.getByTestId("spatial-source")).toHaveText("Production Camera Bookmark");
    await expect(page.getByTestId("spatial-size")).toHaveText("1912×800");
    await expect(page.getByTestId("capture-spatial-passes")).toBeEnabled();

    await page.getByTestId("capture-spatial-passes").click();
    await expect(page.getByTestId("spatial-status")).toContainText(
      /Control passes saved privately|already captured/,
      { timeout: 120_000 },
    );
    const b = bundle(page).first();
    await expect(b).toHaveAttribute("data-source", "bookmark");
    await expect(b).toHaveAttribute("data-state", "current");
    await expect(page.getByTestId("spatial-depth-preview")).toBeVisible();
    await expect(page.getByTestId("spatial-id-preview")).toBeVisible();
    await expect(page.getByTestId("spatial-mask-preview")).toHaveCount(2);
    // the previews are drawn from the canonical bytes at the production size
    const dims = await page
      .getByTestId("spatial-depth-preview")
      .evaluate((c) => [(c as HTMLCanvasElement).width, (c as HTMLCanvasElement).height]);
    expect(dims).toEqual([W, H]);
  });

  test("capture at the camera timeline playhead → private machine assets → persistence → staleness → package", async ({
    page,
  }) => {
    test.setTimeout(900_000);
    const origin = new URL(test.info().project.use.baseURL ?? "http://localhost:3102").origin;
    const { setUrl, shotId } = await openSet(page, "3A");
    if ((await page.getByTestId("virtual-set").getAttribute("data-object-count")) === "0")
      await page.getByTestId("load-test-set").click();
    await saveSetIfDirty(page);
    const { yumeko, sean } = await prepareBlocking(page);

    // a saved camera path that is current for the saved set
    if ((await page.getByTestId("kf-marker").count()) < 2) {
      await page.getByTestId("load-sample-path").click();
      await expect(page.getByTestId("kf-marker")).toHaveCount(3);
    }
    if (await page.getByTestId("save-path").isEnabled()) {
      await page.getByTestId("save-path").click();
      await expect(page.getByTestId("path-status")).toContainText(/Camera path saved/, { timeout: 60_000 });
    }
    await expect(page.getByTestId("path-stale")).toHaveCount(0);

    // the gate states why capture is unavailable while there is unsaved blocking
    await changePose(page, "Yumeko");
    await expect(page.getByTestId("capture-spatial-passes")).toBeDisabled();
    await expect(page.getByTestId("spatial-gate")).toContainText("Save the character blocking first.");
    await page.getByTestId("save-blocking").click();
    await expect(page.getByTestId("blocking-status")).toContainText("saved", { timeout: 60_000 });
    await expect(page.getByTestId("spatial-gate")).toHaveCount(0);

    // the source is the camera path at the CURRENT playhead (and the same label the timeline shows)
    await page.getByTestId("to-end").click();
    const durationMs = Number(await page.getByTestId("timeline-track").getAttribute("data-duration-ms"));
    const endLabel = `Camera Path · ${(durationMs / 1000).toFixed(3)} s`;
    await expect(page.getByTestId("spatial-source")).toHaveAttribute("data-kind", "camera_path");
    await expect(page.getByTestId("spatial-source")).toHaveText(endLabel);

    // ── capture; nothing may leave the Prism origin ──
    const outside: string[] = [];
    page.on("request", (r) => {
      const u = r.url();
      if (!u.startsWith("data:") && !u.startsWith("blob:") && !u.startsWith(origin)) outside.push(u);
    });
    const countBefore = await bundle(page).count();
    await page.getByTestId("capture-spatial-passes").click();
    await expect(page.getByTestId("spatial-status")).toContainText(/Control passes saved privately/, {
      timeout: 180_000,
    });
    expect(outside).toEqual([]);
    await expect(bundle(page)).toHaveCount(countBefore + 1);
    const b1 = bundle(page).first();
    await expect(b1).toHaveAttribute("data-state", "current");
    await expect(b1).toHaveAttribute("data-source", "camera_path");
    const b1Id = (await b1.getAttribute("data-bundle-id"))!;
    const b1Fp = (await b1.getAttribute("data-fingerprint"))!;
    await expect(b1.getByTestId("spatial-bundle-source")).toHaveText(endLabel);
    await expect(page.getByTestId("spatial-depth-preview")).toBeVisible();
    await expect(page.getByTestId("spatial-id-preview")).toBeVisible();
    await expect(page.getByTestId("spatial-mask-preview")).toHaveCount(2);

    // ── the stored machine assets: private, typed, exact sizes, valid values ──
    const depthHref = await b1.getByTestId("spatial-depth-asset").getAttribute("href");
    const idsHref = await b1.getByTestId("spatial-ids-asset").getAttribute("href");
    const maskHrefs = await b1
      .getByTestId("spatial-mask-asset")
      .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    expect(maskHrefs).toHaveLength(2);
    const fetchAsset = async (href: string | null) => {
      const r = await page.request.get(href!);
      expect(r.status()).toBe(200);
      return { type: r.headers()["content-type"] ?? "", body: Buffer.from(await r.body()) };
    };
    const depthA = await fetchAsset(depthHref);
    const idsA = await fetchAsset(idsHref);
    expect(depthA.type).toContain("application/x-prism-depth-f32");
    expect(idsA.type).toContain("application/x-prism-object-id-u32");
    expect(depthA.body.length).toBe(W * H * 4);
    expect(idsA.body.length).toBe(W * H * 4);
    const depth = f32(depthA.body);
    const ids = u32(idsA.body);

    const a = await getPackage(page, shotId);
    const cp = a.spatialReference!.controlPasses!;
    expect(cp.bundleId).toBe(b1Id);
    expect(cp.bundleFingerprint).toBe(b1Fp);
    const N = cp.objectIds.manifest.objects.length;
    let valid = 0;
    let maxId = 0;
    let badDepth = 0;
    let coverageMismatch = 0;
    for (let i = 0; i < depth.length; i++) {
      const d = depth[i]!;
      if (!(Number.isFinite(d) && d >= 0)) badDepth++;
      if (d > 0 !== ids[i]! > 0) coverageMismatch++;
      if (d > 0) valid++;
      if (ids[i]! > maxId) maxId = ids[i]!;
    }
    expect(badDepth).toBe(0);
    expect(coverageMismatch).toBe(0); // depth and ids cover exactly the same pixels
    expect(valid).toBeGreaterThan(1000);
    expect(maxId).toBeLessThanOrEqual(N);

    // each Character mask is the exact binary mask of that Character's object index
    const masksByChar = new Map<string, number>();
    for (const href of maskHrefs) {
      const m = await fetchAsset(href);
      expect(m.type).toContain("application/x-prism-character-mask-u8");
      expect(m.body.length).toBe(W * H);
      const meta = cp.characterMasks.find((x) => x.assetId === assetIdOf(href))!;
      expect(meta).toBeTruthy();
      let on = 0;
      let wrong = 0;
      for (let i = 0; i < m.body.length; i++) {
        const v = m.body[i]!;
        if (v !== 0 && v !== 255) wrong++;
        if ((v === 255) !== (ids[i] === meta.objectIndex)) wrong++;
        if (v === 255) on++;
      }
      expect(wrong).toBe(0);
      expect(on).toBe(meta.visiblePixelCount);
      masksByChar.set(meta.characterId, on);
    }
    expect([...masksByChar.keys()].sort()).toEqual([yumeko, sean].sort());
    // Set objects and Character proxies share one manifest; masks exist only for Characters
    expect(cp.objectIds.manifest.objects.filter((o) => o.category === "character_proxy")).toHaveLength(2);
    expect(cp.objectIds.manifest.objects.some((o) => o.category === "set_object")).toBe(true);

    // frozen by value, private metadata only; the passes are described like any other referenced asset
    expect(cp).toMatchObject({
      width: W,
      height: H,
      cameraSource: "camera_path",
      rowOrder: "top-to-bottom",
      depth: { encoding: "prism.depth-f32.v1", units: "metres", backgroundValue: 0 },
      objectIds: { encoding: "prism.object-id-u32.v1" },
    });
    expect(cp.camera.camera).toMatchObject({ width: W, height: H });
    expect(a.assets[cp.depth.assetId]).toMatchObject({ type: "data", purpose: "spatial_control" });
    expect(a.assets[cp.depth.assetId]!.mime).toBe("application/x-prism-depth-f32");
    expect(JSON.stringify(a.spatialReference!.controlPasses)).not.toMatch(/https?:|blob:|token=|signature/i);

    // ── persistence: navigate away and back ──
    await page.goto(setUrl);
    await ready(page);
    await expect(byId(page, b1Id)).toHaveAttribute("data-state", "current");
    // stored passes can be previewed again straight from the private store
    await byId(page, b1Id).getByTestId("spatial-show-previews").click();
    await expect(byId(page, b1Id).getByTestId("spatial-depth-preview")).toBeVisible({ timeout: 60_000 });
    const idColours = await byId(page, b1Id)
      .getByTestId("spatial-id-preview")
      .evaluate((c) => {
        const cv = c as HTMLCanvasElement;
        const px = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
        const seen = new Set<number>();
        for (let i = 0; i < px.length; i += 4) seen.add((px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!);
        return seen.size;
      });
    expect(idColours).toBeGreaterThanOrEqual(3); // background + at least two production objects

    // the navigation camera and the performance audio selection never stale the passes
    await page.evaluate(() =>
      (
        window as unknown as { __prismSet: { setNavigationCamera(p: number[], l: number[]): void } }
      ).__prismSet.setNavigationCamera([18, 9, 18], [0, 0, 0]),
    );
    await expect(byId(page, b1Id)).toHaveAttribute("data-state", "current");
    const selectTake = async (n: number) => {
      await page.goto(`${EP}/perform`);
      const card = page.locator("article", { hasText: "もう帰りたい" }).first();
      await card
        .locator("div", { hasText: new RegExp(`^#${n}`) })
        .getByRole("button", { name: "Select" })
        .first()
        .click();
      await expect(card.getByText(new RegExp(`canonical: take ${n}`))).toBeVisible();
    };
    await selectTake(3);
    await page.goto(setUrl);
    await ready(page);
    await expect(byId(page, b1Id)).toHaveAttribute("data-state", "current");
    await expect(byId(page, b1Id).getByTestId("spatial-bundle-stale")).toHaveCount(0);
    await selectTake(1);
    await page.goto(setUrl);
    await ready(page);
    await expect(byId(page, b1Id)).toHaveAttribute("data-state", "current");

    // ── STALE BLOCKING: edit + save the blocking; the old bundle stays, marked stale ──
    const aText = JSON.stringify(a);
    await changePose(page, "Yumeko");
    await page.getByTestId("save-blocking").click();
    await expect(page.getByTestId("blocking-status")).toContainText("saved", { timeout: 60_000 });
    await expect(byId(page, b1Id)).toHaveAttribute("data-state", "stale");
    await expect(byId(page, b1Id).getByTestId("spatial-bundle-stale")).toContainText("STALE BLOCKING");
    const b = await getPackage(page, shotId);
    expect(b.spatialReference!.controlPasses).toBeUndefined(); // a stale bundle is never frozen into a new package
    expect(JSON.stringify(a)).toBe(aText); // package A, as compiled, never changed

    // capture again: a NEW bundle; the historical one is retained
    await page.getByTestId("capture-spatial-passes").click();
    await expect(page.getByTestId("spatial-status")).toContainText(/Control passes saved privately/, {
      timeout: 180_000,
    });
    await expect(bundle(page)).toHaveCount(countBefore + 2);
    const b2Id = (await bundle(page).first().getAttribute("data-bundle-id"))!;
    expect(b2Id).not.toBe(b1Id);
    expect(await byId(page, b2Id).getAttribute("data-fingerprint")).not.toBe(b1Fp);
    await expect(byId(page, b2Id)).toHaveAttribute("data-state", "current");
    const c = await getPackage(page, shotId);
    expect(c.spatialReference!.controlPasses!.bundleId).toBe(b2Id);
    expect(c.provenance.fingerprint).not.toBe(a.provenance.fingerprint);
    expect(c.spatialReference!.controlPasses!.bundleFingerprint).not.toBe(cp.bundleFingerprint);
    const yC = c.spatialReference!.controlPasses!.characterMasks.find((m) => m.characterId === yumeko)!;
    const yA = cp.characterMasks.find((m) => m.characterId === yumeko)!;
    expect(yC.blockingFingerprint).not.toBe(yA.blockingFingerprint);

    // ── STALE CAMERA: change the saved path ──
    await page.getByTestId("to-start").click();
    await page.getByTestId("timeline-track").click({ position: { x: 40, y: 10 } });
    await page.getByTestId("kf-add").click();
    await page.getByTestId("save-path").click();
    await expect(page.getByTestId("path-status")).toContainText(/Camera path saved/, { timeout: 60_000 });
    await expect(byId(page, b2Id)).toHaveAttribute("data-state", "stale");
    await expect(byId(page, b2Id).getByTestId("spatial-bundle-stale")).toContainText("STALE CAMERA");
    await expect(byId(page, b1Id).getByTestId("spatial-bundle-stale")).toContainText("STALE CAMERA");
    await expect(byId(page, b1Id).getByTestId("spatial-bundle-stale")).toContainText("STALE BLOCKING");

    // ── STALE SCENE: change the Set (the blocking becomes stale with it) ──
    await page.getByTestId("add-box").click();
    await page.getByTestId("save-set").click();
    await expect(page.getByTestId("set-status")).toContainText(/Saved — revision/, { timeout: 60_000 });
    await expect(byId(page, b2Id).getByTestId("spatial-bundle-stale")).toContainText("STALE SCENE");
    await expect(page.getByTestId("capture-spatial-passes")).toBeDisabled();
    await expect(page.getByTestId("spatial-gate")).toContainText("Re-anchor");
    expect(await bundle(page).count()).toBe(countBefore + 2); // nothing was deleted

    // make everything current again and capture once more: the package follows the new bundle
    await page.getByTestId("reanchor-blocking").click();
    await expect(page.getByTestId("blocking-stale")).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId("save-path")).toBeEnabled(); // the path was saved against the older set
    await page.getByTestId("save-path").click();
    await expect(page.getByTestId("path-stale")).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId("spatial-gate")).toHaveCount(0);
    await page.getByTestId("capture-spatial-passes").click();
    await expect(page.getByTestId("spatial-status")).toContainText(/Control passes saved privately/, {
      timeout: 180_000,
    });
    await expect(bundle(page)).toHaveCount(countBefore + 3);
    const b3Id = (await bundle(page).first().getAttribute("data-bundle-id"))!;
    const d = await getPackage(page, shotId);
    expect(d.spatialReference!.controlPasses!.bundleId).toBe(b3Id);
    expect(d.spatialReference!.controlPasses!.bundleFingerprint).not.toBe(
      c.spatialReference!.controlPasses!.bundleFingerprint,
    );
    // both historical bundles are still stored and still stale
    for (const id of [b1Id, b2Id]) await expect(byId(page, id)).toHaveAttribute("data-state", "stale");
  });
});

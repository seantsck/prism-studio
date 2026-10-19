import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { encodePlyFile, encodeSplatFile, encodeSpzFile, syntheticPlane } from "../src/lib/splat/synthetic";

/**
 * Phase 2F M2D.1 — Gaussian-splat Location environments, memory mode, no provider calls.
 *
 * Everything runs on the REAL renderer (SwiftShader WebGL2), the real UI, the real server actions and private asset
 * storage. Splat data is generated programmatically (documented format primitives); nothing third-party is used.
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

/** Counts every WebGL context the page ever creates (proves one renderer / one context per mounted editor). */
const COUNT_CONTEXTS = () => {
  const w = window as unknown as { __glContexts: number };
  w.__glContexts = 0;
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string,
    ...rest: unknown[]
  ) {
    if (type === "webgl2" || type === "webgl" || type === "experimental-webgl") w.__glContexts++;
    return (original as (...a: unknown[]) => unknown).call(this, type, ...rest) as never;
  } as typeof original;
};

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
  // the saved scene has finished loading (a splat that is still streaming in must not race a test's edits)
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

type Pose = { position: number[]; rotation: number[]; focalLengthMm: number };
type SplatInfo = {
  liveSplats: number;
  sparkRenderers: number;
  splatObjects: Array<{
    id: string;
    visible: boolean;
    locked: boolean;
    position: number[];
    rotation: number[];
    scale: number[];
    hasUrlInUserData: boolean;
  }>;
  stats: Array<{ gaussianCount: number; loadMs: number; estimatedGpuBytes: number; format: string }>;
  failures: Array<{ message: string; kind: string }>;
};

const splatHook = <T>(page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    ([m, a]) =>
      (
        window as unknown as { __prismSet: { splat: Record<string, (...x: unknown[]) => unknown> } }
      ).__prismSet.splat[m as string](...(a as unknown[])),
    [method, args] as const,
  ) as Promise<T>;
const spatialHook = <T>(page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    ([m, a]) =>
      (
        window as unknown as { __prismSet: { spatial: Record<string, (...x: unknown[]) => unknown> } }
      ).__prismSet.spatial[m as string](...(a as unknown[])),
    [method, args] as const,
  ) as Promise<T>;
const info = (page: Page) => splatHook<SplatInfo>(page, "info");
const contexts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __glContexts: number }).__glContexts);
const beauty = (page: Page, pose: Pose, pixels: Array<[number, number]>) =>
  splatHook<Array<[number, number, number]>>(page, "beautyPixels", pose, pixels);
const pixelOf = (page: Page, pose: Pose, world: number[]) =>
  splatHook<{ x: number; y: number }>(page, "pixelOf", pose, world);

const FRONT: Pose = { position: [0, 0, 6], rotation: [0, 0, 0], focalLengthMm: 35 };

/** a small coloured plane: 24×24 = 576 Gaussians, 2 source units wide */
const planeFile = (extra: Parameters<typeof syntheticPlane>[0] = {}) =>
  encodeSplatFile(syntheticPlane({ n: 24, size: 2, ...extra }));

async function importSplat(
  page: Page,
  file: { name: string; buffer: Buffer | Uint8Array },
  opts: { sources?: string[] } = {},
) {
  await page.getByTestId("import-splat-file").setInputFiles({
    name: file.name,
    mimeType: "application/octet-stream",
    buffer: Buffer.from(file.buffer),
  });
  for (const s of opts.sources ?? [])
    await page.locator("label", { hasText: s }).getByTestId("splat-source-image").check();
  await page.getByTestId("import-splat").click();
}

const splatItem = (page: Page) => page.getByTestId("outliner-item").filter({ hasText: "gaussian splat" });

test.describe("gaussian splat Location environment", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(COUNT_CONTEXTS);
  });

  test("import → private asset → renders in the existing renderer → one WebGL context", async ({ page }) => {
    test.setTimeout(300_000);
    await openSet(page, "3A");
    const baseContexts = await contexts(page);
    expect(baseContexts).toBeGreaterThanOrEqual(1);
    await spatialHook(page, "clearScene"); // live only: nothing here is saved

    await importSplat(page, { name: "plane.splat", buffer: planeFile() });
    await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("set-status")).toContainText("added");

    // the splat is one production object served by the SAME renderer: no extra context, one SparkRenderer
    const i = await info(page);
    expect(i.liveSplats).toBe(1);
    expect(i.sparkRenderers).toBe(1);
    expect(i.failures).toEqual([]);
    expect(i.stats[0]).toMatchObject({ gaussianCount: 576, format: "splat" });
    expect(i.splatObjects[0]!.hasUrlInUserData).toBe(false);
    expect(await contexts(page)).toBe(baseContexts);

    // the inspector tells the truth about what it is
    await expect(page.getByTestId("splat-kind")).toHaveText("Gaussian Splat");
    await expect(page.getByTestId("splat-format")).toContainText(".splat");
    await expect(page.getByTestId("splat-gaussians")).toHaveText("576");
    await expect(page.getByTestId("splat-scale-status")).toContainText("unknown units");

    // the master-frame pipeline draws it: centre pixel is the splat colour, a corner is background
    const centre = await pixelOf(page, FRONT, [0, 0, 0]);
    const [c, corner] = await beauty(page, FRONT, [
      [Math.round(centre.x), Math.round(centre.y)],
      [20, 20],
    ]);
    expect(c![0]).toBeGreaterThan(120);
    expect(c![0]).toBeGreaterThan(c![2] + 40);
    expect(corner![0]).toBeLessThan(c![0] - 40);
  });

  // ───────────────────────── shared helpers for the remaining tests ─────────────────────────

  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  type Pt = { x: number; y: number };
  /** the tests below normally inherit the Set's URL from the workflow test; allow running them on their own */
  async function ensureUrls(page: Page) {
    if (setUrl) return;
    const o = await openSet(page, "3A");
    setUrl = o.setUrl;
    shotId = o.shotId;
  }
  const POSE: Pose = { position: [0, 1, 6], rotation: [0, 0, 0], focalLengthMm: 35 };
  /** a 2 × 2 source-unit plane centred at (0, 1, 0), facing +z */
  const raisedPlane = (o: Parameters<typeof syntheticPlane>[0] = {}) =>
    encodeSplatFile(syntheticPlane({ n: 24, size: 2, cy: 1, ...o }));
  const dist = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

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
  async function saveSet(page: Page) {
    await page.getByTestId("save-set").click();
    await expect(page.getByTestId("set-status")).toContainText(/Saved — revision/, { timeout: 60_000 });
  }
  const setNav = (page: Page, position: number[], lookAt: number[]) =>
    page.evaluate(
      ([p, l]) =>
        (
          window as unknown as { __prismSet: { setNavigationCamera(a: number[], b: number[]): void } }
        ).__prismSet.setNavigationCamera(p as number[], l as number[]),
      [position, lookAt] as const,
    );
  const outlinerSplat = (page: Page) => splatItem(page).first();
  const splatId = async (page: Page) => (await info(page)).splatObjects[0]!.id;
  async function ensureFigure(page: Page, name: string) {
    if ((await page.getByTestId("blocking-figure").filter({ hasText: name }).count()) === 0) {
      await page.getByTestId("blocking-character").selectOption({ label: name });
      await page.getByTestId("add-character-proxy").click();
      await expect(page.getByTestId("blocking-figure").filter({ hasText: name })).toHaveCount(1);
    }
    return (await page
      .getByTestId("blocking-figure")
      .filter({ hasText: name })
      .first()
      .getAttribute("data-character-id"))!;
  }
  /** a fresh live set with only the raised plane imported (nothing saved) */
  async function freshSetWithSplat(page: Page, code = "3A", file = raisedPlane()) {
    const opened = await openSet(page, code);
    await spatialHook(page, "clearScene");
    await importSplat(page, { name: "plane.splat", buffer: file });
    await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("set-status")).toContainText("added", { timeout: 60_000 });
    return opened;
  }
  const getPackage = async (page: Page, shotId: string) => {
    const r = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
    expect(r.ok()).toBe(true);
    return r;
  };
  type Pkg = {
    provenance: { fingerprint: string };
    references: { referenceAssetIds: string[] };
    assets: Record<string, { mime: string | null; checksum: string | null }>;
    prompt: { positive: string };
    spatialReference?: {
      sceneFingerprint: string;
      spatialEnvironment?: {
        kind: string;
        sceneObjectId: string;
        reconstructionId: string;
        reconstructionFingerprint: string;
        assetId: string;
        assetChecksum: string | null;
        visible: boolean;
        transform: {
          position: { x: number; y: number; z: number };
          scale: { x: number; y: number; z: number };
        };
        calibration: { units: string; metresPerSourceUnit: number | null; scaleMethod: string };
        sourceReferenceAssetIds: string[];
      };
    };
  };
  const packageOf = async (page: Page, shotId: string) => {
    const text = await (await getPackage(page, shotId)).text();
    return { text, pkg: JSON.parse(text) as Pkg };
  };

  // ───────────────────────── formats and refusals ─────────────────────────

  test("each enabled format imports and renders; unsupported, corrupt and oversized files are refused before any upload", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.headers()["next-action"]) posts.push(r.url());
    });
    await openSet(page, "3A");
    await spatialHook(page, "clearScene");
    const gs = syntheticPlane({ n: 24, size: 2 });

    for (const [name, bytes, fmt, label] of [
      ["plane.spz", encodeSpzFile(gs), "spz", "SPZ"],
      ["plane.ply", encodePlyFile(gs), "ply", "Gaussian PLY"],
    ] as const) {
      await importSplat(page, { name, buffer: bytes });
      await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
      const i = await info(page);
      expect(i.stats.at(-1)).toMatchObject({ gaussianCount: 576, format: fmt });
      await expect(page.getByTestId("splat-format")).toContainText(label);
      await expect(page.getByTestId("splat-gaussians")).toHaveText("576");
      const centre = await pixelOf(page, FRONT, [0, 0, 0]);
      const [c] = await beauty(page, FRONT, [[Math.round(centre.x), Math.round(centre.y)]]);
      expect(c![0], `${fmt}: red channel at the splat centre`).toBeGreaterThan(120);
      expect(c![0], `${fmt}: red dominates blue`).toBeGreaterThan(c![2] + 40);
      await spatialHook(page, "clearScene");
      await expect(splatItem(page)).toHaveCount(0);
      expect((await info(page)).liveSplats).toBe(0); // removing the object freed the runtime object
    }

    // refusals: clear message, nothing added, and NO upload request was made
    const before = posts.length;
    const refuse = async (name: string, buffer: Buffer | Uint8Array, message: RegExp) => {
      await importSplat(page, { name, buffer });
      await expect(page.getByTestId("set-status")).toHaveAttribute("data-tone", "error", { timeout: 30_000 });
      await expect(page.getByTestId("set-status")).toContainText(message);
      await expect(splatItem(page)).toHaveCount(0);
    };
    await refuse("scene.glb", encodeSplatFile(gs), /Unsupported file type/);
    await refuse("broken.splat", encodeSplatFile(gs).subarray(0, 100), /32-byte/);
    await refuse(
      "points.ply",
      Buffer.from(
        "ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n" +
          "\0\0\0\0\0\0\0\0\0\0\0\0",
        "latin1",
      ),
      /not a Gaussian splat/,
    );
    await refuse("renamed.splat", encodePlyFile(gs), /named \.splat/);
    // too large (written to a temp file: Playwright will not take a buffer over 50 MB)
    const dir = mkdtempSync(join(tmpdir(), "prism-splat-"));
    try {
      const huge = join(dir, "huge.splat");
      writeFileSync(huge, Buffer.alloc(50 * 1024 * 1024 + 32));
      await page.getByTestId("import-splat-file").setInputFiles(huge);
      await page.getByTestId("import-splat").click();
      await expect(page.getByTestId("set-status")).toHaveAttribute("data-tone", "error", { timeout: 30_000 });
      await expect(page.getByTestId("set-status")).toContainText(/50 MB/);
      await expect(splatItem(page)).toHaveCount(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(posts.length, "a refused file never reaches the server").toBe(before);
  });

  test("the generic asset library refuses a splat (splats only enter through the reconstruction import)", async ({
    page,
  }) => {
    await page.goto("/projects/ojousama/assets");
    await page.locator("input[type=file]").setInputFiles({
      name: "sneaky.splat",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(encodeSplatFile(syntheticPlane({ n: 4 }))),
    });
    await page.getByRole("button", { name: "Upload asset" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /not allowed|Unsupported|type/i })).toBeVisible({
      timeout: 30_000,
    });
  });

  // ───────────────────────── depth ordering: mesh ↔ splat ↔ Character proxy ─────────────────────────

  test("depth ordering is correct between mesh, splat and Character proxy in the production render", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await freshSetWithSplat(page, "3A", raisedPlane({ rgb: [30, 60, 235] }));
    const g = await pixelOf(page, POSE, [0, 1, 0]);
    const centre: [number, number] = [Math.round(g.x), Math.round(g.y)];
    const [base] = await beauty(page, POSE, [centre]);
    expect(base![2], "the splat is what is drawn at the centre").toBeGreaterThan(base![0] + 40);

    // Character proxy IN FRONT of the splat hides it; BEHIND it, the splat wins
    const characterId = await ensureFigure(page, "Yumeko");
    const torso = await pixelOf(page, POSE, [0, 1.05, 1.5]);
    const tp: [number, number] = [Math.round(torso.x), Math.round(torso.y)];
    await spatialHook(page, "setFigureVisible", characterId, false);
    const [splatOnly] = await beauty(page, POSE, [tp]);
    await spatialHook(page, "placeFigure", characterId, [0, 0, 1.5]);
    const [proxyFront] = await beauty(page, POSE, [tp]);
    expect(dist(proxyFront!, splatOnly!), "proxy in front of the splat wins").toBeGreaterThan(60);
    await spatialHook(page, "placeFigure", characterId, [0, 0, -3]);
    const [proxyBehind] = await beauty(page, POSE, [tp]);
    expect(dist(proxyBehind!, splatOnly!), "proxy behind the splat is hidden by it").toBeLessThan(14);
    await spatialHook(page, "setFigureVisible", characterId, false);

    // mesh IN FRONT of the splat wins; mesh BEHIND it loses
    await spatialHook(page, "addBox", [0, 1, 2], [1.2, 1.2, 1.2]);
    const [meshFront] = await beauty(page, POSE, [centre]);
    expect(dist(meshFront!, base!), "mesh in front of the splat wins").toBeGreaterThan(60);
    const boxItem = page.getByTestId("outliner-item").filter({ hasText: "Cube" });
    await boxItem.click();
    await setInput(page, "inspector-pos-z", "-2");
    const [meshBehind] = await beauty(page, POSE, [centre]);
    expect(dist(meshBehind!, base!), "mesh behind the splat is hidden by it").toBeLessThan(14);
    // moving the mesh back in front restores the mesh (nothing sticky about sort order)
    await setInput(page, "inspector-pos-z", "3");
    const [meshFrontAgain] = await beauty(page, POSE, [centre]);
    expect(dist(meshFrontAgain!, meshFront!)).toBeLessThan(14);
  });

  // ───────────────────────── the Location workflow ─────────────────────────

  let setUrl = "";
  let shotId = "";
  let transformAfterGizmos: { position: number[]; rotation: number[]; scale: number[] } | null = null;
  let savedFingerprint = "";

  test("select as ONE object, move / rotate / scale with the real gizmos, calibrate scale, save, reload", async ({
    page,
  }) => {
    test.setTimeout(400_000);
    const opened = await freshSetWithSplat(page);
    setUrl = opened.setUrl;
    shotId = opened.shotId;
    // view from the side: a Production Camera saved by an earlier run may sit on the straight line to the splat
    await setNav(page, [5, 1.5, 3], [0, 1, 0]);
    const id = await splatId(page);

    // a real click on the viewport selects the splat as one production object (its bounding box, not a Gaussian)
    await splatHook(page, "bboxClientPoint", id); // warm
    await page.evaluate(() =>
      (
        window as unknown as { __prismSet: { spatial: { selectObject(id: null): void } } }
      ).__prismSet.spatial.selectObject(null),
    );
    await expect.poll(() => selectedObjectId(page)).toBeNull();
    // the upper-left of the splat: clear of any Character proxy saved in the Shot by an earlier run
    const at = (await splatHook<Pt | null>(page, "bboxClientPoint", id, [0.12, 0.85, 0.5]))!;
    // (the engine swallows the first click after the navigation camera pose changed: retry like an operator would)
    for (let attempt = 0; attempt < 4 && (await selectedObjectId(page)) !== id; attempt++) {
      await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(400);
    }
    await expect.poll(() => selectedObjectId(page), { timeout: 15_000 }).toBe(id);
    await expect(page.getByTestId("splat-inspector")).toBeVisible();
    await expect(page.getByTestId("splat-kind")).toHaveText("Gaussian Splat"); // not a generic model

    // translate (X axis only)
    await page.getByTestId("mode-move").click();
    const p0 = {
      x: await num(page, "inspector-pos-x"),
      y: await num(page, "inspector-pos-y"),
      z: await num(page, "inspector-pos-z"),
    };
    const origin = (await project(page, id))!;
    const px = (await project(page, id, { x: 1, y: 0, z: 0 }))!;
    const len = Math.hypot(px.x - origin.x, px.y - origin.y);
    const dir = { x: (px.x - origin.x) / len, y: (px.y - origin.y) / len };
    let moved = false;
    for (const d of [27, 23, 31, 19, 35, 40, 15, 45]) {
      const start = { x: origin.x + dir.x * d, y: origin.y + dir.y * d };
      await drag(page, start, { x: start.x + dir.x * 70, y: start.y + dir.y * 70 });
      if (Math.abs((await num(page, "inspector-pos-x")) - p0.x) > 0.05) {
        moved = true;
        break;
      }
      await outlinerSplat(page).click();
    }
    expect(moved, "dragging the X translate arrow moved the splat").toBe(true);
    expect(Math.abs((await num(page, "inspector-pos-y")) - p0.y)).toBeLessThan(0.01);
    expect(Math.abs((await num(page, "inspector-pos-z")) - p0.z)).toBeLessThan(0.01);

    // rotate
    await page.getByTestId("mode-rotate").click();
    const rot = async () => [
      await num(page, "inspector-rot-x"),
      await num(page, "inspector-rot-y"),
      await num(page, "inspector-rot-z"),
    ];
    const r0 = await rot();
    const o2 = (await project(page, id))!;
    const px2 = (await project(page, id, { x: 1, y: 0, z: 0 }))!;
    const l2 = Math.hypot(px2.x - o2.x, px2.y - o2.y);
    const radialX = { x: (px2.x - o2.x) / l2, y: (px2.y - o2.y) / l2 };
    let turned = false;
    // the rings are circles of unknown screen radius around the origin: probe outwards in four directions
    for (const radial of [radialX, { x: -radialX.y, y: radialX.x }]) {
      const tangent = { x: -radial.y, y: radial.x };
      for (let d = 30; d <= 260 && !turned; d += 10) {
        for (const sign of [1, -1]) {
          const start = { x: o2.x + radial.x * d * sign, y: o2.y + radial.y * d * sign };
          await drag(page, start, { x: start.x + tangent.x * 70, y: start.y + tangent.y * 70 });
          const r = await rot();
          if (Math.abs(r[0]! - r0[0]!) + Math.abs(r[1]! - r0[1]!) + Math.abs(r[2]! - r0[2]!) > 1)
            turned = true;
          if (turned) break;
          await outlinerSplat(page).click();
        }
      }
      if (turned) break;
    }
    expect(turned, "dragging a rotate ring turned the splat").toBe(true);

    // scale: ONE uniform factor (never per-Gaussian)
    await page.getByTestId("mode-scale").click();
    const s0 = await num(page, "inspector-scale-x");
    const o3 = (await project(page, id))!;
    let scaled = false;
    for (const off of [
      [4, -4],
      [8, -8],
      [2, -2],
      [0, -6],
      [-5, 5],
      [12, -12],
    ] as const) {
      const start = { x: o3.x + off[0], y: o3.y + off[1] };
      await drag(page, start, { x: start.x + 60, y: start.y - 60 });
      if (Math.abs((await num(page, "inspector-scale-x")) - s0) > 0.02) {
        scaled = true;
        break;
      }
      await outlinerSplat(page).click();
    }
    expect(scaled, "dragging the scale handle changed the splat's scale").toBe(true);
    const sx = await num(page, "inspector-scale-x");
    expect(await num(page, "inspector-scale-y")).toBeCloseTo(sx, 4);
    expect(await num(page, "inspector-scale-z")).toBeCloseTo(sx, 4);

    // explicit calibration: scale is metric only because a human said so
    await expect(page.getByTestId("splat-scale-status")).toContainText("unknown units");
    await page.getByTestId("splat-metres-per-unit").fill("0");
    await page.getByTestId("splat-apply-scale").click();
    await expect(page.getByTestId("splat-scale-error")).toBeVisible();
    await page.getByTestId("splat-metres-per-unit").fill("0.5");
    await page.getByTestId("splat-apply-scale").click();
    await expect(page.getByTestId("splat-scale-status")).toContainText("manual — 1 source unit = 0.5 m");
    expect(await num(page, "inspector-scale-x")).toBeCloseTo(0.5, 4);
    // ground level: the bottom of the (scaled) splat rests on the floor
    await page.getByTestId("splat-ground").click();
    const bounds = await splatHook<{ min: number[]; max: number[] } | null>(page, "worldBounds", id);
    expect(Math.abs(bounds!.min[1]!), "the bottom of the splat rests on the floor").toBeLessThan(0.02);

    const i = await info(page);
    const o = i.splatObjects[0]!;
    transformAfterGizmos = { position: o.position, rotation: o.rotation, scale: o.scale };
    expect(o.scale[0]).toBeCloseTo(0.5, 4);

    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-dirty", "true");
    await saveSet(page);
    savedFingerprint = (await page.getByTestId("virtual-set").getAttribute("data-saved-fingerprint"))!;

    // reload: the exact reconstruction object returns; no Blob/URL was serialised; the Asset binding survived
    await page.goto(setUrl);
    await ready(page);
    await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
    const back = await info(page);
    expect(back.liveSplats).toBe(1);
    expect(back.sparkRenderers).toBe(1);
    expect(back.failures).toEqual([]);
    const b = back.splatObjects[0]!;
    for (const k of ["position", "rotation", "scale"] as const)
      expect(dist(b[k], transformAfterGizmos[k]), `${k} persisted`).toBeLessThan(1e-3);
    expect(b.hasUrlInUserData).toBe(false);
    await outlinerSplat(page).click();
    await expect(page.getByTestId("splat-scale-status")).toContainText("manual — 1 source unit = 0.5 m");
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-dirty", "false");
    expect(await page.getByTestId("virtual-set").getAttribute("data-saved-fingerprint")).toBe(
      savedFingerprint,
    );
  });

  test("repeated navigation never duplicates the splat or grows WebGL contexts; one renderer per mount", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page.goto(setUrl);
    await ready(page);
    await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
    const base = await contexts(page);
    const geometries0 = await spatialHook<{ geometries: number }>(page, "renderInfo");
    for (let k = 1; k <= 3; k++) {
      await page.getByRole("link", { name: "← Locations" }).click();
      await page.waitForURL(/\/locations$/);
      await page.goBack();
      await ready(page);
      await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
      const i = await info(page);
      expect(i.liveSplats, `visit ${k}: one splat root`).toBe(1);
      expect(i.sparkRenderers, `visit ${k}: one SparkRenderer`).toBe(1);
      expect(
        await contexts(page),
        `visit ${k}: a remount costs what one page load costs; the splat adds none`,
      ).toBe(base * (k + 1));
      expect(await page.locator("canvas").count()).toBeLessThanOrEqual(2); // viewport + hidden camera view
    }
    const g1 = await spatialHook<{ geometries: number }>(page, "renderInfo");
    expect(g1.geometries).toBeLessThanOrEqual(geometries0.geometries + 4);
  });

  test("locking the environment stops its gizmo and numeric edits; navigation and unlocking still work", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto(setUrl);
    await ready(page);
    await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
    await setNav(page, [0, 1, 8], [0, 1, 0]);
    const id = await splatId(page);
    await outlinerSplat(page).click();
    await page.getByTestId("mode-move").click();
    await page.getByTestId("splat-lock").click();
    await expect(page.getByTestId("splat-locked")).toHaveText("locked");
    const before = await num(page, "inspector-pos-x");

    const origin = (await project(page, id))!;
    const px = (await project(page, id, { x: 1, y: 0, z: 0 }))!;
    const len = Math.hypot(px.x - origin.x, px.y - origin.y);
    const dir = { x: (px.x - origin.x) / len, y: (px.y - origin.y) / len };
    for (const d of [27, 31, 23, 35]) {
      const start = { x: origin.x + dir.x * d, y: origin.y + dir.y * d };
      await drag(page, start, { x: start.x + dir.x * 70, y: start.y + dir.y * 70 });
    }
    expect(await num(page, "inspector-pos-x"), "a locked splat cannot be moved with the gizmo").toBeCloseTo(
      before,
      4,
    );
    await setInput(page, "inspector-pos-x", String(before + 3));
    expect((await info(page)).splatObjects[0]!.position[0], "…nor by numeric entry").toBeCloseTo(before, 4);
    await expect(page.getByTestId("splat-apply-scale")).toBeDisabled();
    await expect(page.getByTestId("splat-ground")).toBeDisabled();
    // the navigation camera still flies
    await setNav(page, [2, 2, 9], [0, 1, 0]);

    // lock is not part of the Set fingerprint (it is editor state, not production truth)
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-dirty", "false");
    await saveSet(page);
    expect(await page.getByTestId("virtual-set").getAttribute("data-saved-fingerprint")).toBe(
      savedFingerprint,
    );

    await page.goto(setUrl);
    await ready(page);
    await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
    await outlinerSplat(page).click();
    await expect(page.getByTestId("splat-locked")).toHaveText("locked"); // persisted
    await page.getByTestId("splat-lock").click();
    await expect(page.getByTestId("splat-locked")).toHaveText("unlocked");
    await saveSet(page);
  });

  // ───────────────────────── Production Camera, blocking, master frame, previs ─────────────────────────

  test("Production Camera + Yumeko proxy: the master frame and the local previs contain the reconstruction", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(1_200_000);
    const foreign: string[] = [];
    const origin = new URL(baseURL!).origin;
    page.on("request", (r) => {
      const u = r.url();
      if (u.startsWith("data:") || u.startsWith("blob:")) return;
      if (new URL(u).origin !== origin) foreign.push(u);
    });
    await page.goto(setUrl);
    await ready(page);
    await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });

    // put the environment back where the fixture is known (the gizmo tests left it moved, turned and scaled)
    await outlinerSplat(page).click();
    for (const [field, value] of [
      ["pos-x", "0"],
      ["pos-y", "0"],
      ["pos-z", "0"],
      ["rot-x", "0"],
      ["rot-y", "0"],
      ["rot-z", "0"],
      ["scale-x", "1"],
      ["scale-y", "1"],
      ["scale-z", "1"],
    ] as const)
      await setInput(page, `inspector-${field}`, value);
    await expect.poll(async () => (await info(page)).splatObjects[0]!.scale[0]).toBeCloseTo(1, 4);

    // frame the reconstruction from a Production Camera and link it to the Shot
    await setInput(page, "camera-pos-x", "0");
    await setInput(page, "camera-pos-y", "1");
    await setInput(page, "camera-pos-z", "6");
    await setInput(page, "camera-rot-x", "0");
    await setInput(page, "camera-rot-y", "0");
    await setInput(page, "camera-rot-z", "0");
    await setInput(page, "camera-focal", "35");
    await page.getByTestId("link-shot-camera").click();
    await expect(page.getByTestId("set-status")).toContainText(/Production camera linked/, {
      timeout: 60_000,
    });

    // Yumeko's neutral proxy stands in front of the environment, saved as Shot blocking
    const characterId = await ensureFigure(page, "Yumeko");
    await page.getByTestId("blocking-figure").filter({ hasText: "Yumeko" }).click();
    await spatialHook(page, "placeFigure", characterId, [0.6, 0, 2]);
    if (await page.getByTestId("save-blocking").isEnabled()) {
      await page.getByTestId("save-blocking").click();
      await expect(page.getByTestId("blocking-status")).toContainText("saved", { timeout: 60_000 });
    }
    if (await page.getByTestId("blocking-stale").count()) {
      await page.getByTestId("reanchor-blocking").click();
      await expect(page.getByTestId("blocking-stale")).toHaveCount(0, { timeout: 60_000 });
    }

    // master frame through the production camera
    const frames = page.getByTestId("master-frame-image");
    const n = await frames.count();
    await page.getByTestId("capture-master-frame").click();
    await expect(frames).toHaveCount(n + 1, { timeout: 90_000 });
    const src = (await frames.first().getAttribute("src"))!;

    // read the STORED frame: reconstruction at the plane, the proxy where it stands, background elsewhere
    const plane = await pixelOf(page, POSE, [-0.7, 1.7, 0]);
    const proxy = await pixelOf(page, POSE, [0.6, 1.05, 2]);
    const planeNoProxy = await pixelOf(page, POSE, [0.6, 1.05, 0]);
    const probe: Array<[number, number]> = [
      [Math.round(plane.x), Math.round(plane.y)],
      [Math.round(proxy.x), Math.round(proxy.y)],
      [Math.round(planeNoProxy.x), Math.round(planeNoProxy.y)],
      [20, 20],
    ];
    const stored = await page.evaluate(
      async ([url, pts]) => {
        const blob = await (await fetch(url as string)).blob();
        const bmp = await createImageBitmap(blob);
        const c = document.createElement("canvas");
        c.width = bmp.width;
        c.height = bmp.height;
        const g = c.getContext("2d", { willReadFrequently: true })!;
        g.drawImage(bmp, 0, 0);
        return {
          w: bmp.width,
          h: bmp.height,
          px: (pts as number[][]).map(([x, y]) => Array.from(g.getImageData(x!, y!, 1, 1).data.slice(0, 3))),
        };
      },
      [src, probe] as const,
    );
    expect([stored.w, stored.h]).toEqual([1912, 800]);
    expect(stored.px[0]![0], "reconstruction is in the stored master frame").toBeGreaterThan(
      stored.px[0]![2]! + 40,
    );
    expect(dist(stored.px[1]!, stored.px[2]!), "the proxy is drawn over the reconstruction").toBeGreaterThan(
      40,
    );
    expect(stored.px[3]![0], "background is not the splat").toBeLessThan(stored.px[0]![0]! - 40);

    // editor helpers are not in the render path
    const bi = await page.evaluate(() =>
      (
        window as unknown as {
          __prismSet: {
            blockingInfo(): { helpers: Array<{ onEditorLayerOnly: boolean }> };
            overlay(): { present: boolean; onEditorLayerOnly: boolean };
          };
        }
      ).__prismSet.blockingInfo(),
    );
    expect(bi.helpers.every((h) => h.onEditorLayerOnly)).toBe(true);

    // local previs: a camera path over the same set; frames come from the isolated previs camera
    if (await page.getByTestId("load-sample-path").count())
      await page.getByTestId("load-sample-path").click();
    if (await page.getByTestId("save-path").isEnabled()) {
      await page.getByTestId("save-path").click();
      await expect(page.getByTestId("path-status")).toContainText(/Camera path saved/, { timeout: 60_000 });
    }
    const previsPx = await splatHook<Array<[number, number, number]>>(
      page,
      "previsPixels",
      POSE,
      { width: 956, height: 400 },
      [
        [478, 200],
        [10, 10],
      ],
    );
    expect(previsPx[0]![0], "the previs frame contains the reconstruction").toBeGreaterThan(
      previsPx[0]![2] + 40,
    );
    expect(previsPx[1]![0]).toBeLessThan(previsPx[0]![0] - 40);
    if (await page.getByTestId("include-audio").isEnabled())
      await page.getByTestId("include-audio").uncheck();
    await page.getByTestId("render-previs").click();
    await expect(page.getByTestId("path-status")).toContainText(/Previs saved privately \(956×400/, {
      timeout: 900_000, // software GL: every splat frame needs a GPU sort read back through SwiftShader
    });
    await expect(page.getByTestId("previs-video")).toBeVisible();
    expect(foreign, "no request leaves the origin").toEqual([]);
  });

  // ───────────────────────── M2C interop ─────────────────────────

  test("Capture Control Passes is blocked while a splat is visible and available again once it is hidden", async ({
    page,
  }) => {
    test.setTimeout(500_000);
    await page.goto(setUrl);
    await ready(page);
    await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
    const BLOCKED =
      /Spatial control passes for Gaussian splat environments are not supported yet\. Hide the splat or use mesh geometry to capture exact depth and object masks\./;

    await expect(page.getByTestId("capture-spatial-passes")).toBeDisabled();
    await expect(page.getByTestId("spatial-gate")).toContainText(BLOCKED);

    // hide it, save, and bring the Shot's anchors up to date (a Set change stales them, as designed)
    const refreshAnchors = async () => {
      if (await page.getByTestId("blocking-stale").count()) {
        await page.getByTestId("reanchor-blocking").click();
        await expect(page.getByTestId("blocking-stale")).toHaveCount(0, { timeout: 60_000 });
      }
      await page.getByTestId("link-shot-camera").click();
      await expect(page.getByTestId("set-status")).toContainText(/Production camera linked/, {
        timeout: 60_000,
      });
      if (await page.getByTestId("save-path").isEnabled()) {
        await page.getByTestId("save-path").click();
        await expect(page.getByTestId("path-status")).toContainText(/Camera path saved/, { timeout: 60_000 });
      }
    };
    await outlinerSplat(page).click();
    await page.getByTestId("splat-visibility").click();
    await expect(page.getByTestId("splat-visible")).toHaveText("hidden");
    await saveSet(page);
    await refreshAnchors();
    await expect(page.getByTestId("spatial-gate")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("capture-spatial-passes")).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId("capture-spatial-passes").click();
    await expect(page.getByTestId("spatial-status")).toContainText(
      /Control passes saved privately|already captured/,
      {
        timeout: 180_000,
      },
    );

    // show it again: blocked again; the historical bundle remains
    await outlinerSplat(page).click();
    await page.getByTestId("splat-visibility").click();
    await expect(page.getByTestId("splat-visible")).toHaveText("yes");
    await expect(page.getByTestId("capture-spatial-passes")).toBeDisabled();
    await expect(page.getByTestId("spatial-gate")).toContainText(BLOCKED);
    expect(await page.getByTestId("spatial-bundle").count()).toBeGreaterThanOrEqual(1);
    await saveSet(page);
    await refreshAnchors();
  });

  // ───────────────────────── GenerationPackage ─────────────────────────

  test("the package freezes the reconstruction identity; moving the splat leaves the earlier package untouched", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await ensureUrls(page);
    await page.goto(setUrl);
    await ready(page);
    await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });

    const a = await packageOf(page, shotId);
    const env = a.pkg.spatialReference!.spatialEnvironment!;
    expect(env).toMatchObject({
      kind: "gaussian_splat",
      visible: true,
      calibration: { units: "metres", metresPerSourceUnit: 0.5, scaleMethod: "manual" },
      sourceReferenceAssetIds: [],
    });
    expect(env.reconstructionFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(env.assetChecksum).toBeTruthy();
    expect(a.pkg.assets[env.assetId]).toMatchObject({
      mime: "application/x-gaussian-splat",
      checksum: env.assetChecksum,
    });
    expect(JSON.stringify(a.pkg.spatialReference)).not.toMatch(/https?:|blob:|token=|signature/i);
    // provider prompts carry no splat vocabulary
    expect(a.pkg.prompt.positive).not.toMatch(/splat|gaussian|reconstruction/i);

    // move the splat and save the Set
    await outlinerSplat(page).click();
    await setInput(page, "inspector-pos-x", String(env.transform.position.x + 2));
    await saveSet(page);
    const b = await packageOf(page, shotId);
    const envB = b.pkg.spatialReference!.spatialEnvironment!;
    expect(a.text, "package A, as compiled, is a value").toBe(a.text);
    expect(b.pkg.provenance.fingerprint).not.toBe(a.pkg.provenance.fingerprint);
    expect(b.pkg.spatialReference!.sceneFingerprint).not.toBe(a.pkg.spatialReference!.sceneFingerprint);
    expect(envB.transform.position.x).toBeCloseTo(env.transform.position.x + 2, 3);
    expect(envB.reconstructionFingerprint, "origin truth is unchanged by placement").toBe(
      env.reconstructionFingerprint,
    );
    expect(JSON.stringify(b.pkg.spatialReference)).not.toMatch(/https?:|blob:|token=|signature/i);
  });

  test("reference images linked as sources are provenance, not shot references", async ({ page }) => {
    test.setTimeout(300_000);
    await ensureUrls(page);
    // a Location reference image in the project's library
    await page.goto("/projects/ojousama/assets");
    const imageName = `splat-source-${Date.now()}.png`;
    await page
      .locator("input[type=file]")
      .setInputFiles({ name: imageName, mimeType: "image/png", buffer: PNG });
    await page.locator("select[name=purpose]").first().selectOption("location_ref");
    await page.getByRole("button", { name: "Upload asset" }).click();
    await expect(page.getByText(imageName).first()).toBeVisible({ timeout: 30_000 });

    await page.goto(setUrl);
    await ready(page);
    const before = await packageOf(page, shotId);
    // one environment per Set: replace the current one
    await spatialHook(page, "clearScene");
    await expect(splatItem(page)).toHaveCount(0);
    await importSplat(
      page,
      { name: "canopy-b.splat", buffer: raisedPlane({ rgb: [40, 90, 220] }) },
      { sources: [imageName] },
    );
    await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("splat-provenance")).toContainText("1 source image");
    await saveSet(page);
    const after = await packageOf(page, shotId);
    const env = after.pkg.spatialReference!.spatialEnvironment!;
    expect(env.sourceReferenceAssetIds).toHaveLength(1);
    expect(env.reconstructionId).not.toBe(before.pkg.spatialReference!.spatialEnvironment!.reconstructionId);
    expect(after.pkg.references.referenceAssetIds).not.toContain(env.sourceReferenceAssetIds[0]);
    expect(after.pkg.references).toEqual(before.pkg.references);
    // the source image can no longer be deleted from under its reconstruction
    await page.goto("/projects/ojousama/assets");
    await page.getByLabel("Search assets").fill(imageName);
    await page.getByRole("button", { name: "Search" }).click();
    await page.locator("tbody tr", { hasText: imageName }).getByRole("link").first().click();
    page.once("dialog", (d) => void d.accept());
    await page
      .getByRole("button", { name: /delete/i })
      .first()
      .click();
    await expect(
      page.getByText(/can.t be deleted: it belongs to a spatial reconstruction/i).first(),
    ).toBeVisible({
      timeout: 30_000,
    });
  });

  // ───────────────────────── failure states ─────────────────────────

  test("a splat whose Asset cannot be read or is corrupt is reported, never silently dropped", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await ensureUrls(page);
    // (1) private fetch failure
    await page.route(/\/api\/assets\/[0-9a-f-]{36}$/, (route) =>
      route.fulfill({ status: 404, body: "gone" }),
    );
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(page.getByTestId("splat-failure")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("splat-failure")).toContainText(/could not be (fetched|loaded)/);
    await expect(page.getByTestId("save-set")).toBeDisabled(); // saving would silently drop it
    await expect(splatItem(page)).toHaveCount(0);
    await page.unroute(/\/api\/assets\/[0-9a-f-]{36}$/);

    // (2) corrupt bytes
    await page.route(/\/api\/assets\/[0-9a-f-]{36}$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/x-gaussian-splat",
        body: Buffer.from("not a splat at all"),
      }),
    );
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(page.getByTestId("splat-failure")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("splat-failure")).toContainText(/32-byte|corrupt|valid/i);
    await expect(page.getByTestId("save-set")).toBeDisabled();
    await page.unroute(/\/api\/assets\/[0-9a-f-]{36}$/);

    // reload with a healthy network: the SAVED set was never corrupted by the failed loads
    await page.goto(setUrl);
    await ready(page);
    await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("splat-failure")).toHaveCount(0);
    await expect(page.getByTestId("save-set")).toBeEnabled();
  });

  // ───────────────────────── resource cleanup and runtime facts ─────────────────────────

  test("add / remove cycles free the runtime (no growth), and runtime facts are reported", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await openSet(page, "3A");
    await spatialHook(page, "clearScene");
    const counts: number[] = [];
    for (let k = 0; k < 8; k++) {
      await importSplat(page, { name: `cycle-${k}.splat`, buffer: raisedPlane() });
      await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await spatialHook(page, "clearScene");
      await expect(splatItem(page)).toHaveCount(0);
      const i = await info(page);
      expect(i.liveSplats, `cycle ${k}: the runtime object was disposed`).toBe(0);
      // GPU frees happen on the next render: let two frames pass before counting
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      counts.push((await spatialHook<{ textures: number }>(page, "renderInfo")).textures);
    }
    // Spark keeps a pool of up to 5 splat accumulators (MAX_ACCUMULATORS) and fills it lazily as GPU work completes,
    // so the texture count can step up a few times and then stop. The invariant is the pool ceiling, not flatness: a
    // leak would climb by about one per cycle (a 30-cycle probe stayed at 4 for 23 cycles and ended at 6).
    expect(counts.at(-1)! - counts[0]!, `bounded by Spark's pool: ${counts}`).toBeLessThanOrEqual(5);
    expect(counts.at(-1)! - counts[0]!, `not a per-cycle climb: ${counts}`).toBeLessThan(counts.length - 1);

    // load time, GPU estimate, Gaussian count and viewport FPS for the fixture
    await importSplat(page, { name: "perf.splat", buffer: raisedPlane() });
    await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
    const i = await info(page);
    const fps = await splatHook<number>(page, "fps", 2000);
    const facts = {
      gaussians: i.stats.at(-1)!.gaussianCount,
      loadMs: i.stats.at(-1)!.loadMs,
      estGpuBytes: i.stats.at(-1)!.estimatedGpuBytes,
      fps: Math.round(fps * 10) / 10,
    };
    console.log(`SPLAT RUNTIME FACTS ${JSON.stringify(facts)}`);
    test.info().annotations.push({ type: "splat-runtime", description: JSON.stringify(facts) });
    expect(facts.gaussians).toBe(576);
    expect(facts.fps).toBeGreaterThan(0);
  });
});

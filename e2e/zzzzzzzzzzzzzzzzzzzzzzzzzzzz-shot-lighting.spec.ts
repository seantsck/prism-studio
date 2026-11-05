import { expect, test, type Page } from "@playwright/test";
import { encodeSplatFile, syntheticPlane } from "../src/lib/splat/synthetic";

/**
 * Phase 4B — Shot Lighting Rigs, memory mode, no provider calls.
 *
 * Runs on the REAL renderer (SwiftShader WebGL2), the real UI, the real server actions and private asset storage. Pixel
 * assertions compare whole-frame means with margins, so they prove a meaningful difference without a golden image.
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
type Pose = { position: number[]; rotation: number[]; focalLengthMm: number };
const POSE: Pose = { position: [0, 1.6, 6], rotation: [0, 0, 0], focalLengthMm: 35 };

const rigOf = (mode: string, lights: unknown[] = []) => ({
  schema: "prism.shot-lighting.v1",
  base: { mode },
  lights,
});
const pointLight = (color: string, intensity: number) => ({
  id: "key",
  type: "point",
  role: "key",
  label: "",
  enabled: true,
  color,
  intensity,
  position: { x: 0, y: 3, z: 4 },
  range: 0,
});

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

/** Phase 4C-I2: the Location page's Shot selector NAVIGATES; wait for the editor remounted for that Shot. */
async function switchShot(page: Page, value: string) {
  await page.getByTestId("shot-select").selectOption(value);
  await expect(page).toHaveURL(new RegExp(`[?&]shot=${value}`), { timeout: 60_000 });
  await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-shot-id", value, { timeout: 60_000 });
  await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
}

/** the selector option value of a Shot label (e.g. "Ep 1 · Shot 2B") */
const optionValue = async (page: Page, label: string) =>
  (await page
    .getByTestId("shot-select")
    .locator("option", { hasText: label })
    .first()
    .getAttribute("value"))!;

async function ready(page: Page) {
  await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("shot-lighting")).toHaveAttribute("data-loaded", "true", { timeout: 30_000 });
}

const hook = <T>(page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    ([m, a]) =>
      (window as unknown as { __prismSet: Record<string, (...x: unknown[]) => unknown> }).__prismSet[
        m as string
      ](...(a as unknown[])),
    [method, args] as const,
  ) as Promise<T>;
const spatial = <T>(page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    ([m, a]) =>
      (
        window as unknown as { __prismSet: { spatial: Record<string, (...x: unknown[]) => unknown> } }
      ).__prismSet.spatial[m as string](...(a as unknown[])),
    [method, args] as const,
  ) as Promise<T>;
const splatPixels = (page: Page, pose: Pose, pixels: Array<[number, number]>) =>
  page.evaluate(
    ([p, px]) =>
      (
        window as unknown as {
          __prismSet: { splat: { beautyPixels: (a: unknown, b: unknown) => Promise<number[][]> } };
        }
      ).__prismSet.splat.beautyPixels(p, px),
    [pose, pixels] as const,
  );

type Info = {
  lights: Array<{ type: string; layer0: boolean }>;
  helpers: Array<{ onEditorLayerOnly: boolean }>;
  baseSuppressed: boolean;
  baseVisible: boolean[];
  applied: string | null;
};
const info = (page: Page) => hook<Info>(page, "lightingInfo");
const mean = (page: Page) => hook<number[]>(page, "beautyMean", POSE);
const sum = (rgb: number[]) => rgb[0]! + rgb[1]! + rgb[2]!;
const near = (a: number[], b: number[], tolerance = 0.75) =>
  a.every((v, i) => Math.abs(v - b[i]!) <= tolerance);

async function saveSet(page: Page) {
  await page.getByTestId("save-set").click();
  await expect(page.getByTestId("set-status")).toContainText("Saved", { timeout: 30_000 });
}

async function freshTestSet(page: Page) {
  await page.getByTestId("load-test-set").click();
  await expect(page.getByTestId("set-status")).toContainText("Hotel Canopy", { timeout: 30_000 });
  await expect
    .poll(async () => (await page.getByTestId("outliner-item").count()) > 0, { timeout: 30_000 })
    .toBe(true);
  await saveSet(page);
}

const pkg = async (page: Page, shotId: string) => {
  const r = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
  expect(r.ok()).toBe(true);
  return (await r.json()) as {
    spatialReference?: {
      sceneFingerprint: string;
      shotLighting?: {
        rigRevision: number;
        lightingFingerprint: string;
        productionFrameLightingFingerprint: string | null;
        rig: { base: { mode: string }; lights: Array<{ id: string; intensity: number }> };
      };
    };
  };
};

const savedFp = (page: Page) => page.getByTestId("shot-lighting").getAttribute("data-saved-fingerprint");

let shotA: { shotUrl: string; setUrl: string; shotId: string };

test.describe("renderer truth", () => {
  test("lighting changes real pixels, makes a dark scene possible, and restores the base exactly", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    shotA = await openSet(page, "2A");
    await freshTestSet(page);

    const base = await mean(page);
    const baseInfo = await info(page);
    expect(baseInfo.applied).toBeNull();
    expect(baseInfo.baseSuppressed).toBe(false);

    // replace with no lights: the engine's base illumination is gone, so the set genuinely goes dark
    await hook(page, "setLighting", rigOf("replace"));
    const dark = await mean(page);
    expect(sum(dark)).toBeLessThan(sum(base) * 0.75);
    expect((await info(page)).baseVisible.every((v) => v === false)).toBe(true);

    // a strong red key on a dark set moves red, and only red, by a wide margin
    await hook(page, "setLighting", rigOf("replace", [pointLight("#ff0000", 200)]));
    const red = await mean(page);
    expect(red[0]! - dark[0]!).toBeGreaterThan(3);
    expect(Math.abs(red[1]! - dark[1]!)).toBeLessThan(red[0]! - dark[0]!);
    const redInfo = await info(page);
    expect(redInfo.lights).toEqual([{ type: "PointLight", layer0: true }]);
    expect(redInfo.helpers.length).toBeGreaterThan(0);
    expect(redInfo.helpers.every((h) => h.onEditorLayerOnly)).toBe(true);

    // engine_default keeps the base and adds on top
    await hook(page, "setLighting", rigOf("engine_default", [pointLight("#ff0000", 200)]));
    expect((await info(page)).baseSuppressed).toBe(false);
    const added = await mean(page);
    expect(added[0]!).toBeGreaterThan(base[0]! - 0.5);

    // clearing restores today's picture
    await hook(page, "setLighting", null);
    expect(near(await mean(page), base)).toBe(true);
    expect((await info(page)).baseVisible).toEqual(baseInfo.baseVisible);
  });

  test("control-pass rasters are byte-identical under materially different lighting", async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto(shotA.setUrl);
    await ready(page);
    // a visible Character in frame, so the Character-mask bytes are compared too (live only: nothing is saved)
    if ((await page.getByTestId("blocking-figure").filter({ hasText: "Yumeko" }).count()) === 0) {
      await page.getByTestId("blocking-character").selectOption({ label: "Yumeko" });
      await page.getByTestId("add-character-proxy").click();
    }
    const yumeko = page.getByTestId("blocking-figure").filter({ hasText: "Yumeko" }).first();
    await expect(yumeko).toHaveCount(1);
    const yumekoId = (await yumeko.getAttribute("data-character-id"))!;
    await spatial(page, "placeFigure", yumekoId, [0, 0, 0]);
    const capture = async () => {
      await spatial(page, "capture", POSE);
      return spatial<{ depth: string; ids: string; masks: Record<string, string> }>(page, "digest");
    };
    const plain = await capture();
    expect(Object.keys(plain.masks)).toEqual([yumekoId]);
    expect((await spatial<{ count: number } | null>(page, "maskStats", yumekoId))!.count).toBeGreaterThan(
      100,
    );
    await hook(page, "setLighting", rigOf("replace", [pointLight("#ff0000", 400)]));
    const lit = await capture();
    await hook(page, "setLighting", rigOf("replace"));
    const dark = await capture();
    await hook(page, "setLighting", null);
    expect(lit).toEqual(plain);
    expect(dark).toEqual(plain);
  });

  test("Shot lighting never reaches the scene document or its fingerprint", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(shotA.setUrl);
    await ready(page);
    const set = page.getByTestId("virtual-set");
    const saved = await set.getAttribute("data-saved-fingerprint");
    await expect(set).toHaveAttribute("data-live-fingerprint", saved!, { timeout: 10_000 });
    const before = await hook<Record<string, unknown>>(page, "sceneJson");

    await hook(page, "setLighting", rigOf("replace", [pointLight("#00ff00", 80)]));
    const after = await hook<Record<string, unknown>>(page, "sceneJson");
    expect(after).toEqual(before);
    const text = JSON.stringify(after);
    expect(text).not.toContain("PRISM_SHOT_LIGHTING");
    expect((await info(page)).baseSuppressed).toBe(true);

    // a real save, with Shot lighting applied, stores the same fingerprint and bakes nothing into the Set
    await page.getByTestId("add-box").click();
    await expect(set).toHaveAttribute("data-dirty", "true", { timeout: 10_000 });
    await saveSet(page);
    const reloadedScene = await hook<{ scene: Array<{ visible?: boolean; media_file_token?: string }> }>(
      page,
      "sceneJson",
    );
    expect(
      reloadedScene.scene.filter((o) => o.media_file_token === "DirectionalLight").every((o) => o.visible),
    ).toBe(true);
    await hook(page, "setLighting", null);
    await expect(set).toHaveAttribute("data-dirty", "false", { timeout: 10_000 });
  });
});

/** Largest per-channel difference between two `beautyGrid` renders. */
const gridDiff = (a: number[][], b: number[][]) =>
  Math.max(...a.map((cell, i) => Math.max(...cell.map((v, c) => Math.abs(v - b[i]![c]!)))));
const grid = (page: Page) => hook<number[][]>(page, "beautyGrid", POSE);
const setTheme = (page: Page, light: boolean) =>
  page.evaluate((on) => document.documentElement.classList.toggle("theme-light", on), light);
type EngineJson = { scene: Array<Record<string, unknown>>; [k: string]: unknown };

test.describe("base environment truth", () => {
  test("the application UI theme never changes production pixels, the scene or its fingerprint", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto(shotA.setUrl);
    await ready(page);
    const set = page.getByTestId("virtual-set");
    const saved = (await set.getAttribute("data-saved-fingerprint"))!;
    const json = await hook<EngineJson>(page, "sceneJson");
    const states: Array<[string, unknown]> = [
      ["no rig", null],
      ["engine_default + key", rigOf("engine_default", [pointLight("#ff0000", 200)])],
      ["replace + key", rigOf("replace", [pointLight("#ff0000", 200)])],
    ];
    for (const [name, rig] of states) {
      await setTheme(page, false);
      await hook(page, "loadSceneJson", json);
      await hook(page, "setLighting", rig);
      const dark = await grid(page);
      const applied = (await info(page)).applied;
      await setTheme(page, true);
      // a load (re)creates the skybox, which is where the engine used to read the UI theme; the overlay re-attaches
      await hook(page, "loadSceneJson", json);
      expect((await info(page)).applied, `${name}: the Shot rig is re-attached after the load`).toBe(applied);
      const light = await grid(page);
      expect(gridDiff(dark, light), `${name}: UI theme changed the production render`).toBeLessThanOrEqual(2);
    }
    await setTheme(page, false);
    await hook(page, "setLighting", null);
    await hook(page, "loadSceneJson", json);
    expect(await hook<EngineJson>(page, "sceneJson")).toEqual(json);
    await expect(set).toHaveAttribute("data-saved-fingerprint", saved);
    await expect(set).toHaveAttribute("data-live-fingerprint", saved, { timeout: 10_000 });
  });

  test("saved base-light state cannot change pixels behind identical render-lighting provenance", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto(shotA.setUrl);
    await ready(page);
    const json = await hook<EngineJson>(page, "sceneJson");
    const isBase = (o: Record<string, unknown>) => o.media_file_token === "DirectionalLight";
    expect(json.scene.filter(isBase)).toHaveLength(1);
    // every variant keeps the skybox and the engine, so `baseEnvironment` is identical for all of them
    const variants: Array<[string, EngineJson]> = [
      ["hidden", { ...json, scene: json.scene.map((o) => (isBase(o) ? { ...o, visible: false } : o)) }],
      [
        "moved",
        {
          ...json,
          scene: json.scene.map((o) => (isBase(o) ? { ...o, position: { x: -8, y: 1, z: -6 } } : o)),
        },
      ],
      ["omitted", { ...json, scene: json.scene.filter((o) => !isBase(o)) }],
    ];
    await hook(page, "loadSceneJson", json);
    const reference = await grid(page);
    const referenceBase = (await info(page)).baseVisible;
    for (const [name, variant] of variants) {
      await hook(page, "loadSceneJson", variant);
      expect(gridDiff(reference, await grid(page)), `${name}: base light changed pixels`).toBeLessThanOrEqual(
        2,
      );
      expect((await info(page)).baseVisible, `${name}: base rig state`).toEqual(referenceBase);
      // replace still suppresses the whole base and gives back exactly this state
      await hook(page, "setLighting", rigOf("replace"));
      expect((await info(page)).baseVisible.every((v) => v === false)).toBe(true);
      await hook(page, "setLighting", null);
      expect((await info(page)).baseVisible, `${name}: restored after replace`).toEqual(referenceBase);
    }
    await hook(page, "loadSceneJson", json);
    expect(gridDiff(reference, await grid(page))).toBeLessThanOrEqual(2);
  });
});

test.describe("the Shot Lighting story", () => {
  test("rig → provenance → stale → previs → isolation → package → exact Production Frame source", async ({
    page,
  }) => {
    test.setTimeout(420_000);
    await page.goto(shotA.setUrl);
    await ready(page);
    const panel = page.getByTestId("shot-lighting");
    await expect(panel).toContainText("Shadows are not simulated in Shot Lighting v1.");
    await expect(page.getByTestId("light-castShadow")).toHaveCount(0);

    await page.getByTestId("link-shot-camera").click();
    await expect(page.getByTestId("set-status")).toContainText("linked", { timeout: 30_000 });
    const sceneBefore = await page.getByTestId("virtual-set").getAttribute("data-saved-fingerprint");

    // create and save `replace` + one visible light
    await page.getByTestId("lighting-base-mode").selectOption("replace");
    await page.getByTestId("lighting-add-type").selectOption("point");
    await page.getByTestId("lighting-add").click();
    await page.getByTestId("light-intensity").fill("120");
    await expect(panel).toHaveAttribute("data-dirty", "true");

    // unsaved lighting is never captured as if it were the Shot's
    const framesAtStart = await page.getByTestId("master-frame").count();
    await page.getByTestId("capture-master-frame").click();
    await expect(page.getByTestId("set-status")).toContainText("Save or discard the Shot lighting", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("master-frame")).toHaveCount(framesAtStart);

    await page.getByTestId("lighting-save").click();
    await expect(page.getByTestId("lighting-status")).toContainText("revision 1", { timeout: 30_000 });
    await expect(panel).toHaveAttribute("data-dirty", "false");
    const fp1 = (await savedFp(page))!;
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
    expect((await info(page)).applied).toBe(fp1);
    // the overlay did not touch the Set
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-saved-fingerprint", sceneBefore!);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-dirty", "false");

    // capture: this is the frame the Production Frame will later come from
    await page.getByTestId("capture-master-frame").click();
    await expect(page.getByTestId("set-status")).toContainText("Master frame saved", { timeout: 60_000 });
    await expect(page.getByTestId("master-frame")).toHaveCount(framesAtStart + 1, { timeout: 30_000 });
    await expect(page.getByTestId("master-frame-stale-lighting")).toHaveCount(0);

    // relabelling is not a lighting change: the frame stays fresh, the rig's fingerprint is unchanged
    await page.getByTestId("light-label").fill("Hero key");
    await expect(panel).toHaveAttribute("data-dirty", "true");
    await page.getByTestId("lighting-save").click();
    await expect(page.getByTestId("lighting-status")).toContainText("revision 2", { timeout: 30_000 });
    expect(await savedFp(page)).toBe(fp1);
    await expect(page.getByTestId("master-frame-stale-lighting")).toHaveCount(0);

    // a real change: the old frame reports lighting stale, and nothing else about it changes
    await page.getByTestId("light-intensity").fill("240");
    await page.getByTestId("lighting-save").click();
    await expect(page.getByTestId("lighting-status")).toContainText("revision 3", { timeout: 30_000 });
    const fp2 = (await savedFp(page))!;
    expect(fp2).not.toBe(fp1);
    await expect(page.getByTestId("master-frame-stale-lighting")).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId("master-frame-stale-lighting")).toContainText("STALE LIGHTING");

    // previs: recorded with the current rig, then stale once the rig moves
    await page.getByTestId("create-camera-path").click();
    await expect(page.getByTestId("kf-marker")).toHaveCount(1);
    await page.getByTestId("camera-pos-x").fill("1");
    await page.getByTestId("camera-pos-x").press("Enter");
    await page.getByTestId("to-end").click();
    await page.getByTestId("kf-add").click();
    await expect(page.getByTestId("kf-marker")).toHaveCount(2);
    await page.getByTestId("save-path").click();
    await expect(page.getByTestId("path-status")).toContainText("Camera path saved", { timeout: 30_000 });
    if (await page.getByTestId("include-audio").isEnabled())
      await page.getByTestId("include-audio").uncheck();
    await page.getByTestId("render-previs").click();
    await expect(page.getByTestId("path-status")).toContainText(/Previs saved privately/, {
      timeout: 240_000,
    });
    await expect(page.getByTestId("previs-current")).toBeVisible();

    const withPrevis = await pkg(page, shotA.shotId);
    expect(withPrevis.spatialReference!.shotLighting!.lightingFingerprint).toBe(fp2);

    // Shot A -> Shot B: no leakage, the base comes back
    const a = await info(page);
    expect(a.baseSuppressed).toBe(true);
    // authoring the path moved the production camera, which legitimately saved the Set: this is the baseline now
    const sceneAtSwitch = await page.getByTestId("virtual-set").getAttribute("data-saved-fingerprint");
    await switchShot(page, await optionValue(page, "Ep 1 · Shot 2B"));
    await expect(panel).toHaveAttribute("data-loaded", "true", { timeout: 30_000 });
    await expect(panel).toHaveAttribute("data-saved-fingerprint", "");
    await expect.poll(async () => (await info(page)).applied).toBeNull();
    const b = await info(page);
    expect(b.baseSuppressed).toBe(false);
    expect(b.lights).toEqual([]);
    expect(b.baseVisible.some((v) => v)).toBe(true);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-saved-fingerprint", sceneAtSwitch!);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-dirty", "false");
    const meanB = await mean(page);

    // back to Shot A: its own rig, and the picture actually differs from Shot B's
    await switchShot(page, await optionValue(page, "Ep 1 · Shot 2A"));
    await expect(panel).toHaveAttribute("data-saved-fingerprint", fp2, { timeout: 30_000 });
    await expect.poll(async () => (await info(page)).applied).toBe(fp2);
    expect((await info(page)).baseSuppressed).toBe(true);
    expect(near(await mean(page), meanB)).toBe(false);

    // the old previs goes stale when the rig changes, and the package stops calling it current
    await page.getByTestId("light-intensity").fill("300");
    await page.getByTestId("lighting-save").click();
    await expect(page.getByTestId("lighting-status")).toContainText("revision 4", { timeout: 30_000 });
    const fp3 = (await savedFp(page))!;
    await expect(page.getByTestId("previs-stale")).toContainText("STALE LIGHTING", { timeout: 10_000 });

    // a capture claiming lighting that is not the saved rig is refused, leaving no record
    const frames = await page.getByTestId("master-frame").count();
    await hook(page, "setLighting", rigOf("replace", [pointLight("#0000ff", 5)]));
    await page.getByTestId("capture-master-frame").click();
    await expect(page.getByTestId("set-status")).toContainText("lighting changed", { timeout: 60_000 });
    await expect(page.getByTestId("master-frame")).toHaveCount(frames);
    await page.reload();
    await ready(page);
    await expect.poll(async () => (await info(page)).applied).toBe(fp3);
    await expect(page.getByTestId("master-frame")).toHaveCount(frames);

    // a NEWER Master Frame under the current rig, then promote the OLDER one
    await page.getByTestId("capture-master-frame").click();
    await expect(page.getByTestId("set-status")).toContainText("Master frame saved", { timeout: 60_000 });
    await expect(page.getByTestId("master-frame")).toHaveCount(frames + 1, { timeout: 30_000 });

    await page.goto(`${shotA.shotUrl}?section=production_frame`);
    const useButtons = page.locator('[data-testid^="pf-use-master-"]:not([data-testid*="anyway"])');
    await expect(useButtons).toHaveCount(frames + 1, { timeout: 30_000 });
    // newest first; the last is the first capture, lit by fp1. It is stale now, so Phase 4C asks first.
    await useButtons.last().click();
    const anyway = page.locator('[data-testid^="pf-use-master-anyway-"]');
    await expect(anyway).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("pf-master-confirm-reason").first()).toContainText("STALE");
    await anyway.click();
    await expect(page.getByTestId("pf-master-promoted").first()).toContainText("Production Frame v", {
      timeout: 30_000,
    });

    const full = await pkg(page, shotA.shotId);
    const ref = full.spatialReference!.shotLighting!;
    expect(ref.lightingFingerprint).toBe(fp3);
    expect(ref.rigRevision).toBe(4);
    expect(ref.rig.base.mode).toBe("replace");
    expect(ref.rig.lights[0]!.intensity).toBe(300);
    // the selected frame's own source: not the newest frame (fp3), not the current rig (fp3)
    expect(ref.productionFrameLightingFingerprint).toBe(fp1);
    expect(JSON.stringify(ref)).not.toMatch(/https?:|blob:/);

    // clearing: current truth goes, renders keep what they recorded, the package key goes
    await page.goto(shotA.setUrl);
    await ready(page);
    await page.getByTestId("lighting-clear").click();
    await expect(page.getByTestId("lighting-status")).toContainText("Shot lighting cleared", {
      timeout: 30_000,
    });
    expect((await info(page)).baseSuppressed).toBe(false);
    await expect(page.getByTestId("master-frame-stale-lighting").first()).toBeVisible({ timeout: 10_000 });
    expect((await pkg(page, shotA.shotId)).spatialReference).not.toHaveProperty("shotLighting");
  });

  // the authored-intent review flag is proven at the domain level (lighting.test.ts, review conditions)
  test("the set-changed review flag appears without rewriting the rig, and a re-save re-anchors it", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto(shotA.setUrl);
    await ready(page);
    await page.getByTestId("lighting-add").click();
    await page.getByTestId("lighting-save").click();
    await expect(page.getByTestId("lighting-status")).toContainText("revision 1", { timeout: 30_000 });
    const fp = await savedFp(page);
    await expect(page.getByTestId("lighting-review-set-changed")).toHaveCount(0);

    await page.getByTestId("add-box").click();
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-dirty", "true", { timeout: 10_000 });
    await saveSet(page);
    await expect(page.getByTestId("lighting-review-set-changed")).toBeVisible({ timeout: 10_000 });
    expect(await savedFp(page)).toBe(fp);
    await expect(page.getByTestId("shot-lighting")).toHaveAttribute("data-revision", "1");

    // an explicit re-save re-anchors
    await page.getByTestId("lighting-save").click();
    await expect(page.getByTestId("lighting-status")).toContainText("revision 2", { timeout: 30_000 });
    await expect(page.getByTestId("lighting-review-set-changed")).toHaveCount(0, { timeout: 10_000 });
    expect(await savedFp(page)).toBe(fp);
  });
});

test.describe("splat environments", () => {
  test("OBSERVED: Shot lights do not change a Gaussian splat's pixels, and the UI says so", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openSet(page, "3A");
    await spatial(page, "clearScene");
    await page.getByTestId("import-splat-file").setInputFiles({
      name: "plane.splat",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(encodeSplatFile(syntheticPlane({ n: 24, size: 2, cy: 1 }))),
    });
    await page.getByTestId("import-splat").click();
    await expect(page.getByTestId("set-status")).toContainText("added", { timeout: 60_000 });
    await expect(page.getByTestId("lighting-splat-note")).toContainText("does not respond to these lights");

    const pose: Pose = { position: [0, 1, 6], rotation: [0, 0, 0], focalLengthMm: 35 };
    const centre: [number, number] = [956, 400];
    const [plain] = await splatPixels(page, pose, [centre]);
    await hook(page, "setLighting", rigOf("replace"));
    const [dark] = await splatPixels(page, pose, [centre]);
    await hook(page, "setLighting", rigOf("replace", [pointLight("#ff0000", 400)]));
    const [red] = await splatPixels(page, pose, [centre]);
    await hook(page, "setLighting", null);
    console.log("[splat lighting observed]", JSON.stringify({ plain, dark, red }));
    // the plane really is in the frame (not the flat background), and no lighting state moved it
    expect(sum(plain!)).toBeGreaterThan(0);
    expect(near(dark!, plain!, 3)).toBe(true);
    expect(near(red!, plain!, 3)).toBe(true);
  });
});

test.describe("no-3D regression", () => {
  test("a Shot with no spatial data keeps an image-first package with no spatial or lighting key", async ({
    page,
  }) => {
    await page.goto(`${EP}/shots`);
    await page.getByRole("link", { name: "1A", exact: true }).click();
    await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
    const id = /\/shots\/([0-9a-f-]{36})/.exec(page.url())![1]!;
    const p = await pkg(page, id);
    expect(p).not.toHaveProperty("spatialReference");
    expect(JSON.stringify(p)).not.toContain("shotLighting");
  });
});

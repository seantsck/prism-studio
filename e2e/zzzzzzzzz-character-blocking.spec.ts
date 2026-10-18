import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 2F M2B — shot-specific character blocking with a rigged neutral proxy (memory mode, no provider calls).
 * Real gizmo drags move the proxy and rotate its bones; blocking persists per SHOT; renders show the proxies and
 * no editor helper; the package freezes the blocking by value.
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

async function openSet(page: Page, code: string) {
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: code, exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  const shotUrl = page.url().split("?")[0]!;
  await page.goto(`${shotUrl}?section=set`);
  await page.getByTestId("open-in-3d-set").click();
  await page.waitForURL(/\/locations\/[0-9a-f-]{36}\/3d\?shot=/);
  await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
    timeout: 30_000,
  });
  return { shotUrl, setUrl: page.url(), shotId: /\/shots\/([0-9a-f-]{36})/.exec(shotUrl)![1]! };
}

type Pt = { x: number; y: number };
type Hook = {
  projectFigure(id: string, o?: { x: number; y: number; z: number }): Pt | null;
  projectJoint(id: string, joint: string): Pt | null;
  jointState(id: string, joint: string): { world: number[]; quaternion: number[] } | null;
  blockingInfo(): {
    proxyCount: number;
    poseMode: boolean;
    selectedCharacter: string | null;
    selectedJoint: string | null;
    helpers: Array<{ name: string; onEditorLayerOnly: boolean }>;
    geometries: number;
    sceneProxyNames: string[];
  };
};
const win = (page: Page) => ({
  projectFigure: (id: string, o?: { x: number; y: number; z: number }) =>
    page.evaluate(
      ([i, off]) =>
        (window as unknown as { __prismSet: Hook }).__prismSet.projectFigure(
          i as string,
          (off as { x: number; y: number; z: number } | null) ?? undefined,
        ),
      [id, o ?? null] as const,
    ),
  projectJoint: (id: string, joint: string) =>
    page.evaluate(
      ([i, j]) =>
        (window as unknown as { __prismSet: Hook }).__prismSet.projectJoint(i as string, j as string),
      [id, joint] as const,
    ),
  jointState: (id: string, joint: string) =>
    page.evaluate(
      ([i, j]) => (window as unknown as { __prismSet: Hook }).__prismSet.jointState(i as string, j as string),
      [id, joint] as const,
    ),
  frame: (position: number[], lookAt: number[]) =>
    page.evaluate(
      ([p, l]) =>
        (
          window as unknown as { __prismSet: { setNavigationCamera(p: number[], l: number[]): void } }
        ).__prismSet.setNavigationCamera(p as number[], l as number[]),
      [position, lookAt] as const,
    ),
  info: () => page.evaluate(() => (window as unknown as { __prismSet: Hook }).__prismSet.blockingInfo()),
});
const info = (page: Page) => win(page).info();
const jointState = (page: Page, id: string, joint: string) => win(page).jointState(id, joint);

const num = async (page: Page, testId: string) => Number(await page.getByTestId(testId).inputValue());
const setInput = async (page: Page, testId: string, value: string) => {
  const input = page.getByTestId(testId);
  await input.fill(value);
  await input.press("Enter");
};

async function drag(page: Page, from: Pt, to: Pt) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++)
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await page.mouse.up();
}

const RATE = 48_000;
/** 16-bit mono PCM WAV of a sine tone, generated at runtime (nothing binary is committed). */
function wav(freq: number, ms: number): Buffer {
  const n = Math.round((ms / 1000) * RATE);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++)
    data.writeInt16LE(Math.round(0.6 * 32767 * Math.sin((2 * Math.PI * freq * i) / RATE)), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
/** The seeded takes have no stored file: serve a generated tone to the app's own authenticated fetch(). */
async function serveTakeAudio(page: Page) {
  await page.route(/\/api\/assets\/[0-9a-f-]{36}$/, async (route) => {
    if (route.request().resourceType() !== "fetch") return route.fallback();
    const id = route.request().url().split("/").pop()!;
    const freq = 300 + (createHash("sha1").update(id).digest()[0]! % 5) * 110;
    await route.fulfill({ status: 200, contentType: "audio/wav", body: wav(freq, 6000) });
  });
}

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
        total += Math.abs(p.data[i]! - q.data[i]!) + Math.abs(p.data[i + 1]! - q.data[i + 1]!);
      return total / (p.width * p.height);
    },
    [a, b],
  );

const shotSelectValue = (page: Page) => page.getByTestId("shot-select").inputValue();
const optionByText = async (page: Page, text: string) =>
  (await page
    .getByTestId("shot-select")
    .locator("option")
    .filter({ hasText: text })
    .first()
    .getAttribute("value"))!;

const figureId = (page: Page, name: string) =>
  page.getByTestId("blocking-figure").filter({ hasText: name }).first().getAttribute("data-character-id");

async function addProxy(page: Page, name: string) {
  const select = page.getByTestId("blocking-character");
  await select.selectOption({ label: name });
  await page.getByTestId("add-character-proxy").click();
  await expect(page.getByTestId("blocking-figure").filter({ hasText: name })).toHaveCount(1);
  return (await figureId(page, name))!;
}

test.describe("shot character blocking", () => {
  let setUrl = "";
  let yumekoId = "";
  let rootAfter = { x: 0, y: 0, z: 0 };
  let armQuat: number[] = [];
  let seanId = "";

  test("adds a Yumeko proxy, moves it with the real gizmo, turns the body, poses the arm with the bone gizmo and the head", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const opened = await openSet(page, "3A");
    setUrl = opened.setUrl;
    if ((await page.getByTestId("virtual-set").getAttribute("data-object-count")) === "0")
      await page.getByTestId("load-test-set").click();

    const outlinerBefore = await page.getByTestId("outliner-item").count();
    const dirtyBefore = await page.getByTestId("virtual-set").getAttribute("data-dirty");
    yumekoId = await addProxy(page, "Yumeko");
    // a Shot's proxy is NOT part of the Location's set: not in the outliner, and it does not dirty the set
    expect(await page.getByTestId("outliner-item").count()).toBe(outlinerBefore);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-dirty", dirtyBefore!);
    // the legacy M1 mannequin in the set is untouched
    await expect(page.locator('[data-testid="outliner-item"]', { hasText: "mannequin" })).toHaveCount(1);
    const fig = page.getByTestId("blocking-figure").filter({ hasText: "Yumeko" });
    // identified as the Character's proxy, never a generic mannequin
    await expect(fig).toContainText("Character Proxy");
    await expect(page.getByTestId("blocking-name")).toHaveText("Yumeko · Character Proxy");
    expect((await info(page)).proxyCount).toBe(1);
    await expect(page.getByTestId("blocking-dirty")).toBeVisible();

    // ── root: a real translate-gizmo drag along X ──
    await win(page).frame([3.5, 2.2, 4.5], [0, 1, 0]); // frame the figure with the navigation camera
    await page.getByTestId("mode-move").click();
    const before = await num(page, "blocking-pos-x");
    const origin = (await win(page).projectFigure(yumekoId))!;
    const px = (await win(page).projectFigure(yumekoId, { x: 1, y: 0, z: 0 }))!;
    const len = Math.hypot(px.x - origin.x, px.y - origin.y);
    const dir = { x: (px.x - origin.x) / len, y: (px.y - origin.y) / len };
    let moved = false;
    for (const d of [27, 23, 31, 19, 35, 40, 15, 45]) {
      const start = { x: origin.x + dir.x * d, y: origin.y + dir.y * d };
      await drag(page, start, { x: start.x + dir.x * 70, y: start.y + dir.y * 70 });
      if (Math.abs((await num(page, "blocking-pos-x")) - before) > 0.05) {
        moved = true;
        break;
      }
      await fig.click();
    }
    if (!moved) {
      console.log(
        "DEBUG",
        JSON.stringify({ info: await info(page), origin, px, dir, posx: await num(page, "blocking-pos-x") }),
      );
      await page.screenshot({ path: "C:/Users/Sean/AppData/Local/Temp/blk-fail.png" });
    }
    expect(moved, "dragging the X translate arrow moved the proxy root").toBe(true);
    rootAfter = {
      x: await num(page, "blocking-pos-x"),
      y: await num(page, "blocking-pos-y"),
      z: await num(page, "blocking-pos-z"),
    };
    expect(rootAfter.x).toBeGreaterThan(before + 0.05);
    expect(Math.abs(rootAfter.y)).toBeLessThan(0.01);

    // ── root: turn the whole body (a root edit, not a pose edit) ──
    await setInput(page, "blocking-yaw", "30");
    await expect(page.getByTestId("blocking-yaw")).toHaveValue("30");
    expect(Object.keys((await jointState(page, yumekoId, "hips"))!.quaternion).length).toBe(4);
    expect((await jointState(page, yumekoId, "leftUpperArm"))!.quaternion).toEqual([0, 0, 0, 1]); // pose untouched

    // ── pose mode: select the left upper arm and rotate it with the real bone gizmo ──
    await page.getByTestId("pose-mode-toggle").click();
    await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-pose-mode", "true");
    const pi = await info(page);
    expect(pi.poseMode).toBe(true);
    // every editor helper (joint spheres, skeleton lines) lives on the editor-only layer
    expect(pi.helpers.length).toBeGreaterThan(5);
    expect(pi.helpers.every((h) => h.onEditorLayerOnly)).toBe(true);

    const arm = (await win(page).projectJoint(yumekoId, "leftUpperArm"))!;
    // the engine swallows the first click after the navigation camera moved (it compares the camera pose), so retry
    for (let i = 0; i < 4 && !(await page.getByTestId("selected-joint-name").count()); i++) {
      await page.mouse.click(arm.x, arm.y);
      await page.waitForTimeout(150);
    }
    await expect(page.getByTestId("selected-joint-name")).toHaveText("Left upper arm");
    const q0 = (await jointState(page, yumekoId, "leftUpperArm"))!.quaternion;
    let rotated = false;
    let qBeforeLast = q0;
    for (const r of [34, 28, 40, 46, 22, 52, 58, 64]) {
      for (const ang of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        qBeforeLast = (await jointState(page, yumekoId, "leftUpperArm"))!.quaternion;
        const start = { x: arm.x + Math.cos(ang) * r, y: arm.y + Math.sin(ang) * r };
        const tangent = { x: -Math.sin(ang), y: Math.cos(ang) };
        await drag(page, start, { x: start.x + tangent.x * 60, y: start.y + tangent.y * 60 });
        const q1 = (await jointState(page, yumekoId, "leftUpperArm"))!.quaternion;
        if (q1.some((v, i) => Math.abs(v - q0[i]!) > 0.02)) {
          rotated = true;
          break;
        }
        // a missed drag may have deselected the joint; reselect it
        await page.mouse.click(arm.x, arm.y);
      }
      if (rotated) break;
    }
    expect(rotated, "a drag on the bone rotate gizmo rotated the joint").toBe(true);
    armQuat = (await jointState(page, yumekoId, "leftUpperArm"))!.quaternion;
    // the root did not move: posing is not blocking
    expect(await num(page, "blocking-pos-x")).toBeCloseTo(rootAfter.x, 3);

    // ONE undo/redo: the gizmo rotation undoes and redoes through the editor's own history
    await page.getByTestId("undo").click();
    await expect
      .poll(async () =>
        (await jointState(page, yumekoId, "leftUpperArm"))!.quaternion.every(
          (v, i) => Math.abs(v - qBeforeLast[i]!) < 1e-4,
        ),
      )
      .toBe(true);
    await page.getByTestId("redo").click();
    await expect
      .poll(async () =>
        (await jointState(page, yumekoId, "leftUpperArm"))!.quaternion.every(
          (v, i) => Math.abs(v - armQuat[i]!) < 1e-4,
        ),
      )
      .toBe(true);

    // ── head ──
    await page.getByTestId("joint-head").click();
    await expect(page.getByTestId("selected-joint-name")).toHaveText("Head");
    await setInput(page, "head-yaw", "25");
    await expect(page.getByTestId("head-yaw")).toHaveValue("25");

    // ── save, leave, return ──
    await page.getByTestId("pose-mode-toggle").click();
    await page.getByTestId("save-blocking").click();
    await expect(page.getByTestId("blocking-status")).toContainText(/Character blocking saved/, {
      timeout: 60_000,
    });
    await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-dirty", "false");
  });

  test("blocking persists: root, arm pose and head direction return after navigating away", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.goto(`${EP}/shots`);
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("blocking-figure")).toHaveCount(1);
    expect((await info(page)).proxyCount).toBe(1); // exactly one proxy: no duplicates after navigation
    await page.getByTestId("blocking-figure").click();
    expect(await num(page, "blocking-pos-x")).toBeCloseTo(rootAfter.x, 2);
    expect(await num(page, "blocking-yaw")).toBeCloseTo(30, 1);
    const q = (await jointState(page, yumekoId, "leftUpperArm"))!.quaternion;
    q.forEach((v, i) => expect(v).toBeCloseTo(armQuat[i]!, 4));
    expect(await num(page, "head-yaw")).toBeCloseTo(25, 0);
    await expect(page.getByTestId("blocking-summary")).toContainText("Yumeko: standing at");
    // the set itself is not dirty: the proxy lives in the Shot, not in the Location's scene
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-dirty", "false");
  });

  test("a second character, per-joint undo/redo, a preset and its undo", async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
      timeout: 30_000,
    });
    seanId = await addProxy(page, "Sean");
    await setInput(page, "blocking-pos-x", "3");
    await setInput(page, "blocking-pos-z", "-1.4");
    await setInput(page, "blocking-yaw", "-130");
    await page.getByTestId("preset-hands_on_hips").click();
    const seanPose = (await jointState(page, seanId, "leftLowerArm"))!.quaternion;
    expect(seanPose.slice(0, 3).some((v) => Math.abs(v) > 0.1)).toBe(true);
    // Sean is posed differently from Yumeko
    expect((await jointState(page, yumekoId, "leftLowerArm"))!.quaternion).not.toEqual(seanPose);

    // numeric joint edit is one undoable step
    await page.getByTestId("blocking-figure").filter({ hasText: "Yumeko" }).click();
    await page.getByTestId("pose-mode-toggle").click();
    await page.getByTestId("joint-leftLowerArm").click();
    const e0 = (await jointState(page, yumekoId, "leftLowerArm"))!.quaternion;
    await setInput(page, "joint-rot-x", "-70");
    await expect
      .poll(async () => (await jointState(page, yumekoId, "leftLowerArm"))!.quaternion[0])
      .toBeLessThan(-0.3);
    await page.getByTestId("undo").click();
    await expect
      .poll(async () =>
        (await jointState(page, yumekoId, "leftLowerArm"))!.quaternion.every(
          (v, i) => Math.abs(v - e0[i]!) < 1e-4,
        ),
      )
      .toBe(true);
    await page.getByTestId("redo").click();
    await expect
      .poll(async () => (await jointState(page, yumekoId, "leftLowerArm"))!.quaternion[0])
      .toBeLessThan(-0.3);
    await page.getByTestId("undo").click();

    // Seated preset lowers the hips by the documented offset only; undo puts everything back
    const y0 = await num(page, "blocking-pos-y");
    const x0 = await num(page, "blocking-pos-x");
    const legBefore = (await jointState(page, yumekoId, "leftUpperLeg"))!.quaternion;
    await page.getByTestId("preset-seated").click();
    await expect.poll(async () => (await num(page, "blocking-pos-y")) < y0 - 0.3).toBe(true);
    expect(await num(page, "blocking-pos-x")).toBeCloseTo(x0, 3); // the preset never moves the root sideways
    expect((await jointState(page, yumekoId, "leftUpperLeg"))!.quaternion[0]).toBeLessThan(-0.5);
    await page.getByTestId("undo").click();
    await expect.poll(async () => Math.abs((await num(page, "blocking-pos-y")) - y0) < 1e-3).toBe(true);
    expect((await jointState(page, yumekoId, "leftUpperLeg"))!.quaternion).toEqual(legBefore);

    await page.getByTestId("pose-mode-toggle").click(); // leave pose mode
    expect((await info(page)).helpers).toHaveLength(0); // no joint sphere or skeleton line is left behind
    await page.getByTestId("save-blocking").click();
    await expect(page.getByTestId("blocking-status")).toContainText(
      "Character blocking saved (2 characters)",
      { timeout: 60_000 },
    );
  });

  test("CROSS-SHOT ISOLATION: Yumeko in shot 2A and shot 2B of the same set never share blocking", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const opened = await openSet(page, "2A");
    const urlA = opened.setUrl;
    if ((await page.getByTestId("virtual-set").getAttribute("data-object-count")) === "0")
      await page.getByTestId("load-test-set").click();
    const yId = await addProxy(page, "Yumeko");
    await setInput(page, "blocking-pos-x", "2");
    await page.getByTestId("preset-walk_a").click();
    const walkA = (await jointState(page, yId, "leftUpperLeg"))!.quaternion;
    expect(walkA[0]).toBeLessThan(-0.1);
    await page.getByTestId("save-blocking").click();
    await expect(page.getByTestId("blocking-status")).toContainText("Character blocking saved", {
      timeout: 60_000,
    });

    const valueA = await shotSelectValue(page);
    const valueB = await optionByText(page, "Shot 2B");
    // switch to shot 2B (same Location, same base set): its blocking is independent (absent)
    await page.getByTestId("shot-select").selectOption(valueB);
    await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true");
    await expect(page.getByTestId("blocking-figure")).toHaveCount(0);
    expect((await info(page)).proxyCount).toBe(0);
    const yB = await addProxy(page, "Yumeko");
    expect(yB).toBe(yId); // the SAME Character
    await setInput(page, "blocking-pos-x", "-2");
    await page.getByTestId("preset-seated").click();
    await page.getByTestId("save-blocking").click();
    await expect(page.getByTestId("blocking-status")).toContainText("Character blocking saved", {
      timeout: 60_000,
    });

    // back to 2A: its own blocking is restored, untouched by 2B's edits
    await page.getByTestId("shot-select").selectOption(valueA);
    await expect(page.getByTestId("blocking-figure")).toHaveCount(1);
    await page.getByTestId("blocking-figure").click();
    expect(await num(page, "blocking-pos-x")).toBeCloseTo(2, 2);
    expect((await jointState(page, yId, "leftUpperLeg"))!.quaternion).toEqual(walkA);
    expect((await info(page)).proxyCount).toBe(1);

    // reload and look at shot 2B from the server: still its own
    await page.goto(urlA);
    await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
      timeout: 60_000,
    });
    await page.getByTestId("shot-select").selectOption(valueB);
    await expect(page.getByTestId("blocking-figure")).toHaveCount(1);
    await page.getByTestId("blocking-figure").click();
    expect(await num(page, "blocking-pos-x")).toBeCloseTo(-2, 2);
    expect((await jointState(page, yId, "leftUpperLeg"))!.quaternion[0]).toBeLessThan(-0.5); // seated
  });

  test("master frame shows the proxies and no editor helper; blocking changes stale old frames", async ({
    page,
  }) => {
    test.setTimeout(420_000);
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
      timeout: 30_000,
    });
    // frame the doorway and the vehicle with the Hotel Canopy camera (other specs may have left the camera elsewhere)
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

    // other specs may already have left master frames on this shot (rendered with no proxies): count relatively
    const framesBefore = await page.getByTestId("master-frame").count();
    const capture = async () => {
      const before = await page.getByTestId("master-frame").count();
      await page.getByTestId("capture-master-frame").click();
      await expect(page.getByTestId("master-frame")).toHaveCount(before + 1, { timeout: 120_000 });
      return page.getByTestId("master-frame-image").first().getAttribute("src");
    };

    const withProxies = await capture(); // Yumeko + Sean visible
    for (const name of ["Yumeko", "Sean"]) {
      await page.getByTestId("blocking-figure").filter({ hasText: name }).click();
      await page.getByTestId("blocking-visible").uncheck();
    }
    const without = await capture(); // capturing saves the changed blocking first
    expect(await meanDiff(page, withProxies!, without!)).toBeGreaterThan(0.2); // the proxies are in the picture
    for (const name of ["Yumeko", "Sean"]) {
      await page.getByTestId("blocking-figure").filter({ hasText: name }).click();
      await page.getByTestId("blocking-visible").check();
    }

    // pose mode ON with a joint selected and the skeleton shown: none of it may reach the render
    await page.getByTestId("blocking-figure").filter({ hasText: "Yumeko" }).click();
    await page.getByTestId("pose-mode-toggle").click();
    await page.getByTestId("joint-leftUpperArm").click();
    await expect(page.getByTestId("selected-joint-name")).toHaveText("Left upper arm");
    const posing = await capture();
    const during = await info(page);
    expect(during.poseMode).toBe(true);
    expect(during.helpers.length).toBeGreaterThan(5);
    expect(during.helpers.every((h) => h.onEditorLayerOnly)).toBe(true);
    expect(await meanDiff(page, withProxies!, posing!)).toBeLessThan(0.05); // same blocking, no helper in the image
    await page.getByTestId("pose-mode-toggle").click();

    // old frames are STALE once the blocking changes; none is deleted
    expect(await page.getByTestId("master-frame").count()).toBe(framesBefore + 3);
    // stale now: every earlier frame (no proxies in the picture) plus the one I rendered with the proxies hidden
    await expect(page.getByTestId("master-frame-stale")).toHaveCount(framesBefore + 1);
    await page.getByTestId("preset-hands_on_hips").click();
    // staleness is judged against the SAVED blocking: an unsaved edit does not stale anything yet
    await expect(page.getByTestId("master-frame-stale")).toHaveCount(framesBefore + 1);
    await page.getByTestId("save-blocking").click();
    await expect(page.getByTestId("blocking-status")).toContainText("saved", { timeout: 60_000 });
    await expect(page.getByTestId("master-frame-stale")).toHaveCount(framesBefore + 3);
    await expect(page.getByTestId("master-frame")).toHaveCount(framesBefore + 3); // history retained
  });

  test("local previs renders with the proxies and audio; blocking changes stale it; the package freezes blocking by value", async ({
    page,
  }) => {
    test.setTimeout(900_000);
    await serveTakeAudio(page);
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
      timeout: 30_000,
    });
    const shotId = await shotSelectValue(page);

    if ((await page.getByTestId("kf-marker").count()) < 2) {
      await setInput(page, "camera-pos-x", "3");
      await setInput(page, "camera-pos-z", "9");
      await setInput(page, "camera-focal", "35");
      await page.getByTestId("create-camera-path").click();
      await expect(page.getByTestId("kf-marker")).toHaveCount(1);
      await setInput(page, "camera-pos-x", "0");
      await setInput(page, "camera-pos-z", "2");
      await setInput(page, "camera-focal", "60");
      await page.getByTestId("to-end").click();
      await page.getByTestId("kf-add").click();
      await expect(page.getByTestId("kf-marker")).toHaveCount(2);
      await page.getByTestId("save-path").click();
      await expect(page.getByTestId("path-status")).toContainText(/Camera path saved/, { timeout: 60_000 });
    }

    const render = async () => {
      // earlier specs may have left a path saved against an older revision of the set: re-save it first
      if (await page.getByTestId("path-stale").count()) {
        await page.getByTestId("save-path").click();
        await expect(page.getByTestId("path-stale")).toHaveCount(0, { timeout: 60_000 });
      }
      await page.getByTestId("render-previs").click();
      await expect(page.getByTestId("path-status")).toContainText(/Previs saved privately/, {
        timeout: 600_000,
      });
    };
    const fpBefore = await page.getByTestId("character-blocking").getAttribute("data-live-fingerprint");
    await render();
    await expect(page.getByTestId("path-status")).toContainText("with performance audio");
    await expect(page.getByTestId("previs-current")).toBeVisible();
    const historyAfterFirst = await page.getByTestId("previs-history-item").count(); // earlier specs left clips too
    // the proxies' pose is static for the whole clip: rendering never touched the live blocking
    expect(await page.getByTestId("character-blocking").getAttribute("data-live-fingerprint")).toBe(fpBefore);

    type Pkg = {
      provenance: { fingerprint: string };
      spatialReference?: {
        shotBlocking?: {
          layerFingerprint: string | null;
          figures: Array<{
            characterId: string;
            fingerprint: string;
            revision: number;
            summary: string;
            pose: { joints: Record<string, unknown> };
          }>;
        };
        cameraMotion?: { previsAssetId: string | null; previs?: { hasAudio: boolean } };
      };
    };
    const get = async () => {
      const r = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
      expect(r.ok()).toBe(true);
      return (await r.json()) as Pkg;
    };
    const a = await get();
    const aText = JSON.stringify(a);
    const ref = a.spatialReference!.shotBlocking!;
    expect(ref.figures).toHaveLength(2);
    expect(ref.figures.find((f) => f.characterId === yumekoId)!.summary).toContain("Yumeko:");
    expect(a.spatialReference!.cameraMotion!.previsAssetId).toBeTruthy();
    expect(a.spatialReference!.cameraMotion!.previs!.hasAudio).toBe(true);

    // change Yumeko's pose: the previs is STALE (blocking), history is kept, the package stops referencing it
    await page.getByTestId("blocking-figure").filter({ hasText: "Yumeko" }).click();
    await page.getByTestId("preset-walk_b").click();
    await page.getByTestId("save-blocking").click();
    await expect(page.getByTestId("blocking-status")).toContainText("saved", { timeout: 60_000 });
    await expect(page.getByTestId("previs-stale")).toContainText("STALE BLOCKING");
    const b = await get();
    expect(b.provenance.fingerprint).not.toBe(a.provenance.fingerprint);
    expect(b.spatialReference!.cameraMotion!.previsAssetId).toBeNull();
    const yumekoOf = (p: Pkg) =>
      p.spatialReference!.shotBlocking!.figures.find((f) => f.characterId === yumekoId)!;
    expect(yumekoOf(b).fingerprint).not.toBe(yumekoOf(a).fingerprint);
    expect(yumekoOf(b).revision).toBe(yumekoOf(a).revision + 1);
    expect(JSON.stringify(a)).toBe(aText); // package A, as compiled, never changed

    await render();
    await expect(page.getByTestId("previs-current")).toBeVisible();
    await expect(page.getByTestId("previs-history-item")).toHaveCount(historyAfterFirst + 1); // the first previs is kept
    const c = await get();
    expect(c.spatialReference!.cameraMotion!.previsAssetId).toBeTruthy();
    expect(c.spatialReference!.cameraMotion!.previsAssetId).not.toBe(
      a.spatialReference!.cameraMotion!.previsAssetId,
    );
  });

  test("proxies are released on navigation and removal: no duplicates, no leaked helpers, no growing GPU memory", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page.goto(setUrl);
    await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
      timeout: 60_000,
    });
    await page.getByTestId("blocking-figure").filter({ hasText: "Yumeko" }).click();
    await page.getByTestId("pose-mode-toggle").click();
    await page.getByTestId("joint-head").click();
    expect((await info(page)).helpers.length).toBeGreaterThan(5);
    await page.getByTestId("pose-mode-toggle").click();
    expect((await info(page)).helpers).toHaveLength(0);

    const geos: number[] = [];
    for (let i = 0; i < 3; i++) {
      await page.goto(setUrl);
      await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
        timeout: 60_000,
      });
      await expect(page.getByTestId("blocking-figure")).toHaveCount(2);
      const inf = await info(page);
      expect(inf.proxyCount).toBe(2);
      expect([...inf.sceneProxyNames].sort()).toEqual(["Sean · Character Proxy", "Yumeko · Character Proxy"]);
      geos.push(inf.geometries);
    }
    expect(geos[2]).toBe(geos[1]); // remounting does not accumulate geometry

    // removal with Delete is undoable and leaves nothing behind
    await page.getByTestId("blocking-figure").filter({ hasText: "Sean" }).click();
    await page.keyboard.press("Delete");
    await expect(page.getByTestId("blocking-figure")).toHaveCount(1);
    expect((await info(page)).proxyCount).toBe(1);
    await page.getByTestId("undo").click();
    await expect(page.getByTestId("blocking-figure")).toHaveCount(2);
    expect((await info(page)).proxyCount).toBe(2);
    await page.getByTestId("redo").click();
    await expect(page.getByTestId("blocking-figure")).toHaveCount(1);
  });

  test("a Set change makes blocking STALE; Re-anchor to current set keeps root and pose", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto(setUrl);
    await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
      timeout: 60_000,
    });
    // earlier specs link the production camera, which is a legitimate Set change: start from re-anchored blocking
    if ((await page.getByTestId("blocking-stale").count()) > 0) {
      await page.getByTestId("reanchor-blocking").click();
      await expect(page.getByTestId("blocking-status")).toContainText("re-anchored", { timeout: 60_000 });
    }
    await expect(page.getByTestId("blocking-stale")).toHaveCount(0);
    const layerBefore = await page.getByTestId("character-blocking").getAttribute("data-saved-fingerprint");
    const figureBefore = await page.getByTestId("blocking-figure").count();

    // change the Location's set and save it (blocking is NOT re-saved, so it is not silently re-anchored)
    await page.getByTestId("add-box").click();
    await page.getByTestId("save-set").click();
    await expect(page.getByTestId("set-status")).toContainText(/Saved — revision/, { timeout: 60_000 });
    await expect(page.getByTestId("blocking-stale")).toContainText("STALE BLOCKING");
    expect(await page.getByTestId("blocking-figure").count()).toBe(figureBefore); // kept, not deleted

    await page.getByTestId("reanchor-blocking").click();
    await expect(page.getByTestId("blocking-status")).toContainText("re-anchored", { timeout: 60_000 });
    await expect(page.getByTestId("blocking-stale")).toHaveCount(0);
    // root + pose are unchanged: the blocking identity is the same
    expect(await page.getByTestId("character-blocking").getAttribute("data-saved-fingerprint")).toBe(
      layerBefore,
    );
    await page.reload();
    await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
      timeout: 60_000,
    });
    await expect(page.getByTestId("blocking-stale")).toHaveCount(0);
  });
});

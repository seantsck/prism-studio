import { deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { encodeSplatFile, syntheticPlane } from "../src/lib/splat/synthetic";

/**
 * Phase 4E — splat control-pass refusal and environment limits. Its own memory server (memory-4e-isolated): it imports
 * a splat into a Location, calibrates it and saves the Set. No provider, reconstruction or paid call is made.
 *
 *   A  a Set with no splat shows no Environment panel (3D stays optional)
 *   B  an imported splat is viewable: framing is limited until it has a scale, control passes are refused
 *   C  a calibrated splat saves; scaling it afterwards makes the calibration stale and the save is refused (no write)
 *   D  a collapsed (zero) scale is refused; a hidden splat makes control passes available again
 *   E  image-first is unaffected: the same Shot takes an uploaded Production Frame with no 3D step
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
const CODE = "3A";
let shotUrl = "";
let setUrl = "";

const splatHook = <T>(page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    ([m, a]) =>
      (
        window as unknown as { __prismSet: { splat: Record<string, (...x: unknown[]) => unknown> } }
      ).__prismSet.splat[m as string](...(a as unknown[])),
    [method, args] as const,
  ) as Promise<T>;

async function ready(page: Page) {
  await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(page.getByTestId("spatial-passes")).toHaveAttribute("data-loaded", "true", {
    timeout: 30_000,
  });
  await expect.poll(() => splatHook<boolean>(page, "sceneLoaded"), { timeout: 60_000 }).toBe(true);
}

async function openSet(page: Page) {
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: CODE, exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  shotUrl = page.url().split("?")[0]!;
  await page.goto(`${shotUrl}?section=set`);
  await page.getByTestId("open-in-3d-set").click();
  await page.waitForURL(/\/locations\/[0-9a-f-]{36}\/3d\?shot=/);
  setUrl = page.url();
  await ready(page);
}

const env = (page: Page) => page.getByTestId("environment-status");
const op = (page: Page, name: string) => page.getByTestId(`environment-op-${name}`);
const splatItem = (page: Page) => page.getByTestId("outliner-item").filter({ hasText: "gaussian splat" });
const savedFp = (page: Page) => page.getByTestId("virtual-set").getAttribute("data-saved-fingerprint");

async function setScale(page: Page, axis: "x" | "y" | "z", value: number) {
  const field = page.getByTestId(`inspector-scale-${axis}`);
  await field.fill(String(value));
  await field.press("Enter");
}

async function saveOk(page: Page) {
  await page.getByTestId("save-set").click();
  await expect(page.getByTestId("set-status")).toContainText(/Saved — revision/, { timeout: 60_000 });
}

/** A valid RGB PNG (header facts and bytes only). */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (b: Buffer) => {
    let c = 0xffffffff;
    for (const byte of b) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set(rgb, y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("A — a Set without a splat shows no Environment panel; nothing about it changes", async ({ page }) => {
  test.setTimeout(180_000);
  await openSet(page);
  await expect(page.getByTestId("virtual-set")).toBeVisible();
  await expect(env(page)).toHaveCount(0);
  await expect(page.getByTestId("capture-master-frame")).toBeEnabled();
});

test("B — an imported splat is viewable; framing is limited without a scale; control passes are refused", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto(setUrl);
  await ready(page);
  await page.getByTestId("import-splat-file").setInputFiles({
    name: "plane.splat",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(encodeSplatFile(syntheticPlane({ n: 24, size: 2 }))),
  });
  await page.getByTestId("import-splat").click();
  await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });

  await expect(env(page)).toHaveAttribute("data-status", "view_only");
  await expect(env(page)).toHaveAttribute("data-scale", "unknown");
  await expect(page.getByTestId("environment-status-label")).toHaveText(
    "View and framing only — no control passes",
  );
  await expect(op(page, "render")).toHaveAttribute("data-state", "available");
  await expect(op(page, "framing")).toHaveAttribute("data-state", "limited");
  await expect(op(page, "framing")).toContainText("Not to real-world scale");
  await expect(op(page, "lighting")).toHaveAttribute("data-state", "limited");
  await expect(op(page, "control-passes")).toHaveAttribute("data-state", "unavailable");
  await expect(op(page, "control-passes")).toContainText("not supported yet");
  await expect(op(page, "save")).toHaveAttribute("data-state", "available");
  // the existing refusal, in the panel that captures (unchanged)
  await expect(page.getByTestId("capture-spatial-passes")).toBeDisabled();
  await expect(page.getByTestId("environment-issue")).toHaveCount(0);
});

test("C — calibrate and save; scaling afterwards makes the calibration stale and the save is refused", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto(setUrl);
  await ready(page);
  // B left the splat unsaved: the reload shows the last SAVED Set, so import is repeated only if it is gone
  if ((await splatItem(page).count()) === 0) {
    await page.getByTestId("import-splat-file").setInputFiles({
      name: "plane.splat",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(encodeSplatFile(syntheticPlane({ n: 24, size: 2 }))),
    });
    await page.getByTestId("import-splat").click();
    await expect(splatItem(page)).toHaveCount(1, { timeout: 60_000 });
  }
  await splatItem(page).click();
  await page.getByTestId("splat-metres-per-unit").fill("0.5");
  await page.getByTestId("splat-apply-scale").click();
  await expect(page.getByTestId("splat-scale-status")).toContainText("manual — 1 source unit = 0.5 m");
  await expect(env(page)).toHaveAttribute("data-scale", "manual");
  await expect(op(page, "framing")).toHaveAttribute("data-state", "available");
  await expect(op(page, "framing")).toContainText("1 source unit = 0.5 m");
  await saveOk(page);
  const fp = await savedFp(page);

  // scale ONE axis after calibrating: "1 unit = 0.5 m" is no longer true
  await setScale(page, "z", 0.8);
  await expect(env(page)).toHaveAttribute("data-status", "needs_attention");
  await expect(page.getByTestId("environment-status-label")).toHaveText("Environment needs attention");
  await expect(page.getByTestId("environment-issue")).toHaveAttribute("data-code", "SPLAT_CALIBRATION_STALE");
  await expect(op(page, "save")).toHaveAttribute("data-state", "unavailable");
  await page.getByTestId("save-set").click();
  await expect(page.getByTestId("set-status")).toContainText("scaled after its calibration");
  expect(await savedFp(page)).toBe(fp);

  // the fix the message names: apply the scale again
  await page.getByTestId("splat-apply-scale").click();
  await expect(env(page)).toHaveAttribute("data-status", "view_only");
  await expect(page.getByTestId("environment-issue")).toHaveCount(0);

  // the saved Set still holds the calibrated environment
  await page.goto(setUrl);
  await ready(page);
  await splatItem(page).click();
  await expect(page.getByTestId("splat-scale-status")).toContainText("manual — 1 source unit = 0.5 m");
  await expect(page.getByTestId("inspector-scale-z")).toHaveValue("0.5");
  expect(await savedFp(page)).toBe(fp);
});

test("D — a zero scale is refused; hiding the splat makes control passes available", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(setUrl);
  await ready(page);
  const fp = await savedFp(page);
  await splatItem(page).click();
  await setScale(page, "y", 0);
  await expect(page.getByTestId("environment-issue")).toHaveAttribute("data-code", "SPLAT_SCALE_DEGENERATE");
  await page.getByTestId("save-set").click();
  await expect(page.getByTestId("set-status")).toContainText("zero scale");
  expect(await savedFp(page)).toBe(fp);
  await setScale(page, "y", 0.5);
  await expect(page.getByTestId("environment-issue")).toHaveCount(0);

  await page.getByTestId("splat-visibility").click();
  await expect(env(page)).toHaveAttribute("data-status", "hidden");
  await expect(op(page, "control-passes")).toHaveAttribute("data-state", "available");
  await expect(op(page, "render")).toHaveAttribute("data-state", "limited");
  await page.getByTestId("splat-visibility").click();
  await expect(env(page)).toHaveAttribute("data-status", "view_only");
  await expect(op(page, "control-passes")).toHaveAttribute("data-state", "unavailable");
});

test("E — image-first is unaffected: the Shot takes an uploaded Production Frame with no 3D step", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(`${shotUrl}?section=production_frame`);
  const pf = page.getByTestId("production-frame-section");
  await expect(pf).toBeVisible();
  const before = await pf.getByTestId("pf-history-item").count();
  await pf.getByTestId("pf-upload-file").setInputFiles({
    name: "e2e-4e-upload.png",
    mimeType: "image/png",
    buffer: png(956, 400, [60, 120, 200]),
  });
  await pf.getByTestId("pf-upload-submit").click();
  const selected = pf.getByTestId("pf-selected");
  await expect(selected).toHaveAttribute("data-source", "upload");
  await expect(selected).toContainText("956×400");
  await expect(pf.getByTestId("pf-history-item")).toHaveCount(before + 1);
});

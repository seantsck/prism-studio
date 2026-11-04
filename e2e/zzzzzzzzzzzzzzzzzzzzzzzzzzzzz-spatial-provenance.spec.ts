import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 4C-I1 — camera correctness, Master Frame spatial provenance and safe Production Frame promotion. Memory mode
 * (its own server), the real renderer (SwiftShader), the real UI and server actions. No provider call.
 *
 *   A  wrong camera (RELEASE BLOCKER): Shot A's camera rendered as Shot B is refused; B's own camera is accepted
 *   B  fresh → stale camera: the promotion asks first, the confirmed digest promotes
 *   C  unknown camera (a pre-4C fixture): asked first, shown apart from stale
 *   D  TOCTOU (RELEASE BLOCKER): an old digest after a lighting change promotes and selects nothing
 *   E  exact source: older A promoted after newer B freezes A's fingerprints
 *   F  dedup both directions: the same immutable frame is reselected
 *   G  source deletion: the frozen sourceSpatial survives
 *   H  no-spatial: a Shot without 3D is unchanged (no new package key)
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
type Opened = { shotUrl: string; setUrl: string; shotId: string };

async function openSet(page: Page, code: string): Promise<Opened> {
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: code, exact: true }).first().click();
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
  await expect(page.getByTestId("shot-lighting")).toHaveAttribute("data-loaded", "true", { timeout: 30_000 });
}

const setInput = async (page: Page, testId: string, value: string) => {
  const input = page.getByTestId(testId);
  await input.fill(value);
  await input.press("Enter");
  await expect(input).toHaveValue(value);
};

async function saveSet(page: Page) {
  await page.getByTestId("save-set").click();
  await expect(page.getByTestId("set-status")).toContainText("Saved", { timeout: 30_000 });
  await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-dirty", "false");
}

async function link(page: Page) {
  await page.getByTestId("link-shot-camera").click();
  await expect(page.getByTestId("set-status")).toContainText("linked", { timeout: 30_000 });
}

async function capture(page: Page) {
  await page.getByTestId("capture-master-frame").click();
  await expect(page.getByTestId("set-status")).toContainText("Master frame saved", { timeout: 60_000 });
}

async function saveLight(page: Page, intensity: string) {
  if ((await page.getByTestId("light-intensity").count()) === 0) {
    await page.getByTestId("lighting-base-mode").selectOption("replace");
    await page.getByTestId("lighting-add-type").selectOption("point");
    await page.getByTestId("lighting-add").click();
  }
  await page.getByTestId("light-intensity").fill(intensity);
  await page.getByTestId("lighting-save").click();
  await expect(page.getByTestId("shot-lighting")).toHaveAttribute("data-dirty", "false", { timeout: 30_000 });
}

type SourceSpatial = {
  schemaVersion: number;
  masterFrameId: string;
  sceneFingerprint: string;
  cameraFingerprint: string | null;
  blockingFingerprint: string | null;
  lightingFingerprint: string | null;
};
type Pkg = {
  references: {
    productionFrame?: { frameId: string; version: number; freshness: string; sourceSpatial?: SourceSpatial };
  };
  spatialReference?: { sceneFingerprint: string; shotLighting?: { lightingFingerprint: string } };
};
const pkg = async (page: Page, shotId: string): Promise<Pkg> => {
  const r = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
  expect(r.ok()).toBe(true);
  return (await r.json()) as Pkg;
};

/** Master Frame ids offered on the Shot's Production Frame section, newest first. */
async function masterIds(page: Page, shotUrl: string): Promise<string[]> {
  await page.goto(`${shotUrl}?section=production_frame`);
  const rows = page.locator('[data-testid^="pf-master-row-"]');
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  return (await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!))).map((t) =>
    t.replace("pf-master-row-", ""),
  );
}

const useBtn = (page: Page, id: string) => page.getByTestId(`pf-use-master-${id}`);
const anywayBtn = (page: Page, id: string) => page.getByTestId(`pf-use-master-anyway-${id}`);
const confirmBox = (page: Page, id: string) => page.getByTestId(`pf-master-confirm-${id}`);
const promoted = (page: Page, id: string) =>
  page.getByTestId(`pf-master-row-${id}`).getByTestId("pf-master-promoted");

const fixture = async (page: Page, action: "historical" | "delete", masterFrameId: string) => {
  const r = await page.request.post("/api/dev/previs/master-frame-fixture", {
    data: { action, masterFrameId },
  });
  expect(r.ok()).toBe(true);
  return (await r.json()) as { id?: string };
};

function png(width: number, height: number, rgb: [number, number, number]): Buffer {
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

let shotA: Opened; // Ep 1 · Shot 2D
let shotB: Opened; // Ep 1 · Shot 2E (same Location: the Hotel Canopy)
let a1 = ""; // Shot A's first Master Frame (camera x = 1.2)
let b1 = ""; // Shot B's first Master Frame
let a1Source: SourceSpatial | null = null; // a1's frozen lineage, as first promoted

test("A — wrong camera (release blocker): A's camera rendered as B is refused; B's own camera is accepted", async ({
  page,
}) => {
  test.setTimeout(300_000);
  // Shot B: its own production camera at x = 3
  shotB = await openSet(page, "2E");
  await page.getByTestId("load-test-set").click();
  await expect(page.getByTestId("set-status")).toContainText("Hotel Canopy", { timeout: 30_000 });
  await setInput(page, "camera-pos-x", "3");
  await saveSet(page);
  await link(page);

  // Shot A: the set's camera moved to x = 1.2, linked to A, one honest capture
  shotA = await openSet(page, "2D");
  await setInput(page, "camera-pos-x", "1.2");
  await saveSet(page);
  await link(page);
  await capture(page);

  // the Location page switcher still holds A's bookmark after choosing B (the P6 leak, fixed in I2): the render uses
  // A's camera while the request names Shot B. The server must refuse it.
  await page.getByTestId("shot-select").selectOption({ label: "Ep 1 · Shot 2E" });
  await expect(page.getByTestId("shot-lighting")).toHaveAttribute("data-loaded", "true", { timeout: 30_000 });
  await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
    timeout: 30_000,
  });
  await page.getByTestId("capture-master-frame").click();
  await expect(page.getByTestId("set-status")).toContainText("different camera", { timeout: 60_000 });

  // nothing was stored for B
  await page.goto(shotB.setUrl);
  await ready(page);
  await expect(page.getByTestId("master-frame")).toHaveCount(0);

  // B's own camera (from B's page, B's bookmark) is accepted
  await capture(page);
  await expect(page.getByTestId("master-frame")).toHaveCount(1, { timeout: 30_000 });
  [b1] = await masterIds(page, shotB.shotUrl);
  [a1] = await masterIds(page, shotA.shotUrl);
  expect(a1 && b1).toBeTruthy();
});

test("B — fresh → stale camera: Use 3D Master Frame asks first; the confirmed digest promotes", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // fresh right now: promote nothing yet; move A's production camera and re-link
  await page.goto(shotA.setUrl);
  await ready(page);
  await setInput(page, "camera-pos-x", "2");
  await saveSet(page);
  await link(page);
  await expect(page.getByTestId("master-frame-stale-camera").first()).toContainText("STALE CAMERA");

  await page.goto(`${shotA.shotUrl}?section=production_frame`);
  await expect(page.getByTestId(`pf-master-row-${a1}`)).toContainText("STALE CAMERA");
  await useBtn(page, a1).click();
  await expect(confirmBox(page, a1)).toContainText("STALE CAMERA", { timeout: 30_000 });
  expect((await pkg(page, shotA.shotId)).references.productionFrame).toBeUndefined();
  await anywayBtn(page, a1).click();
  await expect(promoted(page, a1)).toContainText("Used anyway", { timeout: 30_000 });
  const p = await pkg(page, shotA.shotId);
  a1Source = p.references.productionFrame!.sourceSpatial!;
  expect(p.references.productionFrame!.sourceSpatial!.masterFrameId).toBe(a1);
  expect(p.references.productionFrame!.sourceSpatial!.cameraFingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(p.references.productionFrame)).not.toMatch(/stale.*camera|unknown/i);
});

test("C — unknown camera (pre-4C fixture) is asked first and shown apart from stale", async ({ page }) => {
  test.setTimeout(180_000);
  const { id: historical } = await fixture(page, "historical", a1);
  await page.goto(shotA.setUrl);
  await ready(page);
  await expect(page.getByTestId("master-frame-unknown-camera")).toHaveCount(1, { timeout: 30_000 });

  await page.goto(`${shotA.shotUrl}?section=production_frame`);
  await useBtn(page, historical!).click();
  const box = confirmBox(page, historical!);
  await expect(box).toContainText("UNKNOWN CAMERA PROVENANCE", { timeout: 30_000 });
  await expect(box).not.toContainText("STALE CAMERA");
  await anywayBtn(page, historical!).click();
  await expect(promoted(page, historical!)).toContainText("Production Frame v", { timeout: 30_000 });
  const src = (await pkg(page, shotA.shotId)).references.productionFrame!.sourceSpatial!;
  expect(src.masterFrameId).toBe(historical);
  expect(src.cameraFingerprint).toBeNull();
});

test("D — TOCTOU (release blocker): an old digest after a lighting change promotes and selects nothing", async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  // B's frame becomes stale (lighting added after it)
  await page.goto(shotB.setUrl);
  await ready(page);
  await saveLight(page, "40");

  await page.goto(`${shotB.shotUrl}?section=production_frame`);
  await useBtn(page, b1).click();
  await expect(confirmBox(page, b1)).toContainText("STALE LIGHTING", { timeout: 30_000 });

  // meanwhile, in another tab, the lighting changes again
  const other = await context.newPage();
  await other.goto(shotB.setUrl);
  await ready(other);
  await saveLight(other, "90");
  await other.close();

  // the person confirms what they saw: refused, nothing created or selected, a new confirmation
  await anywayBtn(page, b1).click();
  await expect(confirmBox(page, b1)).toContainText("changed after you confirmed", { timeout: 30_000 });
  expect((await pkg(page, shotB.shotId)).references.productionFrame).toBeUndefined();
  await page.reload();
  await expect(page.getByTestId("pf-history-item")).toHaveCount(0);
});

test("E — exact source: older A promoted after newer B freezes A's fingerprints, never B's", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto(shotB.setUrl);
  await ready(page);
  await capture(page); // the newer frame, under the current rig
  const ids = await masterIds(page, shotB.shotUrl);
  expect(ids).toHaveLength(2);
  const [newer, older] = ids as [string, string];
  expect(older).toBe(b1);
  await useBtn(page, older).click();
  await expect(confirmBox(page, older)).toBeVisible({ timeout: 30_000 });
  await anywayBtn(page, older).click();
  await expect(promoted(page, older)).toContainText("Production Frame v1", { timeout: 30_000 });
  const p = await pkg(page, shotB.shotId);
  const src = p.references.productionFrame!.sourceSpatial!;
  expect(src.masterFrameId).toBe(older);
  expect(src.masterFrameId).not.toBe(newer);
  // the older frame had no rig; the current (and the newer frame's) rig is a real one
  expect(src.lightingFingerprint).toBeNull();
  expect(p.spatialReference!.shotLighting!.lightingFingerprint).toMatch(/^[0-9a-f]{64}$/);
});

test("F — dedup both directions: the same immutable frame is reselected", async ({ page }) => {
  test.setTimeout(240_000);
  // Case A (fresh → stale): B's newer frame promoted fresh, then the lighting changes, then promoted again
  const [newer] = await masterIds(page, shotB.shotUrl);
  await useBtn(page, newer!).click();
  await expect(promoted(page, newer!)).toContainText("Production Frame v2", { timeout: 30_000 });
  const first = (await pkg(page, shotB.shotId)).references.productionFrame!;
  await page.goto(shotB.setUrl);
  await ready(page);
  await saveLight(page, "15");
  await page.goto(`${shotB.shotUrl}?section=production_frame`);
  await useBtn(page, newer!).click();
  await expect(confirmBox(page, newer!)).toContainText("STALE LIGHTING", { timeout: 30_000 });
  await anywayBtn(page, newer!).click();
  await expect(promoted(page, newer!)).toContainText("already exists as Production Frame v2", {
    timeout: 30_000,
  });
  const again = (await pkg(page, shotB.shotId)).references.productionFrame!;
  expect(again.frameId).toBe(first.frameId);
  expect(again.sourceSpatial).toEqual(first.sourceSpatial);

  // Case B (stale → fresh): the frame is stale now (rig 15); restore the rig it was rendered with (90) and promote
  // again without any confirmation: the same frame, and nothing on it records either attempt
  await page.goto(shotB.setUrl);
  await ready(page);
  await saveLight(page, "90");
  await page.goto(`${shotB.shotUrl}?section=production_frame`);
  await expect(page.getByTestId(`pf-master-row-${newer!}`)).not.toContainText("STALE");
  await useBtn(page, newer!).click();
  await expect(promoted(page, newer!)).toContainText("already exists as Production Frame v2", {
    timeout: 30_000,
  });
  const restored = (await pkg(page, shotB.shotId)).references.productionFrame!;
  expect(restored.frameId).toBe(first.frameId);
  expect(restored.sourceSpatial).toEqual(first.sourceSpatial);
  expect(JSON.stringify(restored)).not.toMatch(/confirm|unknown|stale/i);

  // a SET edit is new visual intent (the 2G.1 intent snapshot freezes the set fingerprint): A's frame promoted after
  // its camera is restored is a new immutable version whose lineage is still exactly A's
  await page.goto(shotA.setUrl);
  await ready(page);
  await setInput(page, "camera-pos-x", "1.2");
  await saveSet(page);
  await link(page);
  await page.goto(`${shotA.shotUrl}?section=production_frame`);
  await expect(page.getByTestId(`pf-master-row-${a1}`)).not.toContainText("STALE CAMERA");
  await useBtn(page, a1).click();
  await expect(promoted(page, a1)).toContainText("Production Frame v", { timeout: 30_000 });
  const viaA = (await pkg(page, shotA.shotId)).references.productionFrame!;
  expect(viaA.sourceSpatial).toEqual(a1Source);
});

test("G — source deletion: the frozen sourceSpatial survives the deleted Master Frame", async ({ page }) => {
  test.setTimeout(120_000);
  const before = (await pkg(page, shotA.shotId)).references.productionFrame!;
  expect(before.sourceSpatial!.masterFrameId).toBe(a1);
  await fixture(page, "delete", a1);
  const after = (await pkg(page, shotA.shotId)).references.productionFrame!;
  expect(after.frameId).toBe(before.frameId);
  expect(after.sourceSpatial).toEqual(before.sourceSpatial);
  await page.goto(`${shotA.shotUrl}?section=production_frame`);
  await expect(page.getByTestId("pf-selected")).toBeVisible();
});

test("H — a Shot without 3D: a normal Production Frame, no new required package key", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${EP}/shots`);
  const href = await page.getByRole("link", { name: "1A", exact: true }).first().getAttribute("href");
  await page.goto(`${href!}?section=production_frame`);
  const shotId = /\/shots\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await expect(page.locator('[data-testid^="pf-master-row-"]')).toHaveCount(0);
  await page.getByTestId("pf-upload-file").setInputFiles({
    name: "e2e-4c-no-spatial.png",
    mimeType: "image/png",
    buffer: png(956, 400, [90, 140, 60]),
  });
  await page.getByTestId("pf-upload-submit").click();
  await expect(page.getByTestId("pf-selected")).toHaveAttribute("data-source", "upload", { timeout: 30_000 });
  const p = await pkg(page, shotId);
  expect(p.references.productionFrame).toBeDefined();
  expect("sourceSpatial" in p.references.productionFrame!).toBe(false);
  expect(p.spatialReference).toBeUndefined();
});

import { crc32, deflateSync } from "node:zlib";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * Phase 2G.3 Location View continuity, memory mode, through the UI. NO 3D set, GPU, reconstruction or paid provider:
 * the free mock IMAGE model stands in for a provider (REAL IMAGE-MODEL CALLS: 0). Shot 4C at the Sky-View Restaurant is
 * used because no other spec edits it.
 *
 *   Locations → upload Location View "Doorway" (4:3: any shape, never cropped)
 *   Shot Prep 4C → choose "Doorway" → generate a free mock Production Frame candidate → the view is an explicit,
 *   labelled reference → conform → Use as Production Frame → Save as Location View "Doorway Tight" (same image)
 *   → the Location has both views
 */

const EP = "/projects/ojousama/episodes/ep-1";
const PLACE = "Sky-View Restaurant";
test.describe.configure({ mode: "serial" });

/** A valid RGB PNG of the given size (a single flat colour). */
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

async function openShot(page: Page, code: string) {
  await page.goto(`${EP}/shots`);
  const href = await page.getByRole("link", { name: code, exact: true }).first().getAttribute("href");
  await page.goto(href!);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(code);
  return page.url().split("?")[0]!;
}

async function packageOf(page: Page, request: APIRequestContext, shotUrl: string) {
  await page.goto(`${shotUrl}?section=brief`);
  const href = await page.getByRole("link", { name: /Download brief/ }).getAttribute("href");
  return (await (await request.get(href!.replace("format=brief", "format=json"))).json()) as {
    version: number;
    references: {
      locationView?: { name: string; assetId: string; kind: string; viewSpec: Record<string, unknown> };
    };
    assets: Record<string, Record<string, unknown>>;
  };
}

/** The Location's block on the Locations page, opened. */
async function placeBlock(page: Page): Promise<Locator> {
  await page.goto("/projects/ojousama/locations");
  const block = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: PLACE }) })
    .first();
  await block.locator("summary").first().click();
  return block;
}

const views = (scope: Locator) => scope.getByTestId("location-view-card");
let shotUrl: string;
let setUrl: string;

test("Locations: upload a canonical Location View 'Doorway' (any shape, private image)", async ({ page }) => {
  const block = await placeBlock(page);
  await expect(block.getByTestId("location-views-empty")).toBeVisible();
  await block.getByTestId("lv-upload").locator("summary").click();
  const form = block.getByTestId("lv-upload");
  await form.getByTestId("lv-upload-file").setInputFiles({
    name: "e2e-lv-doorway.png",
    mimeType: "image/png",
    buffer: png(400, 300, [120, 90, 60]),
  });
  await form.getByTestId("lv-upload-name").fill("Doorway");
  await form.getByTestId("lv-upload-kind").selectOption("entrance");
  await form.getByTestId("lv-upload-zone").selectOption({ label: "Entrance" });
  await form.getByTestId("lv-upload-viewpoint").fill("from the west entrance toward the window table");
  await form.getByTestId("lv-upload-submit").click();
  const card = views(block).filter({ hasText: "Doorway" });
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  await expect(card).toContainText("Entrance");
  await expect(card).toContainText("zone: Entrance");
  await expect(card).toContainText("400×300"); // stored as is: never cropped to the 2.39:1 production frame
  await expect(card).toHaveAttribute("data-source", "upload");
  const src = await card.getByTestId("location-view-image").getAttribute("src");
  expect(src).toMatch(/^\/api\/assets\/[0-9a-f-]+$/); // the private asset route, never a public/signed URL
  await expect(block).not.toContainText(/GPU|COLMAP|splat|Vulkan/i);
});

test("Shot Prep: choose 'Doorway' for Shot 4C; the package carries it by value", async ({
  page,
  request,
}) => {
  shotUrl = await openShot(page, "4C");
  await page.goto(`${shotUrl}?section=production_frame`);
  const lv = page.getByTestId("location-view-section");
  await expect(lv.getByTestId("lv-location")).toHaveText(PLACE);
  await expect(lv.getByTestId("lv-empty")).toContainText("No Location View selected.");
  await expect(lv.getByTestId("lv-empty")).toContainText("preserve the same geography");
  await expect(lv).not.toContainText(/3D|GPU|COLMAP|splat|reconstruction|Vulkan/i);
  await views(lv).filter({ hasText: "Doorway" }).getByTestId("lv-choose").click();
  await expect(lv.getByTestId("lv-selected")).toContainText("Doorway", { timeout: 15_000 });

  const json = await packageOf(page, request, shotUrl);
  expect(json.version).toBe(5);
  expect(json.references.locationView).toMatchObject({ name: "Doorway", kind: "entrance" });
  expect(json.assets[json.references.locationView!.assetId]).toMatchObject({
    purpose: "location_ref",
    width: 400,
  });
});

test("Generate a FREE mock candidate: the Location View is an explicit, labelled image reference", async ({
  page,
}) => {
  await page.goto(`${shotUrl}?section=production_frame`);
  const pf = page.getByTestId("production-frame-section");
  await pf.getByTestId("pf-generate-summary").click();
  const panel = pf.getByTestId("pf-candidates-panel");
  const refs = panel.getByTestId("pf-candidate-references");
  await expect(refs).toContainText('Location View · Canonical Location View "Doorway"');
  const row = panel.locator('[data-testid="model-row"][data-model="mock-image-wide"]');
  await expect(row.getByTestId("model-cost")).toContainText("free");
  await row.getByTestId("model-pick").check();
  await panel.getByTestId("ack-all").check();
  await panel.getByTestId("create-candidate-set").click();

  await expect(page).toHaveURL(/\/candidates\/[0-9a-f-]+$/);
  setUrl = page.url();
  const card = page.locator('[data-testid="candidate-card"][data-model="mock-image-wide"]');
  await expect(card).toHaveAttribute("data-status", "succeeded", { timeout: 25_000 });
  // what was SENT, from the frozen request: the canonical view, under its own truthful label
  await expect(card.getByTestId("candidate-references")).toContainText('Canonical Location View "Doorway"');
});

test("Use as Production Frame, then Save as Location View 'Doorway Tight' (the same image, no copy)", async ({
  page,
}) => {
  await page.goto(setUrl);
  const card = page.locator('[data-testid="candidate-card"][data-model="mock-image-wide"]');
  await card.getByTestId("create-production-conform").click();
  await expect(card.getByTestId("use-as-pf")).toBeEnabled({ timeout: 30_000 });
  await card.getByTestId("use-as-pf").click();
  await expect(card.getByTestId("current-production-frame")).toBeVisible();

  await page.goto(`${shotUrl}?section=production_frame`);
  const pf = page.getByTestId("production-frame-section");
  await expect(pf.getByTestId("pf-selected")).toHaveAttribute("data-freshness", "fresh");
  const save = pf.getByTestId("pf-save-as-view");
  await save.locator("summary").click();
  await save.getByTestId("pf-view-name").fill("Doorway Tight");
  await save.getByTestId("pf-view-kind").selectOption("entrance");
  await save.getByTestId("pf-view-viewpoint").fill("tighter on the window table");
  await save.getByTestId("pf-save-as-view-submit").click();
  await expect(save).toContainText("Location View saved", { timeout: 15_000 });
  // saving a view does not change this Shot: "Doorway" is still the selected view and the frame is still fresh
  await page.reload();
  await expect(page.getByTestId("lv-selected")).toContainText("Doorway");
  await expect(page.getByTestId("pf-selected")).toHaveAttribute("data-freshness", "fresh");
});

test("Locations: the Location now has both canonical views; the frame's view reuses its image", async ({
  page,
}) => {
  const block = await placeBlock(page);
  await expect(views(block)).toHaveCount(2);
  const tight = views(block).filter({ hasText: "Doorway Tight" });
  await expect(tight).toHaveAttribute("data-source", "production_frame");
  await expect(tight).toContainText("From Production Frame");
  // the Shot Prep list offers the new one too
  await page.goto(`${shotUrl}?section=production_frame`);
  await expect(
    page.getByTestId("lv-available").getByTestId("location-view-card").filter({ hasText: "Doorway Tight" }),
  ).toHaveCount(1);
});

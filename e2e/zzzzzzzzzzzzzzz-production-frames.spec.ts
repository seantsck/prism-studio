import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 2G.1 Production Frames, memory mode, through the UI. The demo project has NO 3D set, reconstruction, GPU or
 * provider in play: everything below works without them. Shot 5A is used because no other spec edits it.
 *
 *   no-3D project: empty → promote the approved Storyboard → fresh → the package uses it as the start frame
 *   upload: a production-shaped image is selected; a wrong aspect or a non-image is refused; a repeat is not duplicated
 *   history: choosing another frame never deletes the others
 *   stale: a Shot change marks the selected frame stale (it stays selected) and names what changed
 */

const EP = "/projects/ojousama/episodes/ep-1";
test.describe.configure({ mode: "serial" });

/** A valid RGB PNG of the given size (a single flat colour: only its header facts and bytes matter here). */
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

const section = (page: Page) => page.getByTestId("production-frame-section");

/** The package export of the Shot (the same JSON/brief the Generation Brief section offers). */
async function packageOf(page: Page, request: import("@playwright/test").APIRequestContext, shotUrl: string) {
  await page.goto(`${shotUrl}?section=brief`);
  const href = await page.getByRole("link", { name: /Download brief/ }).getAttribute("href");
  const json = await (await request.get(href!.replace("format=brief", "format=json"))).json();
  const text = await (await request.get(href!)).text();
  return { json, text };
}

let shotUrl: string;

test("no-3D project: empty → promote the approved Storyboard → fresh → the package uses it as the start frame", async ({
  page,
  request,
}) => {
  // the seed's approved Storyboard (3A) is a placeholder with no stored file: the action is disabled, truthfully, no crash
  const seeded = await openShot(page, "3A");
  await page.goto(`${seeded}?section=production_frame`);
  await expect(section(page).getByTestId("pf-use-storyboard")).toBeDisabled();
  await expect(section(page).getByTestId("pf-storyboard-reason")).toContainText("has not been uploaded yet");
  await expect(section(page).getByTestId("pf-empty")).toBeVisible();

  shotUrl = await openShot(page, "5A");

  // an approved storyboard frame with a REAL image (the seed's are placeholders): 478×200 is exactly 2.39:1
  await page.goto(`${shotUrl}?section=storyboard`);
  const sb = page.locator("#storyboard");
  await sb.locator("input[type=file]").setInputFiles({
    name: "e2e-pf-storyboard.png",
    mimeType: "image/png",
    buffer: png(478, 200, [200, 60, 60]),
  });
  await sb.getByRole("button", { name: "Add frame version" }).click();
  const row = sb.locator("form").filter({ hasText: /v2 · upload/ });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(
    sb
      .locator("form")
      .filter({ hasText: /v2 · upload/ })
      .getByRole("button", { name: /Approved/ }),
  ).toBeVisible();

  await page.goto(`${shotUrl}?section=production_frame`);
  const pf = section(page);
  await expect(pf.getByTestId("pf-empty")).toContainText("No Production Frame yet.");
  // no GPU / 3D messaging anywhere in the section: this project has neither and does not need them
  await expect(pf).not.toContainText(/3D|GPU|COLMAP|splat|reconstruction|Vulkan/i);
  await expect(pf.getByTestId("pf-use-storyboard")).toBeEnabled();

  await pf.getByTestId("pf-use-storyboard").click();
  const selected = pf.getByTestId("pf-selected");
  await expect(selected).toHaveAttribute("data-version", "1");
  await expect(selected).toHaveAttribute("data-source", "storyboard");
  await expect(selected).toHaveAttribute("data-freshness", "fresh");
  await expect(selected).toContainText("From Storyboard");
  await expect(selected).toContainText("2.39:1 · 478×200");
  // the private preview really renders (served by the authenticated asset route)
  await expect(pf.getByTestId("pf-preview")).toHaveJSProperty("naturalWidth", 478);
  await expect(page.getByTestId("rail-production-frame")).toContainText("Production Frame v1");

  const { json, text } = await packageOf(page, request, shotUrl);
  expect(json.packageSchemaVersion).toBe(4); // the current package shape (Phase 2G.3)
  expect(json.references.productionFrame).toMatchObject({
    version: 1,
    source: "storyboard",
    freshness: "fresh",
  });
  // the Production Frame is the start frame, and it REUSES the Storyboard's Asset (no duplicate Asset)
  expect(json.references.startFrameAssetId).toBe(json.references.productionFrame.assetId);
  expect(json.references.productionFrame.assetId).toBe(json.references.approvedStoryboardFrame.assetId);
  expect(json.assets[json.references.productionFrame.assetId]).toMatchObject({
    purpose: "storyboard",
    width: 478,
    height: 200,
  });
  expect(json).not.toHaveProperty("spatialReference");
  expect(text).toContain("Production Frame: v1 · From Storyboard · fresh");
  // by name and state only
  expect(text).not.toMatch(/objectPath|\/api\/assets|[0-9a-f]{64}/);
});

test("upload: a production-shaped image is selected; a wrong aspect or a non-image is refused; a repeat is not duplicated", async ({
  page,
  request,
}) => {
  await page.goto(`${shotUrl}?section=production_frame`);
  const pf = section(page);
  const upload = async (name: string, buffer: Buffer, mimeType = "image/png") => {
    await pf.getByTestId("pf-upload-file").setInputFiles({ name, mimeType, buffer });
    await pf.getByTestId("pf-upload-submit").click();
  };
  const items = pf.getByTestId("pf-history-item");
  await expect(items).toHaveCount(1);

  await upload("e2e-pf-upload.png", png(956, 400, [60, 120, 200]));
  const selected = pf.getByTestId("pf-selected");
  await expect(selected).toHaveAttribute("data-version", "2");
  await expect(selected).toHaveAttribute("data-source", "upload");
  await expect(selected).toContainText("Uploaded");
  await expect(selected).toContainText("956×400");
  await expect(pf.getByTestId("pf-preview")).toHaveJSProperty("naturalWidth", 956);
  await expect(items).toHaveCount(2);

  // a wrongly shaped image is refused, never cropped
  await upload("e2e-pf-wrong-shape.png", png(640, 360, [10, 10, 10]));
  await expect(pf.getByRole("alert")).toContainText("production frame is 2.39:1");
  await expect(pf.getByRole("alert")).toContainText("does not crop");
  await expect(items).toHaveCount(2);
  // a file that is not an image at all
  await upload("e2e-pf-fake.png", Buffer.from("this is not a png"));
  await expect(pf.getByRole("alert")).toBeVisible();
  await expect(items).toHaveCount(2);
  await expect(selected).toHaveAttribute("data-version", "2"); // every refusal left the selection alone

  // the same image again (same bytes, same visual intent) is not a new version
  await page.goto(`${shotUrl}?section=production_frame`);
  await upload("e2e-pf-upload.png", png(956, 400, [60, 120, 200]));
  await expect(items).toHaveCount(2);
  await expect(pf.getByTestId("pf-selected")).toHaveAttribute("data-version", "2");

  const { json } = await packageOf(page, request, shotUrl);
  expect(json.references.productionFrame).toMatchObject({ version: 2, source: "upload", freshness: "fresh" });
  expect(json.references.startFrameAssetId).toBe(json.references.productionFrame.assetId);
  expect(json.assets[json.references.productionFrame.assetId]).toMatchObject({
    purpose: "production_frame",
    width: 956,
  });
});

test("history: choosing another frame never deletes the others", async ({ page }) => {
  await page.goto(`${shotUrl}?section=production_frame`);
  const pf = section(page);
  const items = pf.getByTestId("pf-history-item");
  await expect(items).toHaveCount(2);
  // newest first
  await expect(items.first()).toHaveAttribute("data-version", "2");

  await pf.getByTestId("pf-select-1").click();
  await expect(pf.getByTestId("pf-selected")).toHaveAttribute("data-version", "1");
  await expect(items).toHaveCount(2);
  await expect(pf.getByTestId("pf-select-2")).toBeVisible();
  await expect(pf.getByTestId("pf-select-1")).toHaveCount(0); // the selected one has no "Use"

  await pf.getByTestId("pf-select-2").click();
  await expect(pf.getByTestId("pf-selected")).toHaveAttribute("data-version", "2");
  await expect(items).toHaveCount(2);
});

test("stale: a Shot change marks the selected frame stale (it stays selected), names what changed, and flags preflight", async ({
  page,
  request,
}) => {
  await page.goto(`${shotUrl}?section=lighting`);
  const mood = page.locator("#lighting input[name='lighting.mood']");
  const original = await mood.inputValue();
  await mood.fill("harsh noon sun");
  await page
    .locator("#lighting")
    .getByRole("button", { name: /Save lighting/i })
    .click();
  await expect(page.locator("#lighting")).toContainText("Saved");

  await page.goto(`${shotUrl}?section=production_frame`);
  const pf = section(page);
  const selected = pf.getByTestId("pf-selected");
  await expect(selected).toHaveAttribute("data-version", "2"); // never silently deselected
  await expect(selected).toHaveAttribute("data-freshness", "stale");
  await expect(pf.getByTestId("pf-stale")).toContainText("Lighting changed");
  await expect(pf.getByTestId("pf-stale")).toContainText("stays selected and is not changed");
  await expect(page.getByTestId("rail-production-frame")).toContainText("stale");
  // the frame's own record is history: it is still there, unchanged, with its image
  await expect(pf.getByTestId("pf-history-item")).toHaveCount(2);
  // preflight names the rule (a blocker for image-to-video, a warning otherwise)
  await expect(page.locator("aside").last()).toContainText(
    "Selected Production Frame matches the current shot",
  );

  const { json, text } = await packageOf(page, request, shotUrl);
  expect(json.references.productionFrame).toMatchObject({
    version: 2,
    freshness: "stale",
    changedParts: ["lighting"],
  });
  expect(text).toMatch(/Production Frame: v2 · Uploaded · stale/);
  expect(text).toMatch(/STALE: Lighting changed after this frame was made/);

  // restoring the Shot makes the same frame fresh again: nothing about the frame was ever rewritten
  await page.goto(`${shotUrl}?section=lighting`);
  await page.locator("#lighting input[name='lighting.mood']").fill(original);
  await page
    .locator("#lighting")
    .getByRole("button", { name: /Save lighting/i })
    .click();
  await expect(page.locator("#lighting")).toContainText("Saved");
  await page.goto(`${shotUrl}?section=production_frame`);
  await expect(section(page).getByTestId("pf-selected")).toHaveAttribute("data-freshness", "fresh");
});

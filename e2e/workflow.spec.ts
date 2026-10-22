import { expect, test, type Page } from "@playwright/test";

/**
 * Production workflow on the Japanese-drama seed, memory mode:
 *   script line → performance → Look/location → timing → storyboard → preflight → package/brief → animatic
 * Shot 3A "I Already Want to Go Home": 0.8s pre-roll + 2.8s selected take + 0.9s reaction = 4.5s.
 */

const EP = "/projects/ojousama/episodes/ep-1";

async function openShot(page: Page, code: string) {
  await page.goto(`${EP}/shots`);
  // Navigate by href (not click): the board is a client-side sortable and an early click can be swallowed.
  const href = await page.getByRole("link", { name: code, exact: true }).first().getAttribute("href");
  await page.goto(href!);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(code);
}

/** Opens a Shot Prep section if it is not already open (state survives a save). */
async function ensureOpen(page: Page, key: string) {
  const section = page.locator(`details#${key}`);
  if ((await section.getAttribute("open")) === null) await section.locator("summary").click();
  await expect(section).toHaveAttribute("open", "");
}

// 1×1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test("3A: performance, Look, set, explainable timing and readiness are all visible", async ({ page }) => {
  await openShot(page, "3A");

  // timing is explained segment by segment
  const timing = page.getByTestId("timing-list").last();
  await expect(timing).toContainText("0.00–0.80");
  await expect(timing).toContainText("Pre-roll / expression");
  await expect(timing).toContainText("0.80–3.60");
  await expect(timing).toContainText("Yumeko · selected Take 1");
  await expect(timing).toContainText("3.60–4.50");
  await expect(timing).toContainText("Reaction hold");
  await expect(timing).toContainText("4.50s");

  const rail = page.locator("aside").last();
  await expect(rail.getByText("READY TO GENERATE", { exact: true })).toBeVisible();

  // Look / set / source are resolved, not copied
  await ensureOpen(page, "look");
  await expect(page.locator("#look")).toContainText("Episode 1 — Formal Black");
  await ensureOpen(page, "set");
  await expect(page.locator("#set")).toContainText("Grand Celeste Lobby");
  await ensureOpen(page, "source");
  await expect(page.locator("#source")).toContainText("もう帰りたい");
  await expect(page.locator("#source")).toContainText("The lobby is hushed");
});

test("3A: generation brief renders and exports (text + JSON package)", async ({ page, request }) => {
  await openShot(page, "3A");
  await ensureOpen(page, "brief");
  const brief = page.getByTestId("generation-brief");
  await expect(brief).toContainText("Performance");
  await expect(brief).toContainText("READY TO GENERATE");
  await expect(brief).toContainText("Selected take #1");

  const href = await page.getByRole("link", { name: /Download brief/ }).getAttribute("href");
  const text = await (await request.get(href!)).text();
  expect(text).toContain("## Performance");
  expect(text).toContain("READY TO GENERATE");

  const json = await (await request.get(href!.replace("format=brief", "format=json"))).json();
  expect(json.packageSchemaVersion).toBe(4); // the current package shape (Phase 2G.3)
  expect(json.timing.durationMs).toBe(4500);
  expect(json.provenance.fingerprint).toMatch(/^[0-9a-f]{64}$/);
});

test("editing the camera after approval flags the storyboard as stale until re-approved", async ({
  page,
}) => {
  await openShot(page, "3A");
  await ensureOpen(page, "camera");
  const lens = page.locator("#camera input[name='composition.lens']");
  const original = await lens.inputValue();
  await lens.fill("135mm");
  await page
    .locator("#camera")
    .getByRole("button", { name: /Save camera/i })
    .click();
  await expect(page.getByRole("status")).toContainText("predates the current camera setup");

  // restore, then re-approve to clear the signal
  await ensureOpen(page, "camera");
  await page.locator("#camera input[name='composition.lens']").fill(original);
  await page
    .locator("#camera")
    .getByRole("button", { name: /Save camera/i })
    .click();
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("breakdown shows deterministic script coverage with an uncovered beat", async ({ page }) => {
  await page.goto(`${EP}/breakdown`);
  const scene6 = page.locator("#scene-6");
  await expect(scene6).toContainText("50%");
  await expect(scene6).toContainText("uncovered");
  await expect(page.locator("#scene-1")).toContainText("100%");
});

test("animatic plays: clock advances, scene/shot indicator and timing breakdown shown", async ({ page }) => {
  await page.goto(`${EP}/animatic`);
  await expect(page.getByText(/Runtime/).first()).toBeVisible();
  const time = page.getByTestId("animatic-time");
  await expect(time).toContainText("0:00.0");
  await page.getByRole("button", { name: "Play" }).click();
  await expect
    .poll(async () => (await time.textContent()) ?? "", { timeout: 8000 })
    .not.toContain("0:00.0 /");
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("Now playing")).toBeVisible();
  await expect(page.getByText("Timing").first()).toBeVisible();
  // keyboard: M toggles mute
  await page.keyboard.press("m");
  await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();
});

test("asset library: filter, search, upload, where-used, and persistence across reload", async ({ page }) => {
  await page.goto("/projects/ojousama/assets");
  await page.getByRole("link", { name: "Audio", exact: true }).click();
  await expect(page).toHaveURL(/filter=audio/);
  await page.getByLabel("Search assets").fill("take");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("tbody tr").first()).toBeVisible();

  // unsupported/executable upload is refused inline
  await page.goto("/projects/ojousama/assets");
  await page.locator("input[type=file]").setInputFiles({
    name: "setup.exe",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("MZ\u0090\u0000fakeexecutable"),
  });
  await page.getByRole("button", { name: "Upload asset" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /not allowed|Unsupported/ })).toBeVisible();

  // valid image uploads and appears in the library
  const name = `e2e-reference-${Date.now()}.png`;
  await page.locator("input[type=file]").setInputFiles({ name, mimeType: "image/png", buffer: PNG });
  await page.locator("select[name=purpose]").first().selectOption("generation_input");
  await page.getByRole("button", { name: "Upload asset" }).click();
  await expect(page.getByText("Saved").first()).toBeVisible();
  await page.reload();
  await page.getByLabel("Search assets").fill(name);
  await page.getByRole("button", { name: "Search" }).click();
  const row = page.locator("tbody tr", { hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText("unused");

  // unused assets can be deleted; the detail pane explains usage
  await row.getByRole("link").first().click();
  await expect(page.getByText(/Where used/)).toBeVisible();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Delete asset" }).click();
  await expect(page.locator("tbody tr", { hasText: name })).toHaveCount(0);
});

test("an asset that is in use cannot be deleted", async ({ page }) => {
  await page.goto("/projects/ojousama/assets?filter=audio");
  await page.locator("tbody tr").first().getByRole("link").first().click();
  await expect(page.getByText(/In use — remove its references first/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete asset" })).toHaveCount(0);
});

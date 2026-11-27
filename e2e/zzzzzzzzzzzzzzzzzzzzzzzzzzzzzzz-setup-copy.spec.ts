import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 4D — "Copy setup from…": explicit copies, never live links. Memory mode (its own server), the real renderer
 * (SwiftShader), the real UI and server actions. No provider call, no generated media.
 *
 *   A  Shot 1A builds a setup on the shared set (camera, blocking, lighting)
 *   B  Shot 1B reviews the copy (what is copied, what it replaces), confirms, and owns identical values
 *   C  editing the source afterwards does not change the destination; editing the destination does not change the source
 *   D  the destination captures a Master Frame from its own copied state
 *   E  (4D-I2) Shot 1A saves its setup as a named template
 *   F  Shot 1B reviews "Copy from template", applies it, and is told it now owns its own copy; history records it
 *   G  editing the destination leaves the template unchanged
 *   H  replacing the template's values leaves the destination unchanged
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
type ShotRef = { code: string; id: string; spatialUrl: string };

async function shotOf(page: Page, code: string): Promise<ShotRef> {
  await page.goto(`${EP}/shots`);
  const href = (await page.getByRole("link", { name: code, exact: true }).first().getAttribute("href"))!;
  const id = /\/shots\/([0-9a-f-]{36})/.exec(href)![1]!;
  return { code, id, spatialUrl: `${EP}/shots/${id}/spatial` };
}

const set = (page: Page) => page.getByTestId("virtual-set");
async function open(page: Page, s: ShotRef) {
  await page.goto(s.spatialUrl);
  await expect(set(page)).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
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
const lightingFp = async (page: Page) =>
  (await page.getByTestId("shot-lighting").getAttribute("data-saved-fingerprint")) ?? "";
const figures = (page: Page) =>
  page
    .getByTestId("blocking-figure")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-character-id")).sort());

let A: ShotRef;
let B: ShotRef;
let aLight = "";
let aFigures: (string | null)[] = [];

test("A — the source Shot builds a setup on the shared set", async ({ page }) => {
  test.setTimeout(300_000);
  A = await shotOf(page, "1A");
  B = await shotOf(page, "1B");
  await open(page, A);
  await page.getByTestId("load-test-set").click();
  await expect(page.getByTestId("set-status")).toContainText("Hotel Canopy", { timeout: 30_000 });
  await setInput(page, "camera-pos-x", "1");
  await page.getByTestId("save-set").click();
  await expect(page.getByTestId("set-status")).toContainText("3D Set created", { timeout: 30_000 });
  await page.getByTestId("link-shot-camera").click();
  await expect(page.getByTestId("set-status")).toContainText("linked", { timeout: 30_000 });
  await page.getByTestId("blocking-character").selectOption({ label: "Yumeko" });
  await page.getByTestId("add-character-proxy").click();
  await setInput(page, "blocking-pos-x", "2");
  await page.getByTestId("save-blocking").click();
  await expect(page.getByTestId("blocking-status")).toContainText("Character blocking saved", {
    timeout: 60_000,
  });
  await saveLight(page, "200");
  aLight = await lightingFp(page);
  aFigures = await figures(page);
  expect(aLight).not.toBe("");
  expect(aFigures).toHaveLength(1);
});

test("B — the destination reviews exactly what is copied, confirms, and owns identical values", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await open(page, B);
  expect(await lightingFp(page)).toBe("");
  const source = page.getByTestId("copy-setup-source");
  await expect(source.locator("option", { hasText: "Shot 1A" })).toHaveCount(1);
  await source.selectOption({
    label: (await source.locator("option", { hasText: "Shot 1A" }).textContent())!,
  });
  const preview = page.getByTestId("copy-setup-preview");
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("copy-setup-camera")).toBeChecked();
  await expect(page.getByTestId("copy-setup-lighting")).toBeChecked();
  await expect(page.getByTestId("copy-setup-blocking")).toBeChecked();
  await expect(page.getByTestId("copy-setup-camera-line")).toContainText("this Shot has no camera yet");
  await expect(page.getByTestId("copy-setup-lighting-line")).toContainText("1 light");
  await expect(page.getByTestId("copy-setup-lighting-line")).toContainText(aLight.slice(0, 8));
  await expect(page.getByTestId("copy-setup-blocking-line")).toContainText("Yumeko");
  // nothing is written by the review
  expect(await lightingFp(page)).toBe("");

  await page.getByTestId("copy-setup-confirm").click();
  await page.waitForURL(/copiedFrom=/, { timeout: 30_000 });
  await expect(page.getByTestId("copy-setup-done")).toContainText(
    "Copied camera, lighting, blocking from Shot 1A",
  );
  await expect(page.getByTestId("copy-setup-done")).toContainText("will not change it");
  await expect(set(page)).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(page.getByTestId("shot-lighting")).toHaveAttribute("data-loaded", "true", { timeout: 30_000 });
  await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
    timeout: 30_000,
  });
  expect(await lightingFp(page)).toBe(aLight);
  expect(await figures(page)).toEqual(aFigures);
  await expect(page.getByTestId("bookmark-info")).toBeVisible();
  // the same copy again is a no-op and says so
  await source.selectOption({
    label: (await source.locator("option", { hasText: "Shot 1A" }).textContent())!,
  });
  await expect(page.getByTestId("copy-setup-confirm")).toHaveText("Already identical", { timeout: 30_000 });
  await expect(page.getByTestId("copy-setup-confirm")).toBeDisabled();
});

test("C — independence both ways: no edit on one Shot reaches the other", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page, A);
  await saveLight(page, "500");
  const aNew = await lightingFp(page);
  expect(aNew).not.toBe(aLight);
  await open(page, B);
  expect(await lightingFp(page)).toBe(aLight); // the copy did not follow the source
  await saveLight(page, "50");
  const bNew = await lightingFp(page);
  expect(bNew).not.toBe(aLight);
  await open(page, A);
  expect(await lightingFp(page)).toBe(aNew); // and the destination's edit did not reach the source
});

test("D — the destination captures a Master Frame from its own copied state", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page, B);
  await page.getByTestId("capture-master-frame").click();
  await expect(page.getByTestId("set-status")).toContainText("Master frame saved", { timeout: 60_000 });
  await expect(page.getByTestId("master-frame")).toHaveCount(1, { timeout: 30_000 });
});

const templateRow = (page: Page) => page.getByTestId("setup-template").filter({ hasText: "Night key" });
const templateFp = async (page: Page) =>
  (await templateRow(page).getAttribute("data-content-fingerprint")) ?? "";
let tFp = "";

test("E — the source Shot saves its setup as a named template", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page, A);
  await page.getByTestId("template-name").fill("Night key");
  for (const c of ["camera", "lighting", "blocking"])
    await expect(page.getByTestId(`template-include-${c}`)).toBeChecked();
  await page.getByTestId("template-save").click();
  await expect(templateRow(page)).toHaveCount(1, { timeout: 30_000 });
  await expect(templateRow(page)).toContainText("camera, lighting, blocking");
  await expect(templateRow(page)).toContainText("saved from Shot 1A");
  tFp = await templateFp(page);
  expect(tFp).toMatch(/^[0-9a-f]{64}$/);
});

test("F — the destination copies from the template after a review, and owns its own copy", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await open(page, B);
  const bBefore = await lightingFp(page);
  const source = page.getByTestId("copy-setup-source");
  await source.selectOption({ label: "Template: Night key" });
  await expect(page.getByTestId("copy-setup-preview")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("copy-setup-from")).toContainText("Night key");
  await expect(page.getByTestId("copy-setup-lighting-line")).toContainText("replaces this Shot's lighting");
  expect(await lightingFp(page)).toBe(bBefore); // the review wrote nothing
  await page.getByTestId("copy-setup-confirm").click();
  await page.waitForURL(/copiedTemplate=/, { timeout: 30_000 });
  await expect(page.getByTestId("copy-setup-done")).toContainText(
    "from Night key; this Shot now owns its own copy",
  );
  await expect(set(page)).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(page.getByTestId("shot-lighting")).toHaveAttribute("data-loaded", "true", { timeout: 30_000 });
  await open(page, A);
  const aLightNow = await lightingFp(page);
  await open(page, B);
  expect(await lightingFp(page)).toBe(aLightNow); // the template held A's values when it was saved
  await expect(page.getByTestId("setup-copy-history-line").first()).toContainText(
    "copied from template “Night key”",
  );
});

test("G — editing the destination leaves the template unchanged", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page, B);
  await saveLight(page, "7");
  await open(page, A);
  expect(await templateFp(page)).toBe(tFp);
});

test("H — replacing the template's values leaves the destination unchanged", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page, B);
  const bLight = await lightingFp(page);
  await open(page, A);
  await saveLight(page, "900");
  await templateRow(page).getByTestId("template-replace").click();
  await expect.poll(() => templateFp(page), { timeout: 30_000 }).not.toBe(tFp);
  await open(page, B);
  expect(await lightingFp(page)).toBe(bLight);
});

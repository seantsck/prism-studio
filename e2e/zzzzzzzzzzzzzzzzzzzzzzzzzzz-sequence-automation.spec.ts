import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * Phase 3A.4F automatic Sequence Continuity, memory mode, through the UI. ISOLATED STORE (its own Playwright project and
 * memory server, playwright.config.ts port 3110), with Gemini on its FAKE transport and a settling window this server
 * shortens to 15 s (memory + fake transport only; production is frozen at 10 minutes).
 *
 *   clips pinned on 2C, 2D, 2E → off queues nothing → Shot automatic alone queues nothing → Sequence Suggest shows what is
 *   due and queues nothing → Sequence Automatic needs its own confirmation → a change restarts settling, so nothing queues
 *   → after the window a visit queues one bounded wave → the poller refreshes and the next wave follows → results persist,
 *   eyeline stays unchecked → off stops new waves. No provider network (REAL GEMINI / OPENAI / GENERATION CALLS: 0).
 */

const P = "/projects/ojousama";
const EP = `${P}/episodes/ep-1`;
const CUT_A = "2C → 2D";
const CUT_B = "2D → 2E";
const SETTLE_MS = 15_000;
test.describe.configure({ mode: "serial" });

const item = (page: Page, code: string) =>
  page.locator(`[data-testid="edit-item"][data-shot-code="${code}"]`);
const row = (page: Page, title: string) =>
  page.locator('[data-testid="cut-row"]', {
    has: page.getByTestId("cut-title").getByText(title, { exact: true }),
  });
const expectRevision = (page: Page, n: number) =>
  expect(page.getByTestId("edit-revision")).toHaveText(`Revision ${n}`, { timeout: 15_000 });
async function openEditor(page: Page, code: string) {
  const editor = item(page, code).getByTestId("item-editor");
  if (!(await editor.evaluate((d) => (d as HTMLDetailsElement).open)))
    await editor.locator("summary").click();
  return editor;
}
function external(page: Page): Request[] {
  const out: Request[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") out.push(r);
  });
  return out;
}
async function generateAndPin(page: Page, code: string, revision: number) {
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: code, exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  await page.goto(`${page.url().split("?")[0]}?section=generate`);
  await expect(page.getByTestId("generate-workspace")).toBeVisible();
  await page.getByTestId("model-select").selectOption("mock/mock-video-169");
  await page.getByTestId("framing-select").selectOption("overscan_for_crop");
  await page.getByTestId("duration-select").selectOption("generate_longer_then_trim");
  for (const box of await page.locator('input[name="ack"]').all()) await box.check();
  await page.getByTestId("generate-button").click();
  await expect(page.getByTestId("shot-generation-state")).toHaveText("READY FOR REVIEW", { timeout: 60_000 });
  await page.goto(`${EP}/edit`);
  const editor = await openEditor(page, code);
  await editor.getByTestId("source-option").filter({ hasText: "Generation #1" }).locator("input").check();
  await editor.getByTestId("pin-source").click();
  await expectRevision(page, revision);
}
const runs = (page: Page) => page.getByTestId("cut-run");
async function saved(page: Page) {
  await page.getByTestId("qa-policy-save").click();
  await expect(page.getByText("Shot QA policy saved")).toBeVisible();
}

test("setup: a persisted edit with free mock clips pinned on 2C, 2D and 2E", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(`${EP}/edit`);
  await page.getByTestId("create-episode-edit").click();
  await expect(page.getByTestId("episode-edit-persisted")).toBeVisible();
  await expectRevision(page, 0);
  await generateAndPin(page, "2C", 1);
  await generateAndPin(page, "2D", 2);
  await generateAndPin(page, "2E", 3);
});

test("the policy UI: Sequence defaults Off, its controls are separate, and the permission copy names both uses", async ({
  page,
}) => {
  await page.goto(`${P}/qa`);
  await expect(page.getByTestId("qa-sequence-mode-off")).toBeChecked();
  await expect(page.getByTestId("qa-mode-off")).toBeChecked();
  await expect(page.getByTestId("qa-sequence-batch")).toHaveValue("20");
  await expect(page.getByTestId("qa-sequence-batch")).toHaveAttribute("max", "20");
  const copy = page.getByTestId("qa-temporal");
  await expect(copy).toContainText("full selected delivery video");
  await expect(copy).toContainText("cut-edge clips of the output pinned in the Episode Edit");
  await page.getByTestId("qa-analyzer").selectOption("gemini");
  await expect(page.getByTestId("qa-sequence-state")).toContainText("9 cut families accepted");
  await expect(page.getByTestId("qa-sequence-state")).toContainText("eyeline unavailable");
});

test("off: a plain load queues nothing, whatever other permissions say", async ({ page }) => {
  const out = external(page);
  await page.goto(`${EP}/continuity`);
  await expect(page.getByTestId("sequence-auto-mode")).toHaveText("Off");
  await expect(runs(page)).toHaveCount(0);
  await expect(page.getByTestId("sequence-auto-reconcile")).toHaveCount(0);
  await page.reload();
  await expect(runs(page)).toHaveCount(0);
  expect(out).toEqual([]);
});

test("Shot automatic alone changes neither the Sequence mode nor the cuts", async ({ page }) => {
  await page.goto(`${P}/qa`);
  await page.getByTestId("qa-mode-automatic").check();
  await page.getByTestId("qa-analyzer").selectOption("gemini");
  await page.getByTestId("qa-max-run").fill("0.50");
  await page.getByTestId("qa-max-day").fill("5");
  await page.getByTestId("qa-media-consent").setChecked(true);
  await page.getByTestId("qa-direct-video").setChecked(true);
  await page.getByTestId("qa-confirm-automatic").check();
  await saved(page);
  await page.goto(`${P}/qa`);
  await expect(page.getByTestId("qa-mode-automatic")).toBeChecked();
  await expect(page.getByTestId("qa-sequence-mode-off")).toBeChecked();
  await page.goto(`${EP}/continuity`);
  await expect(page.getByTestId("sequence-auto-mode")).toHaveText("Off");
  await expect(runs(page)).toHaveCount(0);
  // and back: changing it does not touch Sequence either
  await page.goto(`${P}/qa`);
  await page.getByTestId("qa-mode-off").check();
  await saved(page);
});

test("suggest: due cuts and a review batch through the manual disclosure; nothing is queued", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const out = external(page);
  await page.goto(`${P}/qa`);
  await page.getByTestId("qa-sequence-mode-suggest").check();
  await saved(page);
  await page.goto(`${P}/qa`);
  await expect(page.getByTestId("qa-mode-off")).toBeChecked();
  await expect(page.getByTestId("qa-sequence-mode-suggest")).toBeChecked();

  await expect(async () => {
    await page.goto(`${EP}/continuity`);
    await expect(page.getByTestId("sequence-auto-due")).toHaveText("2", { timeout: 2000 });
  }).toPass({ timeout: SETTLE_MS * 3 });
  await expect(page.getByTestId("sequence-auto-mode")).toHaveText("Suggest");
  await expect(page.getByTestId("sequence-auto-cost")).toContainText("Estimated worst case $");
  await expect(runs(page)).toHaveCount(0);
  await page.getByTestId("sequence-auto-review").click();
  await expect(page.getByTestId("sequence-review")).toBeVisible();
  await expect(page.getByTestId("review-cut-count")).toHaveText("2");
  await expect(page.getByTestId("review-submit")).toBeVisible();
  // reading it created nothing
  await page.goto(`${EP}/continuity`);
  await expect(runs(page)).toHaveCount(0);
  expect(out).toEqual([]);
});

test("automatic needs its OWN confirmation, which the Shot one does not satisfy", async ({ page }) => {
  await page.goto(`${P}/qa`);
  await page.getByTestId("qa-sequence-mode-automatic").check();
  await page.getByTestId("qa-sequence-batch").fill("1");
  const terms = page.getByTestId("qa-sequence-automatic-confirm");
  await expect(terms).toContainText("last ~2 seconds of the left output pinned");
  await expect(terms).toContainText("first ~2 seconds of the right output pinned");
  await expect(terms).toContainText("audio stripped");
  await expect(terms).toContainText("temporary provider file");
  await expect(terms).toContainText("Eyeline stays unavailable");
  await page.getByTestId("qa-policy-save").click();
  await expect(page.getByText("Confirm the Sequence Continuity standing authorisation")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("qa-sequence-mode-suggest")).toBeChecked();
  await page.getByTestId("qa-sequence-mode-automatic").check();
  await page.getByTestId("qa-sequence-batch").fill("1");
  await page.getByTestId("qa-confirm-sequence-automatic").check();
  await saved(page);
});

test("automatic: a change restarts settling and nothing queues; after the window, one bounded wave and then the next", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const out = external(page);
  await page.goto(`${P}/qa`);
  await expect(page.getByTestId("qa-sequence-mode-automatic")).toBeChecked();
  await expect(page.getByTestId("qa-sequence-batch")).toHaveValue("1");

  // a trim of the shared item restarts both cuts' clocks; an edit write itself never submits anything
  await page.goto(`${EP}/edit`);
  const before = Number((await page.getByTestId("edit-revision").innerText()).replace(/\D/g, ""));
  const editor = await openEditor(page, "2D");
  await editor.getByTestId("trim-in").fill("0");
  await editor.getByTestId("trim-out").fill("4.9");
  await editor.getByTestId("apply-trim").click();
  await expectRevision(page, before + 1);
  await page.goto(`${EP}/continuity`);
  await expect(page.getByTestId("sequence-auto-mode")).toHaveText("Automatic");
  await expect(page.getByTestId("sequence-auto-settling")).toHaveText("2");
  await expect(runs(page)).toHaveCount(0);

  // no timer exists: staying on the page submits nothing; a later visit, past the window, does
  await page.waitForTimeout(SETTLE_MS + 1000);
  await expect(runs(page)).toHaveCount(0);
  await page.reload();
  await expect(async () => {
    await page.goto(`${EP}/continuity`);
    await expect(runs(page)).toHaveCount(2, { timeout: 2000 });
  }).toPass({ timeout: 120_000 });
  await expect(async () => {
    await page.goto(`${EP}/continuity`);
    for (const cut of [CUT_A, CUT_B])
      await expect(row(page, cut).getByTestId("cut-run").first()).toHaveAttribute("data-status", "Complete", {
        timeout: 2000,
      });
  }).toPass({ timeout: 120_000 });
  expect(out).toEqual([]);
});

test("the results persist, eyeline stays unchecked, and repeat visits create nothing", async ({ page }) => {
  await page.goto(`${EP}/continuity`);
  const r = row(page, CUT_A);
  await expect(r.getByTestId("cut-run")).toHaveCount(1);
  expect(await r.getByTestId("cut-finding-analyzed").count()).toBeGreaterThan(0);
  await expect(page.getByTestId("sequence-auto-covered")).toHaveText("2");
  await expect(page.getByTestId("sequence-auto-due")).toHaveText("0");
  await r
    .locator("details")
    .first()
    .evaluate((d) => ((d as HTMLDetailsElement).open = true));
  const eyeline = r.locator('[data-criterion="cut:eyeline"]');
  if (await eyeline.count()) await expect(eyeline.first()).not.toContainText("Pass");
  await page.reload();
  await expect(runs(page)).toHaveCount(2);
});

test("off stops new waves; history stays; manual review stays available", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${P}/qa`);
  await page.getByTestId("qa-sequence-mode-off").check();
  await saved(page);
  await page.goto(`${EP}/edit`);
  const before = Number((await page.getByTestId("edit-revision").innerText()).replace(/\D/g, ""));
  const editor = await openEditor(page, "2E");
  await editor.getByTestId("trim-in").fill("0");
  await editor.getByTestId("trim-out").fill("4.8");
  await editor.getByTestId("apply-trim").click();
  await expectRevision(page, before + 1);
  await page.waitForTimeout(SETTLE_MS + 1000);
  await page.goto(`${EP}/continuity`);
  await expect(page.getByTestId("sequence-auto-mode")).toHaveText("Off");
  await page.reload();
  await expect(runs(page)).toHaveCount(2);
  await expect(page.getByTestId("sequence-review-prepare")).toBeVisible();
});

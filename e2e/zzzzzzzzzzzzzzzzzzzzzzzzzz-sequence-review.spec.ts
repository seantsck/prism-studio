import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * Phase 3A.4D manual Sequence Continuity review, memory mode, through the UI. ISOLATED STORE (its own Playwright project
 * and memory server, playwright.config.ts port 3109).
 *
 *   persisted edit → free mock clips pinned on 2D and 2E → the Supervisor shows NO semantic run and a GET of it creates
 *   nothing → with direct-video consent off the disclosure blocks → consent on → select the 2D → 2E cut → the exact
 *   disclosure → confirm → edge media derived, a transition job queued and executed by the in-process worker with the
 *   MOCK analyzer → semantic findings with sided evidence and the exact edge media → kept on reload. The edit revision
 *   never changes. No provider network: the free MockProvider only (REAL GEMINI / OPENAI / GENERATION CALLS: 0).
 */

const P = "/projects/ojousama";
const EP = `${P}/episodes/ep-1`;
const CUT = "2D → 2E";
test.describe.configure({ mode: "serial" });

const item = (page: Page, code: string) =>
  page.locator(`[data-testid="edit-item"][data-shot-code="${code}"]`);
const row = (page: Page) =>
  page.locator('[data-testid="cut-row"]', {
    has: page.getByTestId("cut-title").getByText(CUT, { exact: true }),
  });
const expectRevision = (page: Page, n: number) =>
  expect(page.getByTestId("edit-revision")).toHaveText(`Revision ${n}`, { timeout: 15_000 });
async function openEditor(page: Page, code: string) {
  const editor = item(page, code).getByTestId("item-editor");
  if (!(await editor.evaluate((d) => (d as HTMLDetailsElement).open)))
    await editor.locator("summary").click();
  return editor;
}
/** Every request the browser sends outside this app (there must be none). */
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
  // the free mock 16:9 model, generated longer then trimmed: any production duration is valid
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

test("setup: a persisted edit with free mock clips pinned on 2D and 2E", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`${EP}/edit`);
  await page.getByTestId("create-episode-edit").click();
  await expect(page.getByTestId("episode-edit-persisted")).toBeVisible();
  await expectRevision(page, 0);
  await generateAndPin(page, "2D", 1);
  await generateAndPin(page, "2E", 2);
});

test("read purity: the Supervisor shows no semantic run; reading it (and a disclosure) creates nothing", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const out = external(page);
  await page.goto(`${EP}/continuity`);
  const r = row(page);
  await expect(r).toHaveAttribute("data-media-eligible", "true");
  await expect(r.getByTestId("cut-state")).toHaveText("No sequence QA yet");
  await expect(r.getByTestId("cut-runs")).toHaveCount(0);
  await expect(r.getByTestId("cut-finding-analyzed")).toHaveCount(0);
  // a disclosure is a GET: nothing is derived or queued by it
  await r.getByTestId("cut-review-select").check();
  await page.getByTestId("sequence-review-prepare").click();
  await expect(page.getByTestId("sequence-review")).toBeVisible();
  await page.reload();
  await expect(row(page).getByTestId("cut-runs")).toHaveCount(0);
  await expect(row(page).getByTestId("cut-state")).toHaveText("No sequence QA yet");
  await expect(page.getByTestId("continuity-revision")).toHaveText("Edit revision 2");
  expect(out).toEqual([]);
});

test("without direct-video consent the disclosure blocks the review (nothing is sent)", async ({ page }) => {
  await page.goto(`${EP}/continuity`);
  await row(page).getByTestId("cut-review-select").check();
  await page.getByTestId("sequence-review-prepare").click();
  await expect(page.getByTestId("review-blockers")).toContainText("has not allowed bounded video");
  await expect(page.getByTestId("review-submit")).toHaveCount(0);
});

test("server video gate off: accepted families still cannot run on Gemini; nothing can be submitted or sent", async ({
  page,
}) => {
  const out = external(page);
  await page.goto(`${EP}/continuity`);
  await row(page).getByTestId("cut-review-select").check();
  await page.getByTestId("sequence-review-analyzer").selectOption("gemini");
  await page.getByTestId("sequence-review-prepare").click();
  await expect(page.getByTestId("review-analyzer")).toContainText("Gemini");
  await expect(page.getByTestId("review-blockers")).toContainText("no cut criterion can be analysed");
  await expect(page.getByTestId("review-submit")).toHaveCount(0);
  await expect(row(page).getByTestId("cut-runs")).toHaveCount(0);
  expect(out).toEqual([]);
});

test("consent on → exact disclosure → confirm → mock review runs; findings with sided evidence persist", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const out = external(page);
  await page.goto(`${P}/qa`);
  await page.getByTestId("qa-direct-video").setChecked(true);
  await page.getByTestId("qa-policy-save").click();
  await expect(page.getByTestId("qa-direct-video")).toBeChecked();

  await page.goto(`${EP}/continuity`);
  await row(page).getByTestId("cut-review-select").check();
  await page.getByTestId("sequence-review-analyzer").selectOption("mock-continuity");
  await page.getByTestId("sequence-review-prepare").click();
  const d = page.getByTestId("sequence-review");
  await expect(d).toBeVisible();
  await expect(page.getByTestId("review-cut-count")).toHaveText("1");
  await expect(page.getByTestId("review-audio")).toHaveText("not sent");
  await expect(page.getByTestId("review-cost")).toHaveText("$0.0000");
  await expect(d.getByTestId("review-left")).toContainText("2D");
  await expect(d.getByTestId("review-left")).toContainText("edge window");
  await expect(d.getByTestId("review-left")).toContainText("last displayed frame");
  await expect(d.getByTestId("review-right")).toContainText("first displayed frame");
  await expect(page.getByTestId("review-blockers")).toHaveCount(0);

  await page.getByTestId("review-confirm").check();
  await page.getByTestId("review-submit").click();
  // the in-process demo worker executes the queued job with the MOCK analyzer
  await expect(async () => {
    await page.goto(`${EP}/continuity`);
    await expect(row(page).getByTestId("cut-run").first()).toHaveAttribute("data-status", "Complete");
  }).toPass({ timeout: 60_000 });
  const r = row(page);
  await expect(r.getByTestId("cut-state")).not.toHaveText("No sequence QA yet");
  await expect(r.getByTestId("cut-run").first()).toHaveAttribute("data-freshness", "current");
  await expect(r.getByTestId("cut-run-edge-media").locator("figure")).toHaveCount(4);
  const analysed = r.getByTestId("cut-finding-analyzed");
  expect(await analysed.count()).toBeGreaterThan(0);
  await expect(analysed.first()).toHaveText("MOCK ANALYSIS");
  const ev = r.getByTestId("cut-finding-evidence").first();
  await expect(ev.locator('[data-side="left"]')).not.toHaveCount(0);
  await expect(ev.locator('[data-side="right"]')).not.toHaveCount(0);
  // the run is history: kept on reload; the edit itself never changed
  await page.reload();
  await expect(row(page).getByTestId("cut-run")).toHaveCount(1);
  await expect(page.getByTestId("continuity-revision")).toHaveText("Edit revision 2");
  expect(out).toEqual([]);
});

test("truth reversion: a trim makes the run stale; restoring the exact trim makes the SAME run current again", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const out = external(page);
  await page.goto(`${EP}/edit`);
  let editor = await openEditor(page, "2D");
  const originalIn = await editor.getByTestId("trim-in").inputValue();
  const originalOut = await editor.getByTestId("trim-out").inputValue();
  await editor.getByTestId("trim-out").fill(String(Number(originalOut) - 0.5));
  await editor.getByTestId("apply-trim").click();
  await expectRevision(page, 3);

  await page.goto(`${EP}/continuity`);
  await expect(row(page).getByTestId("cut-state")).toHaveText("Sequence QA stale");
  await expect(row(page).getByTestId("cut-run").first()).toHaveAttribute("data-freshness", "stale");
  await expect(row(page).getByTestId("cut-finding-analyzed")).toHaveCount(0);

  await page.goto(`${EP}/edit`);
  editor = await openEditor(page, "2D");
  await editor.getByTestId("trim-in").fill(originalIn);
  await editor.getByTestId("trim-out").fill(originalOut);
  await editor.getByTestId("apply-trim").click();
  await expectRevision(page, 4);

  await page.goto(`${EP}/continuity`);
  await expect(row(page).getByTestId("cut-run")).toHaveCount(1); // no new run was created by either edit
  await expect(row(page).getByTestId("cut-run").first()).toHaveAttribute("data-freshness", "current");
  await expect(row(page).getByTestId("cut-state")).not.toHaveText("Sequence QA stale");
  expect(await row(page).getByTestId("cut-finding-analyzed").count()).toBeGreaterThan(0);
  expect(out).toEqual([]);
});

test("the disclosure carries the exact transfer method (mock: not sent) into the confirmation", async ({
  page,
}) => {
  await page.goto(`${EP}/continuity`);
  await row(page).getByTestId("cut-review-select").check();
  await page.getByTestId("sequence-review-analyzer").selectOption("mock-continuity");
  await page.getByTestId("sequence-review-prepare").click();
  const transfers = page.getByTestId("review-transfer");
  await expect(transfers).toHaveCount(2);
  for (const t of await transfers.all()) await expect(t).toHaveAttribute("data-transfer", "not_sent");
  const cut = await page.locator('input[name="cut"]').first().getAttribute("value");
  expect(cut?.split("|").slice(-2)).toEqual(["not_sent", "not_sent"]);
  // reading the disclosure again created nothing
  await expect(row(page).getByTestId("cut-run")).toHaveCount(1);
});

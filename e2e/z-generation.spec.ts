import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 2A acceptance flow with the MockProvider (no external calls, no cost). Memory mode: the demo server
 * runs the same worker loop in-process. Runs last (z- prefix) because it adds generation history to shot 3A.
 */
const EP = "/projects/ojousama/episodes/ep-1";

async function openGenerate(page: Page) {
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: "3A", exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  const base = page.url().split("?")[0]!;
  await page.goto(`${base}?section=generate`);
  await expect(page.getByTestId("generate-workspace")).toBeVisible();
  return base;
}

const state = (page: Page) => page.getByTestId("shot-generation-state");

test.describe.configure({ mode: "serial" });

test("3A: compatibility, cost and blockers are explicit before anything is generated", async ({ page }) => {
  await openGenerate(page);
  await expect(state(page)).toHaveText("READY");
  await expect(page.getByTestId("model-select")).toHaveValue("mock/mock-video-1");

  // capable model: pass, 4.5 s accepted unchanged, cost estimated from declared pricing
  await expect(page.getByTestId("compat-summary")).toContainText("PASS");
  await expect(page.getByTestId("duration-compat")).toContainText("Production 4.5s");
  await expect(page.getByTestId("estimated-cost")).toContainText("$0.225");
  await expect(page.getByTestId("generate-button")).toBeEnabled();

  // limited model: duration is NOT silently rounded; generate is disabled with a reason
  await page.getByTestId("model-select").selectOption("mock/mock-video-lite");
  await expect(page.getByTestId("generate-blockers")).toContainText("Production duration 4.5s");
  await expect(page.getByTestId("generate-blockers")).toContainText("5s, 10s");
  await expect(page.getByTestId("generate-button")).toBeDisabled();
  await expect(page.getByTestId("ignored-features")).toContainText("Performed audio");
});

test("3A: generate → queued → generating → ready for review → reject → generate again → approve", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const base = await openGenerate(page);

  // 1. Generate attempt 1
  await page.getByTestId("generate-button").click();
  await expect(page.getByTestId("attempt-card")).toHaveCount(1, { timeout: 15_000 });
  await expect(state(page)).toHaveText(/QUEUED|GENERATING|READY FOR REVIEW/);

  // 2. The worker finishes it; the page updates itself
  await expect(state(page)).toHaveText("READY FOR REVIEW", { timeout: 60_000 });
  const card1 = page.locator('[data-testid="attempt-card"][data-attempt="1"]');
  await expect(card1.getByTestId("job-status")).toContainText("Complete");
  await expect(card1.getByTestId("output-video")).toBeVisible();
  await expect(card1.getByTestId("attempt-cost")).toContainText("Actual $0.225");

  // 3. The output is real, private, and served through the authorised route
  const src = await card1.getByTestId("output-video").getAttribute("src");
  expect(src).toMatch(/^\/api\/assets\/[0-9a-f-]{36}$/);
  const res = await page.request.get(src!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("video/webm");
  expect((await res.body()).length).toBeGreaterThan(5000);

  // 4. Reject attempt 1 with structured reasons
  await card1.getByTestId("reject-toggle").click();
  await card1.getByLabel("Identity drift").check();
  await card1.getByLabel("Bad motion").check();
  await card1.getByPlaceholder("What is wrong?").fill("Yumeko's face changes mid-shot");
  await card1.getByTestId("reject-submit").click();
  await expect(card1.getByTestId("review-status")).toContainText("rejected", { timeout: 15_000 });
  await expect(card1.getByTestId("rejection-info")).toContainText("Identity drift");
  await expect(state(page)).toHaveText("NEEDS REDO");

  // 5. Generate again: a NEW attempt, attempt 1 untouched
  await page.getByTestId("generate-button").click();
  const card2 = page.locator('[data-testid="attempt-card"][data-attempt="2"]');
  await expect(card2).toBeVisible({ timeout: 15_000 });
  await expect(state(page)).toHaveText("READY FOR REVIEW", { timeout: 60_000 });

  // 6. Approve attempt 2
  await card2.getByTestId("approve-button").click();
  await expect(state(page)).toHaveText("APPROVED", { timeout: 15_000 });
  await expect(card2.getByTestId("review-status")).toContainText("approved");
  await expect(card1.getByTestId("review-status")).toContainText("rejected");

  // 7. Reload: history and the approved result persist
  await page.goto(`${base}?section=generate`);
  await expect(state(page)).toHaveText("APPROVED");
  await expect(page.getByTestId("attempt-card")).toHaveCount(2);
  await expect(page.locator('[data-testid="attempt-card"][data-attempt="2"]')).toHaveAttribute(
    "data-review",
    "approved",
  );
  await expect(page.locator('[data-testid="attempt-card"][data-attempt="1"]')).toHaveAttribute(
    "data-review",
    "rejected",
  );
});

test("attempt 1's frozen brief and job timeline still open, and compare shows what differs", async ({
  page,
}) => {
  // several first-time route compiles in the dev server; give the navigation chain room
  test.setTimeout(120_000);
  await openGenerate(page);
  const card1 = page.locator('[data-testid="attempt-card"][data-attempt="1"]');
  await card1.getByTestId("open-brief").click();
  await expect(page.getByRole("heading", { name: /Attempt 1/ })).toBeVisible();
  await expect(page.getByTestId("prompt-inspector")).toBeVisible();
  await page.getByTestId("prompt-inspector").locator("summary").click();
  await expect(page.getByTestId("prompt-inspector")).toContainText("PromptPlan");
  await expect(page.getByTestId("job-events")).toContainText("succeeded");

  // package download is the FROZEN snapshot
  const attemptId = page.url().split("/generations/")[1]!.split("?")[0]!;
  const slug = "ojousama";
  const json = await page.request.get(`/api/projects/${slug}/generations/${attemptId}/package?format=json`);
  expect(json.status()).toBe(200);
  const body = (await json.json()) as { shot: { code: string }; provenance: { fingerprint: string } };
  expect(body.shot.code).toBe("3A");
  expect(body.provenance.fingerprint).toMatch(/^[0-9a-f]{64}$/);

  await openGenerate(page);
  await page.getByRole("link", { name: /Compare with attempt 1/ }).click();
  await expect(page.getByTestId("compare-changes")).toBeVisible();
});

test("generated outputs appear in the asset library with Where used", async ({ page }) => {
  await page.goto("/projects/ojousama/assets");
  await page.getByLabel("Search assets").fill("mock-mock-video-1");
  await page.getByRole("button", { name: "Search" }).click();
  const rows = page.locator("tbody tr", { hasText: "mock-mock-video-1" });
  await expect(rows.first()).toBeVisible();
  await rows.first().getByRole("link").first().click();
  // (the app sidebar is also an <aside>; the asset detail panel is the last one)
  await expect(page.locator("aside").last()).toContainText(/attempt \d/i);
});

test("cancelling a running generation is honest about what the provider confirmed", async ({ page }) => {
  test.setTimeout(90_000);
  await openGenerate(page);
  await page.getByTestId("model-select").selectOption("mock/mock-video-hang");
  await page.getByTestId("generate-button").click();
  const card3 = page.locator('[data-testid="attempt-card"][data-attempt="3"]');
  await expect(card3).toBeVisible({ timeout: 15_000 });
  await expect(card3.getByTestId("cancel-button")).toBeVisible({ timeout: 30_000 });
  await card3.getByTestId("cancel-button").click();
  await expect(card3.getByTestId("cancel-outcome")).toBeVisible({ timeout: 45_000 });
  await expect(card3.getByTestId("job-status")).toContainText("Cancelled");
  // the approved attempt is still canonical
  await expect(state(page)).toHaveText("APPROVED");
});

test("the generations dashboard groups work by status and filters", async ({ page }) => {
  await page.goto(`${EP}/generations`);
  await expect(page.getByTestId("group-completed")).toContainText("3A");
  await expect(page.getByTestId("group-failed")).toContainText("Cancelled");
  await page.goto(`${EP}/generations?status=completed&review=approved`);
  // the seed also holds an approved attempt for 2B, so scope to the shot this test generated
  const rows3a = page.getByTestId("generation-row").filter({ hasText: "3A" });
  await expect(rows3a).toHaveCount(1);
  await expect(rows3a).toContainText("approved");
});

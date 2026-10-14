import { expect, test } from "@playwright/test";

/**
 * MANUAL, PAID, ONE-SHOT: submits exactly ONE OpenAI continuity analysis for the synthetic semantic fixture
 * through the real UI/server action. It does NOT call OpenAI itself (the app only queues; the separate
 * `continuity:worker` process makes the request). Never part of `npm run test:e2e`.
 *
 * Refuses to run unless LIVE_SMOKE_APPROVED=yes (set deliberately, per run). Needs PRISM_STUDIO_TEST_PASSWORD
 * and the dev user email from the environment (.env.local via node --env-file).
 */
const SLUG = "continuity-semantic-test";
const EMAIL = process.env.PRISM_STUDIO_TEST_EMAIL ?? process.env.PRISM_STUDIO_DEV_USER_EMAIL ?? "";
const PASSWORD = process.env.PRISM_STUDIO_TEST_PASSWORD ?? "";

test("submit ONE OpenAI semantic continuity analysis (queued only)", async ({ page }) => {
  test.skip(
    process.env.LIVE_SMOKE_APPROVED !== "yes",
    "LIVE_SMOKE_APPROVED=yes is required (paid, one-shot)",
  );
  test.setTimeout(240_000);
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
  await page.goto(`/projects/${SLUG}/generations`);
  const href = await page.locator(`a[href^="/projects/${SLUG}/generations/"]`).first().getAttribute("href");
  const path = `${href!.split("?")[0]}/continuity`;
  await page.goto(path);

  await page.getByTestId("analyzer-select").selectOption("openai");
  await expect(page.getByTestId("privacy-provider")).toHaveText("OpenAI");
  await expect(page.getByTestId("privacy-model")).toHaveText("GPT-6 Luna");
  await expect(page.getByTestId("count-analysed")).toHaveText("2");
  await expect(page.getByTestId("refs-used")).toHaveText("2");
  await expect(page.getByTestId("run-analysis")).toBeDisabled();
  await page.getByTestId("ack-analysis-spend").check();
  await expect(page.getByTestId("run-analysis")).toBeEnabled();
  await page.getByTestId("run-analysis").click();
  await expect(page.getByTestId("analysis-progress")).toBeVisible({ timeout: 60_000 });
  console.log(`SUBMITTED ${path}`);
});

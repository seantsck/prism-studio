import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { getPrismStudioDevCredentials } from "./dev-credentials";

/**
 * Real Supabase Auth + Postgres queue + the real worker process + private Storage ingestion, with the free
 * MockProvider. Needs PRISM_STUDIO_DEV_USER_PASSWORD (skipped without it). Cleans up its own generations.
 *
 * The web server has no inline worker in supabase mode, so this test runs `scripts/generation-worker.mts`
 * exactly as an operator would.
 */
const { email: EMAIL, password: PASSWORD } = getPrismStudioDevCredentials();
const EP = "/projects/ojousama/episodes/ep-1";

const tsx = (script: string, args: string[]) =>
  execFileSync("npx", ["tsx", "--env-file=.env.local", script, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRISM_STUDIO_PERSISTENCE: "supabase",
      PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
      NODE_ENV: "test",
      // Dev-only, explicit: the test worker signs in as the test user instead of holding a secret key,
      // and runs through the least-privilege DB role (SET ROLE on the admin connection, no password).
      // PRISM_STUDIO_E2E_REAL_WORKER=1 uses the provisioned worker login + worker Storage secret instead
      // (no SET ROLE, no admin DB URL, no test-user storage).
      ...(process.env.PRISM_STUDIO_E2E_REAL_WORKER === "1"
        ? {}
        : { PRISM_STUDIO_WORKER_DEV_STORAGE: "1", PRISM_STUDIO_WORKER_DEV_ASSUME_ROLE: "1" }),
    },
    encoding: "utf8",
    timeout: 240_000,
    shell: process.platform === "win32",
  });

test.describe("generation with the Mock provider (signed in, real queue + worker + Storage)", () => {
  test.describe.configure({ mode: "serial" });

  test.afterAll(() => {
    try {
      tsx("scripts/generation-cleanup.mts", ["--yes"]);
    } catch {
      /* cleanup is best effort; the script is idempotent and can be re-run */
    }
  });

  test("generate 3A → worker process executes → output ingested into private Storage → review", async ({
    page,
  }) => {
    test.setTimeout(300_000);

    await page.goto("/login");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("お嬢様、僕と結婚してください。").first()).toBeVisible({ timeout: 30_000 });

    await page.goto(`${EP}/shots`);
    await page.getByRole("link", { name: "3A", exact: true }).click();
    await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
    const base = page.url().split("?")[0]!;
    await page.goto(`${base}?section=generate`);

    const state = page.getByTestId("shot-generation-state");
    await expect(state).toHaveText("READY");
    await page.getByTestId("generate-button").click();
    await expect(page.getByTestId("attempt-card")).toHaveCount(1, { timeout: 30_000 });
    await expect(state).toHaveText("QUEUED");

    // No worker is running yet: the job waits in Postgres, it is not executed inside the request.
    await page.waitForTimeout(1500);
    await expect(state).toHaveText("QUEUED");

    // Run the real worker process until the queue is empty.
    const out = tsx("scripts/generation-worker.mts", ["--until-idle"]);
    expect(out).toContain("lyqdxiyjperhniwhzsvg");
    expect(out).not.toMatch(/service|password|postgres:\/\//i);

    await page.goto(`${base}?section=generate`);
    await expect(state).toHaveText("READY FOR REVIEW", { timeout: 30_000 });
    const card = page.locator('[data-testid="attempt-card"][data-attempt="1"]');
    await expect(card.getByTestId("job-status")).toContainText("Complete");
    await expect(card.getByTestId("output-video")).toBeVisible();

    // The output was written to the PRIVATE bucket and is served via the authorised route (signed URL).
    const src = await card.getByTestId("output-video").getAttribute("src");
    const res = await page.request.get(src!); // follows the 307 to the short-lived signed URL
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/video\/webm/);
    expect((await res.body()).length).toBeGreaterThan(5000);

    // history survives a reload; reject keeps it forever
    await card.getByTestId("reject-toggle").click();
    await card.getByLabel("Timing").check();
    await card.getByPlaceholder("What is wrong?").fill("e2e rejection");
    await card.getByTestId("reject-submit").click();
    await expect(card.getByTestId("review-status")).toContainText("rejected", { timeout: 30_000 });
    await page.reload();
    await expect(page.locator('[data-testid="attempt-card"][data-attempt="1"]')).toHaveAttribute(
      "data-review",
      "rejected",
    );
  });
});

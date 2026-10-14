import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

/**
 * Phase 2E on the REAL stack, NO paid provider: real Supabase Auth + RLS, candidate set persisted in Postgres,
 * three free mock candidates executed by the real worker process, human review, winner, promotion, model
 * history. Needs PRISM_STUDIO_TEST_PASSWORD (skipped without it). Removes its own mock generations and sets.
 */
const EMAIL = process.env.PRISM_STUDIO_TEST_EMAIL ?? process.env.PRISM_STUDIO_DEV_USER_EMAIL ?? "";
const PASSWORD = process.env.PRISM_STUDIO_TEST_PASSWORD ?? "";
const EP = "/projects/ojousama/episodes/ep-1";

const tsx = (script: string, args: string[]) =>
  execFileSync("npx", ["tsx", "--env-file=.env.local", script, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRISM_STUDIO_PERSISTENCE: "supabase",
      PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
      NODE_ENV: "test",
      ...(process.env.PRISM_STUDIO_E2E_REAL_WORKER === "1"
        ? {}
        : { PRISM_STUDIO_WORKER_DEV_STORAGE: "1", PRISM_STUDIO_WORKER_DEV_ASSUME_ROLE: "1" }),
    },
    encoding: "utf8",
    timeout: 240_000,
    shell: process.platform === "win32",
  });

test.describe("candidate sets (signed in, real queue + worker + Postgres reviews)", () => {
  test.skip(!PASSWORD, "PRISM_STUDIO_TEST_PASSWORD is not set; signed-in candidate flow skipped");
  test.describe.configure({ mode: "serial" });

  test.afterAll(() => {
    try {
      tsx("scripts/generation-cleanup.mts", ["--yes"]);
    } catch {
      /* best effort; idempotent */
    }
  });

  test("compare three mock models → worker executes each → review → Best → promote → history", async ({
    page,
  }) => {
    test.setTimeout(420_000);
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

    const row = (m: string) => page.locator(`[data-testid="model-row"][data-model="${m}"]`);
    await expect(page.getByTestId("model-matrix")).toBeVisible();
    for (const m of ["mock-video-1", "mock-video-lite", "mock-video-169"]) {
      await row(m).getByTestId("model-pick").check();
    }
    await page.getByTestId("ack-all").check();
    await page.getByTestId("create-candidate-set").click();
    await page.waitForURL(/\/candidates\/[0-9a-f-]{36}/, { timeout: 60_000 });
    const setPath = new URL(page.url()).pathname;

    // queued in Postgres: nothing executes inside the request
    await expect(page.getByTestId("candidate-card")).toHaveCount(3);
    await expect(page.getByTestId("set-rollup")).toContainText("0/3 completed");

    const out = tsx("scripts/generation-worker.mts", ["--until-idle"]);
    expect(out).toContain("lyqdxiyjperhniwhzsvg");
    expect(out).not.toMatch(/service|password|postgres:\/\//i);

    await page.goto(setPath);
    await expect(page.getByTestId("set-rollup")).toContainText("3/3 completed", { timeout: 60_000 });
    const card = (l: string) => page.locator(`[data-testid="candidate-card"][data-label="${l}"]`);

    await card("A").getByTestId("review-reject").click();
    await card("A").getByTestId("reject-character_identity").click();
    await expect(card("A")).toHaveAttribute("data-decision", "reject", { timeout: 30_000 });
    await card("B").getByTestId("review-best").click();
    await expect(card("B")).toHaveAttribute("data-preferred", "1", { timeout: 30_000 });
    page.once("dialog", (d) => void d.accept());
    await card("B").getByTestId("promote").click();
    await expect(card("B")).toHaveAttribute("data-promoted", "1", { timeout: 30_000 });

    // persisted in Postgres: survives a reload with its audit trail
    await page.reload();
    await expect(card("A")).toHaveAttribute("data-decision", "reject");
    await expect(card("B")).toHaveAttribute("data-promoted", "1");
    await expect(page.getByTestId("set-events")).toContainText("promoted");

    // the winner is the shot's creative output (existing approval), losers are kept
    await page.goto(`${base}?section=generate`);
    await expect(page.locator('[data-testid="attempt-card"][data-review="approved"]')).toHaveCount(1);
    await expect(page.getByTestId("attempt-card")).toHaveCount(3);

    await page.goto("/projects/ojousama/models");
    await expect(
      page
        .locator('[data-testid="model-card"][data-model="mock-video-1"]')
        .getByTestId("model-history-stats"),
    ).toContainText("Reviewed");
  });
});

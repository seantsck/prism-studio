import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

/**
 * Phase 2D against the REAL stack, NO paid request: signed-in user → server action freezes plan/manifest and
 * queues a job in Postgres → the REAL continuity worker process (dedicated least-privilege login, private
 * Storage) executes it with the free Mock analyzer → findings/evidence/cost → human override → re-run history.
 *
 * Uses a disposable SYNTHETIC project (never the canonical drama). Needs PRISM_STUDIO_TEST_PASSWORD,
 * PRISM_STUDIO_CONTINUITY_DB_URL and ffmpeg (skipped without them). Removes the fixture afterwards.
 */
const EMAIL = process.env.PRISM_STUDIO_TEST_EMAIL ?? process.env.PRISM_STUDIO_DEV_USER_EMAIL ?? "";
const PASSWORD = process.env.PRISM_STUDIO_TEST_PASSWORD ?? "";
const SLUG = "continuity-semantic-test";

let hasFfmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
} catch {
  hasFfmpeg = false;
}

const tsx = (script: string, args: string[]) =>
  execFileSync("npx", ["tsx", "--env-file=.env.local", script, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRISM_STUDIO_PERSISTENCE: "supabase",
      PRISM_STUDIO_CONTINUITY_ANALYZERS: "mock",
      PRISM_STUDIO_ALLOW_PAID_ANALYSIS: "false",
      GEMINI_API_KEY: "",
      NODE_ENV: "test",
    },
    encoding: "utf8",
    timeout: 240_000,
    shell: process.platform === "win32",
  });

test.describe("continuity analysis (signed in, real queue + continuity worker login + Storage)", () => {
  test.skip(!PASSWORD, "PRISM_STUDIO_TEST_PASSWORD is not set");
  test.skip(!process.env.PRISM_STUDIO_CONTINUITY_DB_URL, "PRISM_STUDIO_CONTINUITY_DB_URL is not set");
  test.skip(!hasFfmpeg, "ffmpeg/ffprobe are not installed");
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    try {
      tsx("scripts/continuity-smoke-fixture.mts", ["--remove"]);
    } catch {
      /* nothing to remove */
    }
    tsx("scripts/continuity-smoke-fixture.mts", ["--create"]);
  });
  test.afterAll(() => {
    try {
      tsx("scripts/continuity-smoke-fixture.mts", ["--remove"]);
    } catch {
      /* best effort; idempotent */
    }
  });

  test("queue → restricted worker → findings with evidence → override → re-run history", async ({ page }) => {
    test.setTimeout(420_000);
    await page.goto("/login");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("お嬢様、僕と結婚してください。").first()).toBeVisible({ timeout: 30_000 });

    // find the fixture attempt through the project's generations list
    await page.goto(`/projects/${SLUG}/generations`);
    const href = await page.locator(`a[href^="/projects/${SLUG}/generations/"]`).first().getAttribute("href");
    expect(href).toMatch(/\/generations\/[0-9a-f-]{36}/);
    const path = `${href!.split("?")[0]}/continuity`;
    await page.goto(path);

    // preview before anything runs: the two criteria, the references, the (free) cost
    await expect(page.getByTestId("analysis-launcher")).toBeVisible();
    await expect(page.getByTestId("count-analysed")).toHaveText("2");
    await expect(page.getByTestId("refs-used")).toHaveText("2");
    await expect(page.getByTestId("estimated-analysis-cost")).toContainText("$0");
    await page.getByTestId("run-analysis").click();

    // queued in Postgres; nothing executes inside the request
    await expect(page.getByTestId("analysis-progress")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("status-semantic")).not.toContainText("complete");

    const out = tsx("scripts/continuity-worker.mts", ["--until-idle"]);
    expect(out).toContain("prism_continuity_worker");
    expect(out).not.toMatch(/postgres:\/\/|password|api[_-]?key/i);

    await page.goto(path);
    await expect(page.getByTestId("status-semantic")).toContainText(/complete/i, { timeout: 30_000 });
    const identity = page.locator('[data-testid="criterion"][data-key^="identity:"]').first();
    const wardrobe = page.locator('[data-testid="criterion"][data-key^="wardrobe:"]').first();
    await expect(identity).not.toHaveAttribute("data-result", "unchecked");
    await expect(wardrobe).not.toHaveAttribute("data-result", "unchecked");
    // evidence: expected references next to the output frame, with the source named
    await expect(identity.getByTestId("evidence")).toBeVisible();
    await expect(identity.getByTestId("evidence-source").first()).toContainText("OUTPUT FRAME");
    await expect(page.getByTestId("external-manifest")).toContainText("Nothing left Prism");
    await expect(page.getByTestId("run-cost")).toContainText("actual $0");

    // human override: appended, analyzer result preserved, survives reload
    const system = (await identity.getByTestId("system-result").textContent())!.trim();
    await identity
      .getByRole("combobox")
      .selectOption(system.toLowerCase().startsWith("pass") ? "fail" : "pass");
    await identity.getByPlaceholder("Note").fill("e2e override");
    await identity.getByTestId("override-submit").click();
    await expect(identity.getByTestId("override-note")).toContainText("Human:", { timeout: 30_000 });
    await page.reload();
    await expect(identity.getByTestId("override-note")).toContainText("Human:");
    await expect(identity.getByTestId("system-result")).toHaveText(system);

    // re-run: a NEW run; history keeps both
    await page.getByTestId("run-analysis").click();
    await expect(page.getByTestId("analysis-progress")).toBeVisible({ timeout: 60_000 });
    tsx("scripts/continuity-worker.mts", ["--until-idle"]);
    await page.goto(path);
    await expect(page.locator('[data-testid="history-row"]')).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator('[data-testid="history-row"]').nth(1)).toContainText("Run 1");
  });
});

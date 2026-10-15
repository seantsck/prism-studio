import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { getPrismStudioDevCredentials } from "./dev-credentials";

/**
 * Phase 2C against the REAL stack, MockProvider only (no external calls, no cost): signed-in user, Postgres
 * queue, the real worker process, private Storage — then delivery conform + continuity QA through the app
 * server (ffmpeg, the user's own Storage session, RLS-bound repositories).
 *
 * Needs PRISM_STUDIO_DEV_USER_PASSWORD (skipped without it) and ffmpeg/ffprobe. Cleans up what it creates,
 * including derived assets and their stored files.
 */
const { email: EMAIL, password: PASSWORD } = getPrismStudioDevCredentials();
const EP = "/projects/ojousama/episodes/ep-1";

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

test.describe("framing adaptation + delivery conform + continuity QA (signed in, real worker + Storage)", () => {
  test.skip(!hasFfmpeg, "ffmpeg/ffprobe are not installed");
  test.describe.configure({ mode: "serial" });

  test.afterAll(() => {
    try {
      tsx("scripts/generation-cleanup.mts", ["--yes"]);
    } catch {
      /* best effort; idempotent */
    }
  });

  test("2.39:1 / 4.5 s → 16:9 / 5 s → conform to 2.39:1 / 4.5 s → continuity QA → approval", async ({
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

    // adaptation is an explicit, acknowledged choice
    await page.getByTestId("model-select").selectOption("mock/mock-video-169");
    await expect(page.getByTestId("generate-button")).toBeDisabled();
    await page.getByTestId("framing-select").selectOption("overscan_for_crop");
    await page.getByTestId("duration-select").selectOption("generate_longer_then_trim");
    await expect(page.getByTestId("protected-crop")).toBeVisible();
    for (const box of await page.locator('input[name="ack"]').all()) await box.check();
    await page.getByTestId("generate-button").click();
    await expect(page.getByTestId("attempt-card")).toHaveCount(1, { timeout: 30_000 });

    // the real worker executes it (the app server never does)
    const out = tsx("scripts/generation-worker.mts", ["--until-idle"]);
    expect(out).toContain("lyqdxiyjperhniwhzsvg");
    await page.goto(`${base}?section=generate`);
    const card = page.getByTestId("attempt-card").first();
    await expect(card.getByTestId("job-status")).toContainText("Complete", { timeout: 30_000 });
    await expect(card.getByTestId("provider-original-card")).toContainText("16:9");

    // conform in the app server: reads the original from private Storage, writes a NEW derived asset
    await card.getByTestId("create-conform").click();
    await expect(card.getByTestId("delivery-size")).toContainText("192×80", { timeout: 120_000 });
    await expect(card.getByTestId("delivery-size")).toContainText("4.50s");

    // the derived file is served through the authorised route (signed URL)
    await card.getByTestId("preview-final").click();
    const dsrc = await card.getByTestId("delivery-video").getAttribute("src");
    const res = await page.request.get(dsrc!);
    expect(res.status()).toBe(200);
    expect((await res.body()).length).toBeGreaterThan(500);

    // continuity QA
    await card.getByTestId("start-continuity").click();
    await expect(card.getByTestId("open-continuity")).toBeVisible({ timeout: 120_000 });
    await card.getByTestId("open-continuity").click();
    const row = (key: string) => page.locator(`[data-testid="criterion"][data-key="${key}"]`);
    await expect(row("aspect_ratio")).toHaveAttribute("data-result", "pass");
    await expect(row("duration")).toHaveAttribute("data-result", "pass");
    await expect(page.getByTestId("qa-lines")).toContainText("MOCK ANALYSIS only");

    const target = page.locator('[data-testid="criterion"][data-key^="identity:"]').first();
    await target.getByRole("combobox").selectOption("pass");
    await target.getByPlaceholder("Note").fill("e2e: identity ok");
    await target.getByTestId("override-submit").click();
    await expect(target.getByTestId("override-note")).toContainText("Human: Pass", { timeout: 30_000 });
    await page.getByTestId("finalize-review").click();
    await expect(page.getByTestId("qa-status")).toContainText(/QA (passed|failed)/, { timeout: 30_000 });

    // creative approval is a separate act; reload keeps everything
    await page.goto(`${base}?section=generate`);
    const again = page.getByTestId("attempt-card").first();
    await again.getByTestId("approve-button").click();
    await expect(again.getByTestId("chip-creative")).toContainText("approved", { timeout: 30_000 });
    await page.reload();
    const reloaded = page.getByTestId("attempt-card").first();
    await expect(reloaded.getByTestId("chip-creative")).toContainText("approved");
    await expect(reloaded.getByTestId("chip-continuity")).not.toContainText("not started");
    await expect(reloaded.getByTestId("delivery-versions")).toContainText("delivery master");
  });
});

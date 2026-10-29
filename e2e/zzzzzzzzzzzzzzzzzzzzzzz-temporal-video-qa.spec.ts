import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 3A.3 Temporal Video QA, on its OWN memory server (it changes the Project's QA policy). Gemini runs ONLY through
 * the in-memory FAKE transport with the server's direct-video gate on; the key is a placeholder, so nothing can leave
 * the process. No provider network, no paid call.
 *
 *   automatic deterministic QA → Automatic semantic (Gemini fake) WITHOUT full-video permission: image QA only,
 *   temporal criteria unchecked with the reason → owner allows the full video → ONE temporal run with timestamped
 *   evidence (seekable) → creative review stays human → permission off: no further full-video jobs.
 */
let hasFfmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
} catch {
  hasFfmpeg = false;
}

const P = "/projects/ojousama";
const EP = `${P}/episodes/ep-1`;
test.describe.configure({ mode: "serial" });
test.skip(!hasFfmpeg, "ffmpeg/ffprobe are not installed");

let shotBase = "";
let continuityPath = "";

async function openGenerate(page: Page) {
  if (!shotBase) {
    await page.goto(`${EP}/shots`);
    await page.getByRole("link", { name: "3A", exact: true }).click();
    await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
    shotBase = page.url().split("?")[0]!;
  }
  await page.goto(`${shotBase}?section=generate`);
  await expect(page.getByTestId("generate-workspace")).toBeVisible();
  return continuityPath
    ? page
        .getByTestId("attempt-card")
        .filter({ has: page.locator(`[data-testid="card-review-qa"][href="${continuityPath}"]`) })
    : page.getByTestId("attempt-card").first();
}

const historyRows = (page: Page) => page.locator('[data-testid="history-row"]');

async function saveAutomatic(page: Page, directVideo: boolean) {
  await page.goto(`${P}/qa`);
  await page.getByTestId("qa-mode-automatic").check();
  await page.getByTestId("qa-analyzer").selectOption("gemini");
  await page.getByTestId("qa-max-run").fill("0.50");
  await page.getByTestId("qa-max-day").fill("5");
  await page.getByTestId("qa-media-consent").setChecked(true);
  await page.getByTestId("qa-direct-video").setChecked(directVideo);
  await page.getByTestId("qa-confirm-automatic").check();
  await page.getByTestId("qa-policy-save").click();
}

test("a succeeded video gets automatic deterministic QA; the server reports temporal QA available, permission off", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openGenerate(page);
  await page.getByTestId("model-select").selectOption("mock/mock-video-169");
  await page.getByTestId("framing-select").selectOption("overscan_for_crop");
  await page.getByTestId("duration-select").selectOption("generate_longer_then_trim");
  for (const box of await page.locator('input[name="ack"]').all()) await box.check();
  await page.getByTestId("generate-button").click();
  const card = page.getByTestId("attempt-card").first();
  await expect(card.getByTestId("job-status")).toContainText("Complete", { timeout: 90_000 });
  continuityPath = (await card.getByTestId("card-review-qa").getAttribute("href"))!;
  await expect(card.getByTestId("auto-qa-deterministic")).toHaveAttribute("data-state", "current", {
    timeout: 30_000,
  });

  await page.goto(`${P}/qa`);
  await expect(page.getByTestId("qa-direct-video")).not.toBeChecked(); // never on by default
  await page.getByTestId("qa-analyzer").selectOption("gemini");
  await expect(page.getByTestId("qa-temporal-state")).toContainText("temporal QA available");
  await expect(page.getByTestId("qa-temporal-state")).toContainText("Lip sync not calibrated");
});

test("Automatic semantic QA without full-video permission: image QA runs, temporal criteria stay unchecked with the reason", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await saveAutomatic(page, false);
  await expect(page.getByTestId("qa-automatic-confirm")).toContainText("No full video is sent");
  await expect(page.getByTestId("qa-policy-revision")).toContainText("revision 1", { timeout: 20_000 });

  const card = await openGenerate(page);
  await expect(card.getByTestId("auto-qa-semantic")).toHaveAttribute("data-state", "queued", {
    timeout: 60_000,
  });
  await expect(card.getByTestId("auto-qa-temporal")).toHaveCount(0);
  await page.goto(continuityPath);
  await expect(page.getByTestId("status-semantic")).toContainText(/gemini.*complete/i, { timeout: 90_000 });
  await page.reload();
  await expect(page.getByTestId("temporal-coverage")).toContainText("0 evaluated");
  await expect(
    page.locator('[data-testid="temporal-unchecked-reason"][data-key="camera_movement"]'),
  ).toContainText("has not allowed full-video analysis");
  // the manifest says the full video was NOT sent, and why
  await expect(page.getByTestId("manifest-video-omitted")).toContainText(
    "the Project has not allowed full-video analysis",
  );
  await expect(page.getByTestId("manifest-video")).toHaveCount(0);
});

test("owner allows the full video: ONE temporal run with timestamped, seekable evidence; review stays human", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await saveAutomatic(page, true);
  await expect(page.getByTestId("qa-automatic-full-video")).toContainText("full selected delivery video");
  await expect(page.getByTestId("qa-policy-revision")).toContainText("revision 2", { timeout: 20_000 });

  await page.goto(continuityPath);
  const before = await historyRows(page).count();
  const card = await openGenerate(page);
  await expect(card.getByTestId("auto-qa-semantic")).toHaveAttribute("data-state", "queued", {
    timeout: 60_000,
  });
  await expect(card.getByTestId("auto-qa-temporal")).toBeVisible();
  await page.goto(continuityPath);
  await expect(historyRows(page)).toHaveCount(before + 1, { timeout: 30_000 });
  await expect(page.getByTestId("status-semantic")).toContainText(/gemini.*complete/i, { timeout: 90_000 });
  await page.reload();
  const cov = page.getByTestId("temporal-coverage");
  await expect(cov).not.toContainText("0 evaluated");
  await expect(page.getByTestId("manifest-video")).toContainText("full output video was sent");
  await expect(
    page.locator('[data-testid="temporal-unchecked-reason"][data-key="camera_movement"]'),
  ).toHaveCount(0);

  // timestamped, approximate evidence; clicking seeks the existing output player (interval start)
  const camera = page.locator('[data-testid="criterion"][data-key="camera_movement"]');
  await expect(camera.getByTestId("evidence-source").first()).toContainText(/video/i);
  const seek = camera.getByTestId("seek-evidence").first();
  await expect(seek).toContainText("≈");
  await seek.click();
  await expect
    .poll(async () =>
      page.locator('video[data-testid="output-video"]').evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBeGreaterThan(0);

  // repeat visits create nothing more
  await page.reload();
  await expect(historyRows(page)).toHaveCount(before + 1);
  // creative authority: still a person's
  const again = await openGenerate(page);
  await expect(again.getByTestId("chip-creative")).toContainText("unreviewed");
  await expect(again.getByTestId("approve-button")).toBeEnabled();
});

test("a manual Gemini run discloses the full-video transfer and needs its own acknowledgement", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(continuityPath);
  await page.getByTestId("analyzer-select").selectOption("gemini");
  await expect(page.getByTestId("full-video-disclosure")).toContainText("Full delivery video will be sent");
  await page.getByTestId("ack-analysis-spend").check();
  await expect(page.getByTestId("run-analysis")).toBeDisabled(); // the spend ack is not full-video consent
  await page.getByTestId("ack-direct-video").check();
  await expect(page.getByTestId("run-analysis")).toBeEnabled();
});

test("turning full-video permission off stops future full-video jobs; history stays", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(continuityPath);
  const before = await historyRows(page).count();
  await saveAutomatic(page, false);
  await expect(page.getByTestId("qa-policy-revision")).toContainText("revision 3", { timeout: 20_000 });
  const card = await openGenerate(page);
  // the image-only automatic analysis of this truth already exists: nothing new is queued, no video is sent
  await expect(card.getByTestId("auto-qa-semantic")).toHaveAttribute("data-state", "queued", {
    timeout: 30_000,
  });
  await expect(card.getByTestId("auto-qa-temporal")).toHaveCount(0);
  await page.goto(continuityPath);
  await expect(historyRows(page)).toHaveCount(before);
});

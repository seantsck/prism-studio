import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 2C acceptance flow, MockProvider only (no external calls, no cost): Shot 3A is 2.39:1 / 4.5 s, the
 * "Mock Video 16:9" model only offers 16:9 / 5 s. Production → adaptation → provider canvas → provider output →
 * delivery conform → continuity QA → human approval. Runs after z-generation (zz- prefix).
 */
let hasFfmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
} catch {
  hasFfmpeg = false;
}

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

test.describe.configure({ mode: "serial" });
test.skip(
  !hasFfmpeg,
  "ffmpeg/ffprobe are not installed: delivery conform cannot run (see docs/media-processing.md)",
);

let attemptUrl = "";

test("2.39:1 / 4.5 s on a 16:9 / 5 s model: explicit adaptation, overlay, acknowledgement, generate", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openGenerate(page);

  await page.getByTestId("model-select").selectOption("mock/mock-video-169");
  // incompatible until the user chooses: nothing is silently rounded or cropped
  await expect(page.getByTestId("generate-blockers")).toContainText("Aspect ratio 2.39:1 is not supported");
  await expect(page.getByTestId("generate-blockers")).toContainText("Production duration 4.5s");
  await expect(page.getByTestId("generate-button")).toBeDisabled();
  await expect(page.getByTestId("adaptation-panel")).toBeVisible();
  await expect(page.getByTestId("framing-select")).toHaveValue("");
  await expect(page.getByTestId("duration-select")).toHaveValue("");

  // recommend, never choose
  await expect(page.getByTestId("framing-select").locator("option", { hasText: "recommended" })).toHaveCount(
    1,
  );

  await page.getByTestId("framing-select").selectOption("overscan_for_crop");
  await page.getByTestId("duration-select").selectOption("generate_longer_then_trim");

  // the crop overlay: outer provider canvas, inner protected crop, discarded regions
  await expect(page.getByTestId("adaptation-detail")).toBeVisible();
  await expect(page.getByTestId("protected-crop")).toBeVisible();
  await expect(page.getByTestId("discard-region")).toHaveCount(4);
  await expect(page.getByTestId("production-frame")).toHaveText("2.39:1");
  await expect(page.getByTestId("provider-canvas")).toContainText("16:9");
  await expect(page.getByTestId("discarded")).toContainText("25.6%");
  await expect(page.getByTestId("provider-adaptation")).toContainText("protected region");
  await expect(page.getByTestId("duration-adapted")).toContainText(
    "Provider generates 5s, delivery trimmed to 4.5s",
  );

  // compatible now, but still gated by acknowledgement
  await expect(page.getByTestId("generate-blockers")).toHaveCount(0);
  await expect(page.getByTestId("generate-button")).toBeDisabled();
  await page.locator('input[data-ack="adaptation.framing"]').check();
  await expect(page.getByTestId("generate-button")).toBeDisabled();
  await page.locator('input[data-ack="adaptation.duration"]').check();
  // any other model limitation (e.g. resolution clamp) is acknowledged the same way
  for (const box of await page.locator('input[name="ack"]').all()) await box.check();
  await expect(page.getByTestId("generate-button")).toBeEnabled();

  await page.getByTestId("generate-button").click();
  // (the shot may already have an approved attempt from earlier tests, so wait on the NEW attempt itself)
  await expect(page.getByTestId("attempt-card").first().getByTestId("job-status")).toContainText("Complete", {
    timeout: 90_000,
  });
});

test("provider original, production target and conform are shown side by side; conform creates a derived asset", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openGenerate(page);
  const card = page.getByTestId("attempt-card").first();
  await expect(card.getByTestId("stage-chips")).toContainText("Generated");
  await expect(card.getByTestId("chip-continuity")).toContainText("not started");
  await expect(card.getByTestId("chip-creative")).toContainText("unreviewed");

  await expect(card.getByTestId("provider-original-card")).toContainText("16:9");
  await expect(card.getByTestId("production-target-card")).toContainText("2.39:1");
  await expect(card.getByTestId("production-target-card")).toContainText("4.50s");
  await expect(card.getByTestId("conform-card")).toContainText("Crop 16:9 → 2.39:1");
  await expect(card.getByTestId("conform-card")).toContainText("Trim 5.00s → 4.50s");
  await expect(card.getByTestId("delivery-size")).toContainText("not created yet");

  // CSS preview of the crop works before any file is rendered
  await card.getByTestId("preview-final").click();
  await expect(card.getByTestId("css-crop-preview")).toBeVisible();

  await card.getByTestId("create-conform").click();
  await expect(card.getByTestId("delivery-size")).toContainText("192×80", { timeout: 60_000 });
  await expect(card.getByTestId("delivery-size")).toContainText("4.50s");

  // original / delivery toggle + split
  await card.getByTestId("preview-split").click();
  await expect(card.getByTestId("original-video")).toBeVisible();
  await expect(card.getByTestId("delivery-video")).toBeVisible();

  // lineage kept; the provider original is still listed and selectable
  await expect(card.getByTestId("delivery-versions")).toContainText("v1");
  await expect(card.getByTestId("delivery-versions")).toContainText("conform");
  await expect(card.getByTestId("delivery-versions")).toContainText("delivery master");
});

test("derived media appears in the Asset Library with its lineage", async ({ page }) => {
  await page.goto("/projects/ojousama/assets");
  await page.getByLabel("Search assets").fill("delivery");
  await page.getByRole("button", { name: "Search" }).click();
  const rows = page.locator("tbody tr", { hasText: "delivery" });
  await expect(rows.first()).toBeVisible();
  await rows.first().getByRole("link").first().click();
  await expect(page.getByTestId("asset-lineage")).toContainText("Derived from");
  await expect(page.getByTestId("asset-lineage")).toContainText("original is never replaced");
});

test("continuity review: deterministic checks, mock analysis, human override, close-out", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openGenerate(page);
  const card = page.getByTestId("attempt-card").first();
  await card.getByTestId("start-continuity").click();
  await expect(card.getByTestId("open-continuity")).toBeVisible({ timeout: 60_000 });
  await expect(card.getByTestId("chip-continuity")).toContainText("in review");
  await expect(card.getByTestId("qa-summary")).toContainText("MOCK ANALYSIS");
  await expect(card.getByTestId("contact-sheet")).toBeVisible();

  await card.getByTestId("open-continuity").click();
  await expect(page.getByTestId("continuity-page")).toBeVisible();
  attemptUrl = page.url();
  await expect(page.getByTestId("reference-set")).toContainText("frozen");
  await expect(page.getByTestId("contact-sheet")).toBeVisible();

  // deterministic checks populate against the DELIVERY master
  const row = (key: string) => page.locator(`[data-testid="criterion"][data-key="${key}"]`);
  await expect(row("aspect_ratio")).toHaveAttribute("data-result", "pass");
  await expect(row("duration")).toHaveAttribute("data-result", "pass");
  await expect(row("delivery_master")).toHaveAttribute("data-result", "pass");
  await expect(row("aspect_ratio")).toContainText("Expected: 2.39:1");
  await expect(row("duration")).toContainText("Expected: 4.5s");

  // semantic findings come from the mock analyzer and are labelled as such
  const mock = page.locator('[data-testid="criterion"]', { hasText: "MOCK ANALYSIS" });
  await expect(mock.first()).toBeVisible();
  await expect(page.getByTestId("qa-lines")).toContainText("MOCK ANALYSIS only");
  // criteria no analyzer can judge stay unchecked (honest)
  await expect(page.locator('[data-testid="criterion"][data-result="unchecked"]').first()).toBeVisible();

  // human override: explicit, preserved, the system result stays visible
  const target = page.locator('[data-testid="criterion"][data-key^="identity:"]').first();
  const system = (await target.getByTestId("system-result").textContent())!.trim();
  await target.getByRole("combobox").selectOption("fail");
  await target.getByPlaceholder("Note").fill("Face drifts in the last frames");
  await target.getByTestId("override-submit").click();
  await expect(target.getByTestId("override-note")).toContainText("Human: Fail", { timeout: 20_000 });
  await expect(target.getByTestId("system-result")).toHaveText(system);
  await expect(target).toHaveAttribute("data-result", "fail");
  // a critical failure is called out but nothing is auto-rejected
  await expect(page.getByTestId("critical-note")).toBeVisible();

  // close the review
  await page.getByPlaceholder("Note (e.g. warnings accepted").fill("Reviewed on set");
  await page.getByTestId("finalize-review").click();
  await expect(page.getByTestId("qa-status")).toContainText("QA failed", { timeout: 20_000 });
  await expect(page.getByTestId("criteria").getByTestId("override-submit")).toHaveCount(0);
});

test("creative approval stays separate; history persists after reload", async ({ page }) => {
  test.setTimeout(120_000);
  const base = await openGenerate(page);
  const card = page.getByTestId("attempt-card").first();
  await expect(card.getByTestId("chip-continuity")).toContainText("failed");
  // advisory only: the human is still authoritative
  await expect(card.getByTestId("approval-advisory")).toContainText("critical continuity failure");
  // Phase 3A.1: Shot QA names the critical mismatch, yet the person can still approve: QA never decides
  await expect(card.getByTestId("card-shot-qa-state")).toContainText("Critical mismatch");
  await expect(card.getByTestId("approval-advisory")).toContainText("Shot QA: Critical mismatch");
  await expect(card.getByTestId("approve-button")).toBeEnabled();
  await card.getByTestId("approve-button").click();
  await expect(card.getByTestId("chip-creative")).toContainText("approved", { timeout: 20_000 });
  await expect(card.getByTestId("chip-continuity")).toContainText("failed");
  await expect(card.getByTestId("card-shot-qa-state")).toContainText("Critical mismatch");

  await page.goto(`${base}?section=generate`);
  const reloaded = page.getByTestId("attempt-card").first();
  await expect(reloaded.getByTestId("chip-creative")).toContainText("approved");
  await expect(reloaded.getByTestId("chip-continuity")).toContainText("failed");
  await expect(reloaded.getByTestId("delivery-versions")).toContainText("delivery master");

  // the frozen historical package + adaptation plan remain readable
  await reloaded.getByTestId("open-brief").click();
  await expect(page.getByTestId("adaptation-plan")).toContainText("Production intent");
  await expect(page.getByTestId("plan-production-frame")).toHaveText("2.39:1");
  await expect(page.getByTestId("plan-provider-canvas")).toContainText("16:9");
  await expect(page.getByTestId("plan-acks")).toContainText("acknowledged");
  void attemptUrl;
});

test("older attempts (no adaptation plan) still render", async ({ page }) => {
  // Shot 2B's seeded history was logged before framing adaptation existed: no plan is recorded or invented.
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: "2B", exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  await page.goto(`${page.url().split("?")[0]}?section=generate`);
  const cards = page.getByTestId("attempt-card");
  await expect(cards.first()).toBeVisible();
  await cards.last().getByTestId("open-brief").click();
  await expect(page.getByTestId("adaptation-plan")).toBeVisible();
  await expect(page.getByTestId("no-adaptation-plan").first()).toContainText("No adaptation plan recorded");
});

test("dashboard keeps prep, generation, continuity and approval separate", async ({ page }) => {
  await page.goto("/projects/ojousama");
  await expect(page.getByTestId("pipeline-dashboard")).toBeVisible();
  await expect(page.getByTestId("pipeline-generated")).not.toHaveText("0");
  await expect(page.getByTestId("pipeline-creative-approved")).not.toHaveText("0");
  await page.goto(`${EP}/shots`);
  const row = page.locator('[data-testid="shot-pipeline"][data-shot="3A"]');
  await expect(row).toContainText("GENERATED");
  await expect(row).toContainText("QA failed");
  await expect(row).toContainText("APPROVED");
});

test("production surfaces keep the 2.39:1 frame (provider 16:9 only in execution contexts)", async ({
  page,
}) => {
  await page.goto("/projects/ojousama/animatic");
  await expect(page.locator("body")).not.toContainText("Provider canvas");
  await page.goto("/projects/ojousama/bible");
  await expect(page.locator('input[name="aspectRatio"]')).toHaveValue("2.39:1");
});

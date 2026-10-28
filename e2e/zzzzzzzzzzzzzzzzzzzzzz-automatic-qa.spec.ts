import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 3A.2 automatic Shot QA, on its OWN memory server (it changes the Project's QA policy). Free mock generation;
 * semantic analysis only through the in-memory OpenAI FAKE transport. No provider network, no paid call.
 *
 *   generation succeeds → (nobody presses Run QA) → automatic deterministic QA → policy Suggest → policy Automatic
 *   → one semantic run queued automatically → delivery change → QA for the new subject → creative review stays human.
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
  const card = page
    .getByTestId("attempt-card")
    .filter({ has: page.locator(`[data-testid="card-review-qa"][href="${continuityPath}"]`) });
  return continuityPath ? card : page.getByTestId("attempt-card").first();
}

const historyRows = (page: Page) => page.locator('[data-testid="history-row"]');

async function savePolicy(
  page: Page,
  p: {
    mode: "off" | "suggest" | "automatic";
    analyzer?: string;
    run?: string;
    day?: string;
    consent?: boolean;
    confirm?: boolean;
  },
) {
  await page.goto(`${P}/qa`);
  await expect(page.getByTestId("qa-deterministic-always")).toContainText("Always on");
  await page.getByTestId(`qa-mode-${p.mode}`).check();
  if (p.analyzer) await page.getByTestId("qa-analyzer").selectOption(p.analyzer);
  if (p.run !== undefined) await page.getByTestId("qa-max-run").fill(p.run);
  if (p.day !== undefined) await page.getByTestId("qa-max-day").fill(p.day);
  if (p.consent !== undefined) await page.getByTestId("qa-media-consent").setChecked(p.consent);
  if (p.confirm) await page.getByTestId("qa-confirm-automatic").check();
  await page.getByTestId("qa-policy-save").click();
}

test("a succeeded generation gets automatic deterministic QA without anyone pressing Run QA", async ({
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

  // automatic, free, deterministic: no button was pressed
  await expect(card.getByTestId("auto-qa-deterministic")).toHaveAttribute("data-state", "current", {
    timeout: 30_000,
  });
  await expect(card.getByTestId("card-shot-qa-state")).not.toContainText("No QA yet");
  await expect(card.getByTestId("auto-qa-semantic")).toHaveAttribute("data-state", "off");
  // creative review is untouched and still entirely human
  await expect(card.getByTestId("chip-creative")).toContainText("unreviewed");
  await expect(card.getByTestId("approve-button")).toBeEnabled();
  await expect(card.getByTestId("reject-toggle")).toBeVisible();

  await page.goto(continuityPath);
  await expect(page.getByTestId("shot-qa-summary")).not.toHaveAttribute("data-state", "no_qa");
  await expect(historyRows(page)).toHaveCount(1);
  await expect(historyRows(page).first()).toContainText("deterministic");
  await expect(page.getByTestId("status-semantic")).toContainText("not run");
  // repeated refreshes never create another automatic run
  await page.reload();
  await page.reload();
  await expect(historyRows(page)).toHaveCount(1);
});

test("Suggest recommends semantic QA but sends nothing and queues nothing", async ({ page }) => {
  test.setTimeout(120_000);
  await savePolicy(page, { mode: "suggest", analyzer: "openai" });
  await expect(page.getByTestId("qa-policy-revision")).toContainText("revision 1", { timeout: 20_000 });

  const card = await openGenerate(page);
  await expect(card.getByTestId("auto-qa-semantic")).toHaveAttribute("data-state", "suggested");
  await expect(card.getByTestId("auto-qa-semantic")).toContainText("nothing was sent");
  await page.goto(continuityPath);
  await expect(historyRows(page)).toHaveCount(1);
  await expect(page.getByTestId("status-semantic")).toContainText("not run");
});

test("Automatic needs an explicit standing authorisation, then queues ONE semantic run automatically (fake transport)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // without the confirmation nothing changes
  await savePolicy(page, { mode: "automatic", analyzer: "openai", run: "0.10", day: "1", consent: true });
  await expect(page.getByTestId("qa-policy")).toContainText("Confirm the standing authorisation");
  await page.reload();
  await expect(page.getByTestId("qa-policy-revision")).toContainText("revision 1");

  // with it, the summary names what is authorised
  await savePolicy(page, {
    mode: "automatic",
    analyzer: "openai",
    run: "0.10",
    day: "1",
    consent: true,
    confirm: true,
  });
  await expect(page.getByTestId("qa-automatic-confirm")).toContainText("Media may leave Prism");
  await expect(page.getByTestId("qa-policy-revision")).toContainText("revision 2", { timeout: 20_000 });

  // the next visit reconciles: one semantic run (it carries the deterministic findings)
  const card = await openGenerate(page);
  await expect(card.getByTestId("auto-qa-semantic")).toHaveAttribute("data-state", "queued", {
    timeout: 60_000,
  });
  await page.goto(continuityPath);
  await expect(historyRows(page)).toHaveCount(2, { timeout: 30_000 });
  await expect(historyRows(page).first()).toContainText("openai");
  await expect(page.getByTestId("status-semantic")).toContainText(/openai.*complete/i, { timeout: 90_000 });
  // the run is as auditable as a manual one: the external-media manifest is frozen on it
  await expect(page.getByTestId("external-manifest")).toContainText("OpenAI");
  await page.reload();
  await expect(historyRows(page)).toHaveCount(2);
  await expect(page.getByTestId("chip-creative").first()).toContainText("unreviewed");
});

test("a new delivery master gets QA for the new subject automatically, once; review stays human", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const card = await openGenerate(page);
  await card.getByTestId("create-conform").click();
  await expect(card.getByTestId("delivery-size")).toContainText("192×80", { timeout: 60_000 });
  await page.goto(continuityPath);
  // the conform became the delivery master: the earlier runs are stale, a new automatic semantic run judges it
  await expect(historyRows(page)).toHaveCount(3, { timeout: 60_000 });
  await expect(historyRows(page).nth(1)).toContainText("stale");
  await expect(page.getByTestId("status-semantic")).toContainText(/openai.*complete/i, { timeout: 90_000 });
  await page.reload();
  await expect(historyRows(page)).toHaveCount(3);

  const again = await openGenerate(page);
  await expect(again.getByTestId("auto-qa-semantic")).toHaveAttribute("data-state", "queued");
  await expect(again.getByTestId("chip-creative")).toContainText("unreviewed");
  await expect(again.getByTestId("approve-button")).toBeEnabled();
});

test("turning automation Off governs only new submissions; history stays", async ({ page }) => {
  await savePolicy(page, { mode: "off" });
  await expect(page.getByTestId("qa-policy-revision")).toContainText("revision 3", { timeout: 20_000 });
  const card = await openGenerate(page);
  await expect(card.getByTestId("auto-qa-semantic")).toHaveAttribute("data-state", "off");
  await page.goto(continuityPath);
  await expect(historyRows(page)).toHaveCount(3);
});

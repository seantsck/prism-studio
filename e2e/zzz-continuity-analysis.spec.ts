import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 2D acceptance flow, memory mode, NO paid request: the free Mock analyzer runs through the SAME queue,
 * plan, manifest, worker and result schema as the real Gemini analyzer (which stays unavailable here: no key,
 * paid analysis off). Runs after zz-framing-continuity (zzz- prefix).
 */
let hasFfmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
} catch {
  hasFfmpeg = false;
}

const EP = "/projects/ojousama/episodes/ep-1";
test.describe.configure({ mode: "serial" });
test.skip(!hasFfmpeg, "ffmpeg/ffprobe are not installed");

let continuityPath = "";

async function openGenerate(page: Page) {
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: "3A", exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  const base = page.url().split("?")[0]!;
  await page.goto(`${base}?section=generate`);
  await expect(page.getByTestId("generate-workspace")).toBeVisible();
  return base;
}

test("a generated, conformed attempt exists (deterministic local fixture, mock provider)", async ({
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
  await card.getByTestId("create-conform").click();
  await expect(card.getByTestId("delivery-size")).toContainText("192×80", { timeout: 60_000 });
  const href = await card.getByTestId("open-brief").getAttribute("href");
  continuityPath = `${href}/continuity`;
  expect(continuityPath).toMatch(/\/generations\/[0-9a-f-]{36}\/continuity$/);
});

test("the continuity page keeps deterministic QA, semantic analysis and human review separate", async ({
  page,
}) => {
  await page.goto(continuityPath);
  await expect(page.getByTestId("qa-status-strip")).toBeVisible();
  await expect(page.getByTestId("status-semantic")).toContainText("not run");
  await expect(page.getByTestId("status-human")).toContainText("not reviewed");
});

test("preview shows exactly what would be analysed, what stays unchecked and the cost, before anything runs", async ({
  page,
}) => {
  await page.goto(continuityPath);
  const launcher = page.getByTestId("analysis-launcher");
  await expect(launcher).toBeVisible();
  // free mock analyzer: no spend, no acknowledgement
  await expect(page.getByTestId("estimated-analysis-cost")).toContainText("$0");
  await expect(page.getByTestId("analysis-unsupported")).toContainText("lip_sync");
  await expect(page.getByTestId("analysis-unsupported")).toContainText("never inferred as pass");
  await expect(page.getByTestId("run-analysis")).toBeEnabled();

  // Gemini is visible but NOT runnable here: no credential
  await page.getByTestId("analyzer-select").selectOption("gemini");
  await expect(page.getByTestId("analyzer-unavailable")).toContainText("GEMINI_API_KEY");
  await expect(page.getByTestId("run-analysis")).toBeDisabled();
  await expect(page.getByTestId("privacy-note")).toContainText("External analyzer receives");
  await expect(page.getByTestId("estimated-analysis-cost")).not.toHaveText("$0 (free)");
});

test("queued mock analysis: worker completes, findings + evidence appear, mock label everywhere", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto(continuityPath);
  await page.getByTestId("run-analysis").click();
  // live progress, then complete (the in-process worker plays the role of `npm run continuity:worker`)
  await expect(page.getByTestId("status-semantic")).toContainText(/complete|Complete/, { timeout: 90_000 });
  await expect(page.getByTestId("criteria")).toBeVisible();
  await expect(page.getByTestId("qa-lines")).toContainText("MOCK ANALYSIS");

  // grouped by severity, results ordered; analyzer findings are labelled and cite their evidence source
  await expect(page.locator('[data-testid^="group-"]').first()).toBeVisible();
  // criteria that were actually JUDGED (pass/warn/fail); the rest stay unchecked with their reason
  const analysed = page.locator(
    '[data-testid="criterion"]:not([data-result="unchecked"]):not([data-result="n_a"])',
    { hasText: "MOCK ANALYSIS" },
  );
  await expect(analysed.first()).toBeVisible();
  await expect(
    page.locator('[data-testid="criterion"][data-result="unchecked"]', { hasText: "no_media" }).first(),
  ).toBeVisible();
  await expect(analysed.first().getByTestId("evidence-source").first()).toContainText(/OUTPUT FRAME/);
  await expect(page.getByTestId("run-cost")).toContainText("actual $0");
  // a separate analysis cost, deterministic checks untouched
  await expect(page.locator('[data-testid="criterion"][data-key="aspect_ratio"]')).toHaveAttribute(
    "data-result",
    "pass",
  );
  // nothing was approved or rejected
  await expect(page.getByTestId("chip-creative").first())
    .toContainText("unreviewed")
    .catch(() => undefined);
});

test("human override is appended; the analyzer finding stays; a re-run is a separate history entry", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto(continuityPath);
  const target = page
    .locator('[data-testid="criterion"]:not([data-result="unchecked"]):not([data-result="n_a"])', {
      hasText: "MOCK ANALYSIS",
    })
    .first();
  const system = (await target.getByTestId("system-result").textContent())!.trim();
  await target.getByRole("combobox").selectOption(system.toLowerCase().startsWith("pass") ? "fail" : "pass");
  await target.getByPlaceholder("Note").fill("Warm lobby light; footage confirms it is correct.");
  await target.getByTestId("override-submit").click();
  await expect(target.getByTestId("override-note")).toContainText("Human:", { timeout: 20_000 });
  await expect(target.getByTestId("system-result")).toHaveText(system);

  // reload: both the analyzer's result and the human decision remain
  await page.reload();
  const again = page.locator('[data-testid="criterion"]', { hasText: "Warm lobby light" }).first();
  await expect(again.getByTestId("override-note")).toContainText("Human:");
  await expect(again.getByTestId("system-result")).toHaveText(system);

  // re-run: a NEW run, the old one is untouched
  await page.getByTestId("run-analysis").click();
  await expect(page.locator('[data-testid="history-row"]')).toHaveCount(2, { timeout: 90_000 });
  await expect(page.getByTestId("status-semantic")).toContainText(/complete/i, { timeout: 90_000 });
  const rows = page.locator('[data-testid="history-row"]');
  await expect(rows.nth(0)).toContainText("mock-continuity");
  await expect(rows.nth(1)).toContainText("Run 1");
  // opening run 1 still shows the override
  await rows.nth(1).getByRole("link").click();
  await expect(page.getByTestId("override-note").first()).toContainText("Human:");
});

test("OpenAI (gpt-6-luna, fake transport): preview, acknowledged paid submit, findings, cost, override, history", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto(continuityPath);
  await page.getByTestId("analyzer-select").selectOption("openai");
  // provider and model are explicit; health is informational
  await expect(page.getByTestId("privacy-provider")).toHaveText("OpenAI");
  await expect(page.getByTestId("privacy-model")).toHaveText("GPT-6 Luna");
  await expect(page.getByTestId("privacy-note")).toContainText("External analyzer receives");
  await expect(page.getByTestId("provider-health")).toContainText("OpenAI");
  await expect(page.getByTestId("analysis-summary")).toContainText("gpt-6-luna");
  // criteria / cost are previewed before anything is queued (demo fixtures carry no reference images)
  await expect(page.getByTestId("count-analysed")).not.toHaveText("0");
  await expect(page.getByTestId("estimated-analysis-cost")).not.toHaveText("$0 (free)");
  // paid analysis needs an explicit acknowledgement
  await expect(page.getByTestId("run-analysis")).toBeDisabled();
  await page.getByTestId("ack-analysis-spend").check();
  await expect(page.getByTestId("run-analysis")).toBeEnabled();
  await page.getByTestId("run-analysis").click();
  // wait for THIS run first: until the page refreshes, the previous Mock run's "complete" would satisfy the next check
  await expect(page.locator('[data-testid="history-row"]')).toHaveCount(3, { timeout: 90_000 });
  await expect(page.getByTestId("status-semantic")).toContainText(/openai.*complete/i, { timeout: 90_000 });

  // findings are labelled by provider; cost is the analysis ledger, separate from generation
  await expect(page.getByTestId("run-cost")).toContainText("actual $");
  const judged = page
    .locator('[data-testid="criterion"]:not([data-result="unchecked"]):not([data-result="n_a"])', {
      hasText: "openai analysis",
    })
    .first();
  await expect(judged).toBeVisible();
  const system = (await judged.getByTestId("system-result").textContent())!.trim();

  // a human override is separate from the analyzer result and survives a reload
  await judged.getByRole("combobox").selectOption(system.toLowerCase().startsWith("pass") ? "fail" : "pass");
  await judged.getByPlaceholder("Note").fill("OpenAI finding reviewed by a person.");
  await judged.getByTestId("override-submit").click();
  await expect(judged.getByTestId("override-note")).toContainText("Human:", { timeout: 20_000 });
  await expect(judged.getByTestId("system-result")).toHaveText(system);
  await page.reload();
  const again = page.locator('[data-testid="criterion"]', { hasText: "OpenAI finding reviewed" }).first();
  await expect(again.getByTestId("system-result")).toHaveText(system);

  // history retains provider + model next to the earlier mock runs
  const rows = page.locator('[data-testid="history-row"]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("openai");
  await expect(rows.nth(0)).toContainText("gpt-6-luna");
  await expect(rows.nth(1)).toContainText("mock-continuity");
  await expect(page.getByTestId("external-manifest")).toContainText("OpenAI");
  await expect(page.getByTestId("external-manifest")).toContainText("GPT-6 Luna");

  // the launcher banner speaks for the LATEST job: a newer success is never shadowed by an older failure
  await expect(page.getByTestId("analysis-failed")).toHaveCount(0);
  // health stays informational and visible for every analyzer, with history intact
  const openaiRow = page.locator('[data-testid="provider-health-row"][data-provider="openai"]');
  await expect(openaiRow).toContainText("last analysis succeeded");
  await expect(openaiRow).toHaveAttribute("data-health", "available");
});

test("provider health is visible for every analyzer even while Mock is the selected analyzer", async ({
  page,
}) => {
  await page.goto(continuityPath);
  await expect(page.getByTestId("analyzer-select")).toHaveValue(/mock/);
  const list = page.getByTestId("provider-health-list");
  await expect(list).toBeVisible();
  const rows = list.getByTestId("provider-health-row");
  await expect(rows).toHaveCount(3);
  await expect(list.locator('[data-provider="openai"]')).toBeVisible();
  await expect(list.locator('[data-provider="gemini"]')).toBeVisible();
  await expect(list).toContainText("available (free, local)");
  // informational only: nothing in the list is a control
  await expect(list.getByRole("button")).toHaveCount(0);
  await expect(list.getByRole("combobox")).toHaveCount(0);
});

test("the attempt card shows the continuity chip separately from creative approval", async ({ page }) => {
  await openGenerate(page);
  const card = page.getByTestId("attempt-card").first();
  await expect(card.getByTestId("chip-continuity")).not.toContainText("not started");
  await expect(card.getByTestId("chip-creative")).toContainText("unreviewed");
});

// ── Phase 3A.1: Shot QA decision layer (advisory; free Mock / fake analysis only) ──

test("Shot QA answers first; a reviewer FAIL makes a mismatch and a suggestion; creative review stays the human's", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto(continuityPath);
  const summary = page.getByTestId("shot-qa-summary");
  await expect(summary).toBeVisible();
  // the answer sits above the detailed criterion workspace
  const summaryBox = (await summary.boundingBox())!;
  const criteriaBox = (await page.getByTestId("criteria").boundingBox())!;
  expect(summaryBox.y).toBeLessThan(criteriaBox.y);
  await expect(page.getByTestId("shot-qa-counts")).toContainText("Critical mismatches");
  await expect(page.getByTestId("shot-qa-authority")).toContainText("never approves or rejects");

  // a person records a FAIL on a critical criterion the system did not fail
  const candidate = page
    .locator('[data-testid="criterion"][data-severity="critical"]:not([data-result="fail"])')
    .first();
  const key = (await candidate.getAttribute("data-key"))!;
  // pinned by key: once overridden to FAIL the row no longer matches the selector above
  const target = page.locator(`[data-testid="criterion"][data-key="${key}"]`);
  const system = (await target.getByTestId("system-result").textContent())!.trim();
  await target.getByRole("combobox").selectOption("fail");
  await target.getByPlaceholder("Note").fill("Wrong earrings in the close-up.");
  await target.getByTestId("override-submit").click();
  await expect(target.getByTestId("override-note")).toContainText("Human: Fail", { timeout: 20_000 });

  await expect(summary).toHaveAttribute("data-state", "critical_mismatch");
  await expect(page.getByTestId("shot-qa-state")).toContainText("Critical mismatch");
  const issue = summary.locator(`[data-testid="shot-qa-issue"][data-key="${key}"]`);
  await expect(issue).toHaveAttribute("data-kind", "fail");
  await expect(issue.getByTestId("shot-qa-issue-override")).toContainText("reviewer: fail");
  const suggestion = summary.locator(`[data-testid="shot-qa-suggestion"][data-key="${key}"]`);
  await expect(suggestion).toContainText("Reviewer: Wrong earrings in the close-up.");
  // the system's own finding is unchanged
  await expect(target.getByTestId("system-result")).toHaveText(system);

  // the Attempt card: the QA answer, a link to the evidence, an offered (never filled-in) reason
  await openGenerate(page);
  const card = page.getByTestId("attempt-card").first();
  await expect(card.getByTestId("card-shot-qa-state")).toContainText("Critical mismatch");
  await expect(card.getByTestId("card-review-qa")).toHaveAttribute("href", continuityPath);
  await expect(card.getByTestId("approval-advisory")).toContainText("Shot QA: Critical mismatch");
  await expect(card.getByTestId("chip-creative")).toContainText("unreviewed");
  await card.getByTestId("reject-toggle").click();
  await expect(card.getByTestId("reject-suggestions")).toContainText("Wrong earrings in the close-up.");
  await expect(card.getByTestId("reject-reason")).toHaveValue("");

  // the human can still approve despite the AI FAIL, and clear it again: QA never decides
  await expect(card.getByTestId("approve-button")).toBeEnabled();
  await card.getByTestId("approve-button").click();
  await expect(card.getByTestId("chip-creative")).toContainText("approved", { timeout: 20_000 });
  await expect(card.getByTestId("card-shot-qa-state")).toContainText("Critical mismatch");
  await card.getByRole("button", { name: "Clear review" }).click();
  await expect(card.getByTestId("chip-creative")).toContainText("unreviewed", { timeout: 20_000 });

  // a later PASS decision removes the issue and its suggestion; the system finding stays as recorded
  await page.goto(continuityPath);
  const again = page.locator(`[data-testid="criterion"][data-key="${key}"]`);
  await again.getByRole("combobox").selectOption("pass");
  await again.getByPlaceholder("Note").fill("Checked against the Lock: correct earrings.");
  await again.getByTestId("override-submit").click();
  await expect(again.getByTestId("override-note")).toContainText("Human: Pass", { timeout: 20_000 });
  await expect(summary.locator(`[data-testid="shot-qa-issue"][data-key="${key}"]`)).toHaveCount(0);
  await expect(summary.locator(`[data-testid="shot-qa-suggestion"][data-key="${key}"]`)).toHaveCount(0);
  await expect(again.getByTestId("system-result")).toHaveText(system);
});

test("Shot QA goes stale when the judged output changes, and is current again when it is restored", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openGenerate(page);
  const card = page.getByTestId("attempt-card").first();
  await expect(card.getByTestId("card-shot-qa-state")).not.toContainText("QA stale");
  await card.getByRole("button", { name: "Use original as delivery master" }).click();
  await expect(card.getByTestId("card-shot-qa-state")).toContainText("QA stale", { timeout: 20_000 });

  await page.goto(continuityPath);
  const summary = page.getByTestId("shot-qa-summary");
  await expect(summary).toHaveAttribute("data-state", "qa_stale");
  await expect(page.getByTestId("shot-qa-stale-reasons")).toContainText("delivery conform changed");
  await expect(page.getByTestId("shot-qa-suggestions")).toHaveCount(0);

  // restore the conformed delivery master: the same run describes the current output again
  await openGenerate(page);
  const restored = page.getByTestId("attempt-card").first();
  await restored.getByRole("button", { name: "Use as delivery master" }).first().click();
  await expect(restored.getByTestId("card-shot-qa-state")).not.toContainText("QA stale", { timeout: 20_000 });
  await expect(restored.getByTestId("chip-creative")).toContainText("unreviewed");
});

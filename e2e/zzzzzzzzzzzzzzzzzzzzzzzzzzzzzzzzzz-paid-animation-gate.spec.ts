import { expect, test, type Page } from "@playwright/test";
import { negativePhrasing } from "../src/domain/generation/provider-prompt";

/**
 * The PAID animation gate, through the UI, on its own memory server (memory-paid-gate-isolated, port 3117).
 *
 * That server lists Runway as a worker-backed provider with paid generation enabled and NO credential: the Runway
 * secret is explicitly empty and there is no Runway worker, so the real paid rows are selectable while no request can
 * leave the process (playwright.config.ts). THIS SPEC NEVER SUBMITS A PAID CANDIDATE. It reads what the gate shows
 * and what it requires; the only models it generates with are the free mocks.
 *
 *   A  Shot 3A from the pristine seed: no Production Frame, and every reference is described in words only
 *   B  Generate a Production Frame with the free default image model while no reference image exists → conform →
 *      Use as Production Frame → the reference check reports the frame as generated from words only (not verified)
 *   C  Runway Gen-4.5: the estimate, the exact prompt that would be sent (visible-motion v2, no negation), and
 *      "Check before you spend": Generate stays disabled with the general acknowledgement AND the total confirmed,
 *      until the check itself is confirmed. Deselecting the paid model removes it. A free model is never gated.
 *   D  A free mock clip, rejected in the Shot Clip panel: the rejection and its reason stay visible there, it cannot
 *      be rejected twice, and it is not mistaken for a rejected paid take
 */
test.describe.configure({ mode: "serial" });

const EP = "/projects/ojousama/episodes/ep-1";
const GEN45 = "gen4.5";

const panel = (page: Page) => page.getByTestId("animate-panel");
const row = (page: Page, model: string) =>
  panel(page).locator(`[data-testid="model-row"][data-model="${model}"]`);
const check = (page: Page) => page.getByTestId("reference-check");

let shotUrl = "";

test("A — Shot 3A without a Production Frame: the reference check says what exists, in words only", async ({
  page,
}) => {
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: "3A", exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  shotUrl = page.url().split("?")[0]!;

  await page.goto(`${shotUrl}?section=animate`);
  await expect(check(page)).toHaveAttribute("data-lineage", "none");
  await expect(check(page)).toHaveAttribute("data-verified", "0");
  // the seed's identity, Look and Location entries have no stored image: nothing is presented as a reference
  const slots = check(page).getByTestId("reference-slot");
  await expect(slots).toHaveCount(3);
  for (const slot of await slots.all()) await expect(slot).toHaveAttribute("data-status", "missing");
  await expect(check(page).getByTestId("reference-origin")).toHaveCount(0);
});

test("B — a Production Frame generated without any reference image is reported as words only", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto(`${shotUrl}?section=production_frame`);
  // Prism suggests a free model first, even with paid models available: nothing here can cost anything
  await expect(page.getByTestId("shot-image-model")).toHaveValue("mock/mock-image-1");
  await page.getByTestId("shot-generate-image").click();
  await page.waitForURL(/\/candidates\/[0-9a-f-]{36}/, { timeout: 60_000 });
  const stills = page.getByTestId("shot-generated-still");
  await expect
    .poll(async () => (await page.goto(`${shotUrl}?section=production_frame`), stills.count()), {
      timeout: 120_000,
      intervals: [2000],
    })
    .toBeGreaterThan(0);
  const attempt = await stills.first().getAttribute("data-attempt");
  const fresh = page.locator(`[data-testid="shot-generated-still"][data-attempt="${attempt}"]`);
  // 3A is 2.39:1: the production conform comes first (never a silent crop), then the promotion
  await fresh.getByTestId("shot-create-conform").click();
  await expect
    .poll(
      async () => (
        await page.goto(`${shotUrl}?section=production_frame`),
        fresh.getByTestId("shot-use-as-production-frame").count()
      ),
      { timeout: 60_000, intervals: [1500] },
    )
    .toBe(1);
  await fresh.getByTestId("shot-use-as-production-frame").click();
  await expect
    .poll(
      async () => (
        await page.goto(`${shotUrl}?section=production_frame`),
        page.locator('[data-testid="shot-generated-still"][data-current="true"]').count()
      ),
      { timeout: 60_000, intervals: [1500] },
    )
    .toBe(1);

  await page.goto(`${shotUrl}?section=animate`);
  await expect(panel(page)).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  await expect(check(page)).toHaveAttribute("data-lineage", "unreferenced");
  await expect(check(page)).toHaveAttribute("data-verified", "0");
  await expect(check(page).getByTestId("reference-lineage")).toContainText(
    "every appearance in it comes from words only",
  );
});

test("C — Runway Gen-4.5: the exact prompt, the estimate, and a check that must be confirmed on its own", async ({
  page,
}) => {
  await page.goto(`${shotUrl}?section=animate`);
  await expect(panel(page)).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  // paid rows are selectable here and priced before anything is chosen
  await expect(row(page, GEN45).getByTestId("model-pick")).toBeEnabled();
  // the creator's price: 3 × Prism's cost ($0.60 and $0.25)
  await expect(row(page, GEN45).getByTestId("model-cost")).toContainText("$1.80");
  await expect(row(page, "gen4_turbo").getByTestId("model-cost")).toContainText("$0.75");

  // the exact text Runway would receive: the positive, motion-only policy; never a negation (Runway reads one as
  // the thing to do) and never the appearance the Production Frame already shows
  const prompt = panel(page).locator(`[data-testid="animate-provider-prompt"][data-model="runway/${GEN45}"]`);
  await expect(prompt.locator("summary")).toContainText("visible-motion v2");
  const sent = (await prompt.getByTestId("animate-provider-prompt-text").textContent()) ?? "";
  expect(sent).toContain("The locked-off camera remains perfectly still.");
  expect(sent.length).toBeGreaterThan(100);
  expect(sent.length).toBeLessThanOrEqual(1000);
  expect(negativePhrasing(sent)).toBeNull();
  expect(sent).not.toMatch(/gown|earring|lobby|hair/i);

  const generate = panel(page).getByTestId("create-candidate-set");
  const checks = panel(page).getByTestId("pre-spend-checks");
  await expect(generate).toBeDisabled();
  await expect(checks).toHaveCount(0);

  await row(page, GEN45).getByTestId("model-pick").check();
  await expect(panel(page).getByTestId("selected-total")).toContainText("$1.80");
  await expect(checks).toBeVisible();
  const item = panel(page).getByTestId("pre-spend-check");
  await expect(item).toHaveCount(1);
  await expect(item).toHaveAttribute("data-check", "references.essential_missing");
  await expect(item).toContainText("No stored reference image for Yumeko");

  // everything ELSE confirmed (what the model will not use, and the total): the check is still its own decision
  await panel(page).getByTestId("ack-all").check();
  await panel(page).getByTestId("confirm-total").check();
  await expect(generate).toBeDisabled();
  await panel(page).getByTestId("ack-pre-spend").check();
  await expect(generate).toBeEnabled();

  // NEVER pressed. Deselecting the paid model removes the check and the total.
  await row(page, GEN45).getByTestId("model-pick").uncheck();
  await expect(checks).toHaveCount(0);
  await expect(generate).toBeDisabled();

  // a free model is never gated by it
  await row(page, "mock-video-1").getByTestId("model-pick").check();
  await expect(checks).toHaveCount(0);
  await expect(panel(page).getByTestId("selected-total")).toContainText("free");
});

test("D — a rejected clip stays rejected, with its reason, in the Shot Clip panel", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(`${shotUrl}?section=animate`);
  await row(page, "mock-video-1").getByTestId("model-pick").check();
  await panel(page).getByTestId("ack-all").check();
  await panel(page).getByTestId("create-candidate-set").click();
  await page.waitForURL(/\/candidates\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(page.getByTestId("set-rollup")).toContainText("1/1 completed", { timeout: 120_000 });

  await page.goto(`${shotUrl}?section=animate`);
  const first = page.getByTestId("shot-clip-candidate").first();
  await expect(first).toBeVisible();
  const attempt = await first.getAttribute("data-attempt");
  const clip = page.locator(`[data-testid="shot-clip-candidate"][data-attempt="${attempt}"]`);
  await expect(clip.getByTestId("shot-clip-rejected")).toHaveCount(0);
  await clip.locator('select[name="negative"]').selectOption("body_motion");
  await clip.getByTestId("reject-clip").click();
  await expect
    .poll(
      async () => (
        await page.goto(`${shotUrl}?section=animate`),
        clip.getByTestId("shot-clip-rejected").count()
      ),
      { timeout: 30_000, intervals: [1000] },
    )
    .toBe(1);
  await expect(clip.getByTestId("shot-clip-rejected")).toContainText(/rejected: body motion/i);
  await expect(clip.getByTestId("reject-clip")).toHaveCount(0);

  // a rejected FREE take is not a rejected paid take: Gen-4.5 still shows the reference check and nothing else
  await row(page, GEN45).getByTestId("model-pick").check();
  const item = panel(page).getByTestId("pre-spend-check");
  await expect(item).toHaveCount(1);
  await expect(item).toHaveAttribute("data-check", "references.essential_missing");
  await row(page, GEN45).getByTestId("model-pick").uncheck();
});

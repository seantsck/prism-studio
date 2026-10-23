import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Phase 2G.5 Shot Sequence Board, memory mode, through the UI. A read-only projection of Shot Prep truth plus ONE
 * explicit write (the continuity-link sync). No provider, AI analysis, 3D set or GPU. Runs after the Character
 * Continuity spec, so Shot 4C shows its Continuity Lock and its "Doorway" Location View.
 *
 *   open Sequence → cards in the Storyboard's order, labelled visuals, Lock + View on 4C
 *   → drag 1C before 1B (Scene 1) → order changes, previousShotId is NOT touched → link mismatches shown
 *   → compare the new cut → open the sync preview → confirm → mismatches gone, dependent Storyboards now stale
 *   → restore: drag back + sync again → the seed's links and freshness are back
 */

const EP = "/projects/ojousama/episodes/ep-1";
test.describe.configure({ mode: "serial" });

const cards = (page: Page) => page.getByTestId("sequence-card");
const card = (page: Page, code: string) =>
  page.locator(`[data-testid="sequence-card"][data-shot-code="${code}"]`);
const codes = async (scope: Locator) =>
  scope.evaluateAll((els) => els.map((e) => e.getAttribute("data-shot-code") ?? ""));

async function openSequence(page: Page) {
  await page.goto(`${EP}/sequence`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Sequence");
  await expect(page.getByTestId("sequence-summary")).toBeVisible();
}

/** Drags `code`'s handle onto `onto`'s card (dnd-kit pointer sensor), then waits for the saved order. */
async function drag(page: Page, code: string, onto: string) {
  const handle = page
    .locator("[data-sortable-item]")
    .filter({ has: card(page, code) })
    .getByRole("button", { name: "Drag to reorder" });
  const from = (await handle.boundingBox())!;
  const to = (await card(page, onto).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 10, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect(page.getByText("Saving order…")).toHaveCount(0, { timeout: 30_000 });
}

async function sync(page: Page, expectChanges: string[]) {
  const panel = page.getByTestId("sequence-sync");
  await expect(panel).toBeVisible();
  await panel.getByText(/Review \d+ link change/).click();
  const items = panel.getByTestId("sequence-sync-changes").locator("li");
  await expect(items).toHaveText(expectChanges);
  await expect(panel).toContainText(
    "may make existing Storyboard Frames, Production Frames and generations stale",
  );
  await panel.getByTestId("sequence-sync-confirm").click();
  await expect(page.getByTestId("sequence-sync")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("sequence-summary-link-mismatches")).toHaveText("0");
}

test("the board: cards in cut order, truthful visual labels, Lock and Location View anchors", async ({
  page,
}) => {
  await page.goto(`${EP}/storyboard`);
  const storyboardOrder = await page
    .locator("[data-sortable-item] a[href*='/shots/'] span.font-mono")
    .evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ""));

  await openSequence(page);
  // nav: Storyboard → Sequence → Animatic
  const tabs = await page.locator("nav a").evaluateAll((els) => els.map((e) => e.textContent?.trim()));
  expect(tabs.indexOf("Sequence")).toBe(tabs.indexOf("Storyboard") + 1);
  expect(tabs.indexOf("Animatic")).toBe(tabs.indexOf("Sequence") + 1);

  expect(await codes(cards(page))).toEqual(storyboardOrder);
  await expect(page.getByTestId("sequence-summary-shots")).toHaveText(String(storyboardOrder.length));
  await expect(page.getByTestId("sequence-summary-link-mismatches")).toHaveText("0");
  await expect(page.getByTestId("sequence-scene").first()).toContainText("Scene 1 —");

  // every card says what its image IS; a Storyboard is never called a Production Frame
  const LABEL = {
    production_frame: /^Production Frame v\d+$/,
    approved_storyboard: /^Storyboard fallback v\d+$/,
    draft_storyboard: /^Draft Storyboard v\d+$/,
    none: /^No production image$/,
  } as const;
  const kinds = new Set<string>();
  for (const c of await cards(page).all()) {
    const kind = (await c.getAttribute("data-visual-kind")) as keyof typeof LABEL;
    kinds.add(kind);
    await expect(c.getByTestId("sequence-visual-label")).toHaveText(LABEL[kind]);
    if (kind !== "production_frame") await expect(c).toHaveAttribute("data-pf-status", "missing");
  }
  expect([...kinds]).toEqual(expect.arrayContaining(["production_frame", "approved_storyboard", "none"]));
  await expect(card(page, "2A").getByTestId("sequence-visual")).toContainText("NO PRODUCTION IMAGE");

  // 4C: the Production Frame made in 2G.4, its Continuity Lock and its Location View
  const c4 = card(page, "4C");
  await expect(c4).toHaveAttribute("data-visual-kind", "production_frame");
  await expect(c4.getByTestId("sequence-pf-status")).toContainText(/current|stale/);
  await expect(c4.getByTestId("sequence-location-view")).toHaveText("Doorway");
  await expect(c4.getByTestId("sequence-character-lock")).toContainText("🔒 Yumeko — Ivory Suit");
  // images only through the private asset route
  for (const src of await page
    .locator("[data-testid='sequence-visual'] img")
    .evaluateAll((els) => els.map((e) => e.getAttribute("src") ?? "")))
    expect(src).toMatch(/^\/api\/assets\/[0-9a-f-]+$/);
});

test("reorder within a Scene: the order changes, the stored links do not; mismatches are shown", async ({
  page,
}) => {
  await openSequence(page);
  const scene1 = page.locator(
    "[data-testid='sequence-scene'][data-scene-number='1'] [data-testid='sequence-card']",
  );
  expect(await codes(scene1)).toEqual(["1A", "1B", "1C"]);
  await expect(card(page, "1C")).toHaveAttribute("data-stale", "false");

  await drag(page, "1C", "1B");
  await page.reload();
  expect(await codes(scene1)).toEqual(["1A", "1C", "1B"]);
  // the reorder did not sync anything: three Shots now disagree with the order
  await expect(page.getByTestId("sequence-summary-link-mismatches")).toHaveText("3");
  for (const code of ["1C", "1B", "2A"])
    await expect(card(page, code)).not.toHaveAttribute("data-link-status", "synced");
  await expect(card(page, "1C").getByTestId("sequence-link-mismatch")).toBeVisible();
  await expect(card(page, "1C").getByTestId("sequence-card-link")).toContainText(
    "stores previous 1B (sequence: 1A)",
  );

  // the new cut, side by side
  await card(page, "1C").getByTestId("sequence-compare-link").click();
  const compare = page.getByTestId("sequence-compare");
  await expect(compare).toHaveAttribute("data-from", "1A");
  await expect(compare).toHaveAttribute("data-to", "1C");
  await expect(compare.locator("[data-severity='error'][data-category='sequence_link']")).toHaveCount(1);
  await expect(compare.getByTestId("sequence-visual")).toHaveCount(2);
});

test("explicit sync: preview → confirm → links follow the order; dependent Storyboards become stale by themselves", async ({
  page,
}) => {
  await openSequence(page);
  await expect(page.getByTestId("sequence-sync-preview")).not.toHaveAttribute("open", "");
  await sync(page, ["1C: 1B → 1A", "1B: 1A → 1C", "2A: 1C → 1B"]);
  await page.reload();
  for (const code of ["1A", "1C", "1B", "2A"])
    await expect(card(page, code)).toHaveAttribute("data-link-status", "synced");
  // nothing was marked by hand: the changed continuity part stales the approved Storyboards of 1C and 1B
  for (const code of ["1C", "1B"]) {
    await expect(card(page, code)).toHaveAttribute("data-stale", "true");
    await expect(card(page, code).getByTestId("sequence-stale")).toBeVisible();
    await card(page, code).getByTestId("sequence-stale-details").locator("summary").click();
    await expect(card(page, code).getByTestId("sequence-stale-details")).toContainText("Continuity changed");
  }
  await page.getByTestId("sequence-filter-stale").click();
  await expect(card(page, "1C")).toBeVisible();
  await expect(card(page, "1A")).toBeHidden();
  await page.getByTestId("sequence-filter-all").click();
  await expect(card(page, "1A")).toBeVisible();
});

test("restore: drag back and sync again: the seed order, links and freshness return", async ({ page }) => {
  await openSequence(page);
  await drag(page, "1B", "1C");
  await page.reload();
  const scene1 = page.locator(
    "[data-testid='sequence-scene'][data-scene-number='1'] [data-testid='sequence-card']",
  );
  expect(await codes(scene1)).toEqual(["1A", "1B", "1C"]);
  await sync(page, ["1B: 1C → 1A", "1C: 1A → 1B", "2A: 1B → 1C"]);
  await page.reload();
  for (const code of ["1B", "1C"]) await expect(card(page, code)).toHaveAttribute("data-stale", "false");
  await expect(page.getByTestId("sequence-summary-link-mismatches")).toHaveText("0");
});

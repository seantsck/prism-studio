import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * Phase 3A.4B Continuity Supervisor, memory mode, through the UI: the actual cuts of the persisted Episode Edit,
 * deterministic review only. No provider call of any kind (REAL GEMINI / OPENAI / GENERATION CALLS: 0), no generation,
 * no media derivation: the seed's proposal (Storyboard placeholders and empty items) is created as the edit and read.
 *
 * ISOLATED STORE: this spec runs in its own Playwright project against its own memory server (playwright.config.ts,
 * port 3107), because it creates the Episode's edit and reorders it.
 *
 * Current Shot QA is not loaded by the Supervisor in 3A.4B (it keeps to the Episode Edit's own read path), so
 * `cut:shot_qa` never appears here; video sides link to their Shot QA page instead (no video side here).
 */

const EP = "/projects/ojousama/episodes/ep-1";
test.describe.configure({ mode: "serial" });

const rows = (page: Page) => page.locator('[data-testid="cut-row"]');
const row = (page: Page, title: string) =>
  page.locator('[data-testid="cut-row"]', {
    has: page.getByTestId("cut-title").getByText(title, { exact: true }),
  });
const editOrder = (page: Page) =>
  page
    .locator('[data-testid="edit-item"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-shot-code")!));
const revisionOf = async (page: Page) =>
  Number(((await page.getByTestId("edit-revision").textContent()) ?? "").replace("Revision ", ""));

/** Every non-GET request the browser sends while `run` executes (a server action is a POST). */
async function writesDuring(page: Page, run: () => Promise<void>): Promise<string[]> {
  const writes: string[] = [];
  const listener = (r: Request) => {
    if (r.method() !== "GET" && r.method() !== "HEAD") writes.push(`${r.method()} ${r.url()}`);
  };
  page.on("request", listener);
  try {
    await run();
  } finally {
    page.off("request", listener);
  }
  return writes;
}

test("no persisted edit: a truthful empty state, no invented cuts; a proposal shows no cut markers", async ({
  page,
}) => {
  const writes = await writesDuring(page, async () => {
    await page.goto(`${EP}/continuity`);
    await expect(page.getByTestId("continuity-no-edit")).toBeVisible();
    await expect(
      page.getByText(
        "Sequence Continuity needs a persisted Episode Edit because the edit determines the actual cuts.",
      ),
    ).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open the Episode Edit" })).toHaveAttribute(
      "href",
      `${EP}/edit`,
    );
    await expect(page.getByRole("link", { name: "Sequence Board (planned order)" })).toHaveAttribute(
      "href",
      `${EP}/sequence`,
    );

    await page.goto(`${EP}/edit`);
    await expect(page.getByTestId("episode-edit-proposal")).toBeVisible();
    await expect(page.getByTestId("cut-marker")).toHaveCount(0);
  });
  expect(writes).toEqual([]);
  // still no edit: reading created nothing
  await page.goto(`${EP}/continuity`);
  await expect(page.getByTestId("continuity-no-edit")).toBeVisible();
});

test("the persisted edit shows one cut marker per cut; a marker opens the Supervisor at that cut", async ({
  page,
}) => {
  await page.goto(`${EP}/edit`);
  await page.getByTestId("create-episode-edit").click();
  await expect(page.getByTestId("episode-edit-persisted")).toBeVisible();
  await expect(page.getByTestId("edit-revision")).toHaveText("Revision 0");
  const codes = await editOrder(page);
  expect(codes).toHaveLength(14);
  const markers = page.getByTestId("cut-marker");
  await expect(markers).toHaveCount(13);

  // the marker into 1C (cut 1B → 1C: the declared Location changes) is a warning, with an accessible label
  const marker = markers.nth(codes.indexOf("1C") - 1);
  await expect(marker).toHaveAttribute("data-tone", "warn");
  await expect(marker).toHaveAccessibleName(/^Cut 1B → 1C: \d+ deterministic warnings?\. Review this cut/);
  const anchor = (await marker.getAttribute("data-anchor"))!;
  await marker.click();
  await expect(page).toHaveURL(new RegExp(`${EP}/continuity#${anchor}$`));
  const target = page.locator(`[id="${anchor}"]`);
  await expect(target.getByTestId("cut-title")).toHaveText("1B → 1C");
  await expect(target).toBeInViewport();
});

test("rows are the edit's actual cuts, in edit order, and say No sequence QA yet while showing deterministic warnings", async ({
  page,
}) => {
  await page.goto(`${EP}/edit`);
  const codes = await editOrder(page);
  await page.goto(`${EP}/continuity`);
  await expect(page.getByTestId("continuity-supervisor")).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Continuity Supervisor — / })).toBeVisible();
  await expect(page.getByText("Sequence Continuity review is manual", { exact: false })).toBeVisible();
  const titles = await page.getByTestId("cut-title").allTextContents();
  expect(titles).toEqual(codes.slice(1).map((c, i) => `${codes[i]} → ${c}`));
  await expect(page.getByTestId("count-cuts")).toContainText("13");
  await expect(page.getByTestId("continuity-runs-note")).toContainText("Nothing runs on page load");

  // the state is the no-run state; the warning is a finding, shown first
  const cut = row(page, "1B → 1C");
  await expect(cut.getByTestId("cut-state")).toHaveText("No sequence QA yet");
  await expect(cut).toHaveAttribute("data-has-warn", "true");
  await expect(cut.getByTestId("cut-attention")).toContainText(
    "Location Tokyo Night Streets → Black Luxury Sedan",
  );
  await expect(cut.getByTestId("cut-top-issue")).toContainText("⚠");
  // placeholders on both sides: their stills, never called an edge frame, and no promise of edge media for a still
  await expect(cut.getByTestId("cut-edge-frame")).toHaveCount(0);
  await expect(cut.getByTestId("cut-edge-media-note")).toHaveCount(0);
  await expect(page.getByTestId("count-semantic-media-blocked")).toContainText("13");
});

test("the Warnings filter keeps exactly the cuts with a deterministic WARN", async ({ page }) => {
  await page.goto(`${EP}/continuity`);
  const warned = await page.locator('[data-testid="cut-row"][data-has-warn="true"]').count();
  expect(warned).toBeGreaterThan(0);
  expect(warned).toBeLessThan(13);
  const button = page.getByTestId("cut-filter-warnings");
  await expect(button).toContainText(`(${warned})`);
  // the click lands only once the filter has hydrated: retry until it is pressed
  await expect(async () => {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator('[data-testid="cut-row"]:visible')).toHaveCount(warned);
  await expect(page.locator('[data-testid="cut-row"][data-has-warn="false"]:visible')).toHaveCount(0);
  await page.getByTestId("cut-filter-all").click();
  await expect(page.locator('[data-testid="cut-row"]:visible')).toHaveCount(13);
});

test("semantic criteria are unchecked (not analysed); across a Scene boundary they are Prism's n_a", async ({
  page,
}) => {
  await page.goto(`${EP}/continuity`);
  const inside = row(page, "1B → 1C");
  await inside.getByTestId("cut-semantic").locator("summary").click();
  const semantic = inside.getByTestId("cut-semantic");
  await expect(semantic).toContainText(
    "Sequence Continuity criteria stay unchecked until a review of this cut runs",
  );
  await expect(semantic.locator('[data-testid="cut-finding"][data-key="cut:axis"]')).toHaveAttribute(
    "data-result",
    "unchecked",
  );
  await expect(semantic.locator('[data-testid="cut-finding"][data-key="cut:axis"]')).toContainText(
    "Planning picture",
  );

  const cross = row(page, "1C → 2A");
  await expect(cross).toHaveAttribute("data-crosses-scene", "true");
  await expect(cross.getByTestId("cut-new-scene")).toBeVisible();
  await cross.getByTestId("cut-semantic").locator("summary").click();
  const axis = cross.locator('[data-testid="cut-finding"][data-key="cut:axis"]');
  await expect(axis).toHaveAttribute("data-result", "n_a");
  await expect(axis).toContainText("Scene changes at this cut.");
  await expect(page.locator('[data-testid="cut-row"][data-state="critical_break"]')).toHaveCount(0);
});

test("Sequence Board ↔ Supervisor navigation; reading every page writes nothing", async ({ page }) => {
  await page.goto(`${EP}/edit`);
  const revision = await revisionOf(page);
  const writes = await writesDuring(page, async () => {
    await page.goto(`${EP}/continuity`);
    await page.getByTestId("continuity-sequence-link").click();
    await expect(page).toHaveURL(new RegExp(`${EP}/sequence$`));
    await page.getByTestId("sequence-continuity-link").click();
    await expect(page).toHaveURL(new RegExp(`${EP}/continuity$`));
    await expect(page.getByTestId("continuity-supervisor")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("continuity-revision")).toHaveText(`Edit revision ${revision}`);
  });
  expect(writes).toEqual([]);
  // no transition run exists after any number of reads
  await expect(page.locator('[data-testid="cut-row"]:not([data-state="no_sequence_qa"])')).toHaveCount(0);
  await page.goto(`${EP}/edit`);
  await expect(page.getByTestId("edit-revision")).toHaveText(`Revision ${revision}`);
});

test("an explicit reorder in the edit changes the Supervisor's cuts (the edit is the authority)", async ({
  page,
}) => {
  await page.goto(`${EP}/edit`);
  const revision = await revisionOf(page);
  await page.locator('[data-testid="edit-item"][data-shot-code="2E"]').getByTestId("move-down").click();
  await expect(page.getByTestId("edit-revision")).toHaveText(`Revision ${revision + 1}`, { timeout: 15_000 });
  const codes = await editOrder(page);
  await page.goto(`${EP}/continuity`);
  expect(await page.getByTestId("cut-title").allTextContents()).toEqual(
    codes.slice(1).map((c, i) => `${codes[i]} → ${c}`),
  );
  await expect(row(page, "3A → 2E")).toHaveCount(1);
  await expect(page.getByTestId("continuity-info")).toContainText(
    "Edit order differs from the planned sequence.",
  );
});

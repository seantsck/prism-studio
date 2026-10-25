import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Phase 2I.1C Episode Edit, memory mode, through the UI. Read-only page + the one explicit write (create the edit).
 * No provider call of any kind (REAL RUNWAY / OPENAI / GEMINI CALLS: 0).
 *
 * ISOLATED STORE: this spec runs in its own Playwright project against its own memory server (playwright.config.ts,
 * port 3104): it starts from the pristine seed whatever else runs, and the edit it creates (persistent for the life of a
 * store) is never seen by another spec.
 *
 * Episode 1 of the seed: no edit → "Proposed initial assembly" (Storyboard placeholders, empty slots, Shot 2B's
 * approved clip without usable video said so, placed takes and explicit silence) → Create edit → the saved edit at
 * revision 0 survives a reload unchanged → selecting another take of Shot 3A's line on the Perform page does NOT move
 * the edit's pinned take: the edit reports "Take superseded" and stays at revision 0 → lineage and Scene runs.
 */

const EP = "/projects/ojousama/episodes/ep-1";
const LINE_3A = "もう帰りたい"; // Shot 3A's line: three takes in the seed
test.describe.configure({ mode: "serial" });

const item = (page: Page, code: string): Locator =>
  page.locator(`[data-testid="edit-item"][data-shot-code="${code}"]`);

async function pinnedTakeLabel(page: Page) {
  return (await item(page, "3A").getByTestId("item-audio").innerText()).match(/Take (\d+) ·/)?.[1];
}

test("no edit yet: the proposed initial assembly, labelled honestly, nothing saved", async ({ page }) => {
  await page.goto(`${EP}/edit`);
  await expect(page.getByTestId("episode-edit-proposal")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Proposed initial assembly" })).toBeVisible();
  await expect(page.getByText("Not an edit yet: nothing is saved.")).toBeVisible();
  await expect(page.locator('[data-testid="edit-item"]')).toHaveCount(14);

  await expect(item(page, "1A").getByTestId("item-kind")).toHaveText("Placeholder: Storyboard still");
  await expect(item(page, "2A").getByTestId("item-kind")).toHaveText("No picture yet");
  // no still is ever called video
  await expect(page.getByTestId("item-kind").filter({ hasText: "Generated clip" })).toHaveCount(0);
  await expect(item(page, "2B").getByTestId("item-notes")).toContainText("has no usable video");
  // performance: placed takes and explicit silence
  await expect(item(page, "1A").getByTestId("item-silence")).toHaveText("Silence (no placed take)");
  await expect(item(page, "3A").getByTestId("item-audio")).toContainText(LINE_3A);
  await expect(item(page, "3A").getByTestId("item-audio")).toContainText("Clip audio muted");
  await expect(page.getByTestId("edit-runs")).toContainText("Scene 1");
  await expect(page.getByTestId("edit-total")).toContainText("Total");

  // reading again changes nothing: still a proposal
  await page.reload();
  await expect(page.getByTestId("episode-edit-proposal")).toBeVisible();
});

test("Create edit persists the reviewed proposal at revision 0; a reload keeps it exactly", async ({
  page,
}) => {
  await page.goto(`${EP}/edit`);
  const proposedTake = await pinnedTakeLabel(page);
  expect(proposedTake).toBeTruthy();
  await page.getByTestId("create-episode-edit").click();
  await expect(page.getByTestId("episode-edit-persisted")).toBeVisible();
  await expect(page.getByTestId("edit-revision")).toHaveText("Revision 0");
  await expect(page.locator('[data-testid="edit-item"]')).toHaveCount(14);
  await expect(item(page, "1A").getByTestId("item-kind")).toHaveText("Placeholder: Storyboard still");
  await expect(item(page, "1A").getByTestId("item-badges")).toContainText("Pinned");
  expect(await pinnedTakeLabel(page)).toBe(proposedTake);

  for (let i = 0; i < 2; i++) {
    await page.reload();
    await expect(page.getByTestId("edit-revision")).toHaveText("Revision 0");
    await expect(item(page, "2A").getByTestId("item-kind")).toHaveText("No picture yet");
    expect(await pinnedTakeLabel(page)).toBe(proposedTake);
  }
});

test("an upstream take change is reported, never applied: the pinned take stays, revision 0", async ({
  page,
}) => {
  await page.goto(`${EP}/edit`);
  const pinned = await pinnedTakeLabel(page);
  const other = pinned === "3" ? 2 : 3;

  await page.goto(`${EP}/perform`);
  const card = page.locator("article", { hasText: LINE_3A }).first();
  await card
    .locator("div", { hasText: new RegExp(`^#${other}`) })
    .getByRole("button", { name: "Select" })
    .first()
    .click();
  await expect(card.getByText(new RegExp(`canonical: take ${other}`))).toBeVisible();

  await page.goto(`${EP}/edit`);
  await expect(page.getByTestId("edit-revision")).toHaveText("Revision 0");
  expect(await pinnedTakeLabel(page)).toBe(pinned);
  await expect(item(page, "3A").getByTestId("item-audio")).toContainText("Take superseded");
});

test("lineage, timing and Scene runs are inspectable; the Animatic stays the planning projection", async ({
  page,
}) => {
  await page.goto(`${EP}/edit`);
  const row = item(page, "3A");
  await expect(row.getByTestId("item-timing")).toContainText("Duration");
  await row.getByTestId("item-lineage").locator("summary").click();
  const lineage = row.getByTestId("item-lineage");
  await expect(lineage).toContainText("Shot 3A");
  await expect(lineage).toContainText(/Storyboard frame v\d+/);
  await expect(lineage).toContainText(`Line · `);
  await expect(lineage).toContainText(/Take \d+ · /);
  await expect(page.getByTestId("edit-runs").locator("li")).not.toHaveCount(0);

  // the Episode's own Animatic (the project sidebar also has an "Animatic" link)
  await page.locator(`main a[href="${EP}/animatic"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`${EP}/animatic$`));
  await expect(page.getByRole("link", { name: "Episode Edit" })).toBeVisible();
});

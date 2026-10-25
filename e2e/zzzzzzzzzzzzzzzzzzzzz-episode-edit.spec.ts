import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Phase 2I.1C/2I.1D Episode Edit, memory mode, through the UI: the page, explicit creation, explicit editing.
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
 *
 * Phase 2I.1D (explicit editing, each change exactly one revision): two free mock clips for 3A (one rejected) are both
 * offered → pin #1 (survives a reload) → a trim that would cut the placed take is refused → pin another take → Silence →
 * the trim applies and later items move → reorder (order differs from the Sequence; Scene 2 gets two runs) → remove 6A
 * (confirmed) and add it back at position 2 → approve #2 elsewhere: "Replacement available", nothing followed → Use
 * replacement → a second tab's change makes this tab's submit a conflict that is shown and overwrites nothing.
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

// ───────────────────────── Phase 2I.1D: explicit editing ─────────────────────────

const revisionOf = async (page: Page) =>
  // textContent, not innerText: the badge is uppercased by CSS
  Number(((await page.getByTestId("edit-revision").textContent()) ?? "").replace("Revision ", ""));
/** Waits for the saved edit to reach `n` (every successful change bumps it exactly once). */
const expectRevision = (page: Page, n: number) =>
  expect(page.getByTestId("edit-revision")).toHaveText(`Revision ${n}`, { timeout: 15_000 });
async function openEditor(page: Page, code: string) {
  const editor = item(page, code).getByTestId("item-editor");
  // the disclosure stays open across saves (it is not remounted): open it only when closed
  if (!(await editor.evaluate((d) => (d as HTMLDetailsElement).open)))
    await editor.locator("summary").click();
  return editor;
}
const startOf = async (page: Page, code: string) =>
  (await item(page, code).getByTestId("item-timing").innerText()).match(/Starts ([\d:.]+)/)?.[1];
const order = (page: Page) =>
  page
    .locator('[data-testid="edit-item"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-shot-code")));

async function openGenerate3A(page: Page) {
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: "3A", exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  await page.goto(`${page.url().split("?")[0]}?section=generate`);
  await expect(page.getByTestId("generate-workspace")).toBeVisible();
}

test("two free mock clips exist for 3A (one rejected, one awaiting review): both are pinnable sources", async ({
  page,
}) => {
  test.setTimeout(150_000);
  // the 2I.1C test above selected another take for 3A's line, which changed the Shot's derived duration (4.5 s →
  // 4.1 s, not a duration the mock model accepts): restore the seed's canonical take 1 so 3A can be generated
  await page.goto(`${EP}/perform`);
  const card = page.locator("article", { hasText: LINE_3A }).first();
  const take1 = card.locator("div", { hasText: /^#1/ }).getByRole("button", { name: "Select" }).first();
  if (await take1.count()) await take1.click();
  await expect(card.getByText(/canonical: take 1/)).toBeVisible();

  await openGenerate3A(page);
  const state = page.getByTestId("shot-generation-state");
  await page.getByTestId("generate-button").click();
  await expect(state).toHaveText("READY FOR REVIEW", { timeout: 60_000 });
  const card1 = page.locator('[data-testid="attempt-card"][data-attempt="1"]');
  await card1.getByTestId("reject-toggle").click();
  await card1.getByLabel("Bad motion").check();
  await card1.getByPlaceholder("What is wrong?").fill("pace");
  await card1.getByTestId("reject-submit").click();
  await expect(card1.getByTestId("review-status")).toContainText("rejected", { timeout: 15_000 });
  await page.getByTestId("generate-button").click();
  await expect(page.locator('[data-testid="attempt-card"][data-attempt="2"]')).toBeVisible({
    timeout: 15_000,
  });
  await expect(state).toHaveText("READY FOR REVIEW", { timeout: 60_000 });

  await page.goto(`${EP}/edit`);
  const editor = await openEditor(page, "3A");
  await expect(editor.getByTestId("source-option").filter({ hasText: "Generation #1" })).toContainText(
    "review: rejected",
  );
  await expect(editor.getByTestId("source-option").filter({ hasText: "Generation #2" })).toBeVisible();
});

test("pin a chosen clip: one revision, survives a reload", async ({ page }) => {
  await page.goto(`${EP}/edit`);
  const rev = await revisionOf(page);
  const editor = await openEditor(page, "3A");
  await editor.getByTestId("source-option").filter({ hasText: "Generation #1" }).locator("input").check();
  await editor.getByTestId("pin-source").click();
  await expectRevision(page, rev + 1);
  await expect(item(page, "3A").getByTestId("item-kind")).toHaveText("Generated clip");
  await page.reload();
  await expectRevision(page, rev + 1);
  await expect(item(page, "3A")).toContainText("Generation #1");
  await expect(item(page, "3A").getByTestId("item-kind")).toHaveText("Generated clip");
});

test("a trim that would cut the placed take is refused; pin another take; Silence; then the trim applies and later items move", async ({
  page,
}) => {
  await page.goto(`${EP}/edit`);
  const rev = await revisionOf(page);
  let editor = await openEditor(page, "3A");
  await editor.getByTestId("trim-in").fill("0");
  await editor.getByTestId("trim-out").fill("0.1");
  await editor.getByTestId("apply-trim").click();
  await expect(editor.getByTestId("trim-form")).toContainText("must stay inside its item");
  await expect(page.getByTestId("edit-revision")).toHaveText(`Revision ${rev}`);

  // pin another take of the line (explicit; the project's selected take is not touched)
  const pinnedBefore = await pinnedTakeLabel(page);
  const line = editor.getByTestId("line-editor").first();
  await line.getByTestId("take-option").filter({ hasNotText: "Pinned" }).first().locator("input").check();
  await line.getByTestId("pin-take").click();
  await expectRevision(page, rev + 1);
  expect(await pinnedTakeLabel(page)).not.toBe(pinnedBefore);

  editor = await openEditor(page, "3A");
  await editor.getByTestId("silence-item").click();
  await expectRevision(page, rev + 2);
  await expect(item(page, "3A").getByTestId("item-silence")).toBeVisible();

  const nextStart = await startOf(page, "4A");
  editor = await openEditor(page, "3A");
  await editor.getByTestId("trim-in").fill("0.5");
  await editor.getByTestId("trim-out").fill("2");
  await editor.getByTestId("apply-trim").click();
  await expectRevision(page, rev + 3);
  await expect(item(page, "3A").getByTestId("item-timing")).toContainText("Duration 1.5s");
  expect(await startOf(page, "4A")).not.toBe(nextStart);
});

test("reorder: the edit order diverges from the Sequence, and a revisited Scene shows two runs", async ({
  page,
}) => {
  await page.goto(`${EP}/edit`);
  const rev = await revisionOf(page);
  await item(page, "2E").getByTestId("move-down").click();
  await expectRevision(page, rev + 1);
  await expect(page.getByTestId("edit-badges")).toContainText("Order differs from Sequence");
  await expect(page.getByTestId("edit-runs")).toContainText("Scene 2 · run 2 of 2");
  const codes = await order(page);
  expect(codes.indexOf("3A")).toBe(codes.indexOf("2E") - 1);
});

test("remove an item (confirmed), then add that Shot back at a chosen position", async ({ page }) => {
  await page.goto(`${EP}/edit`);
  const rev = await revisionOf(page);
  page.once("dialog", (d) => void d.accept());
  await item(page, "6A").getByTestId("remove-item").click();
  await expectRevision(page, rev + 1);
  await expect(page.locator('[data-testid="edit-item"]')).toHaveCount(13);
  const addable = page.locator('[data-testid="addable-shot"][data-shot-code="6A"]');
  await expect(addable).toContainText("→");
  await addable.getByTestId("add-position").selectOption("1");
  await addable.getByTestId("add-shot").click();
  await expectRevision(page, rev + 2);
  await expect(page.locator('[data-testid="edit-item"]')).toHaveCount(14);
  await expect(page.locator('[data-testid="edit-item"]').nth(1)).toHaveAttribute("data-shot-code", "6A");
});

test("approving another clip shows a replacement; only the explicit Use replacement repins it", async ({
  page,
}) => {
  await openGenerate3A(page);
  await page.locator('[data-testid="attempt-card"][data-attempt="2"]').getByTestId("approve-button").click();
  await expect(page.getByTestId("shot-generation-state")).toHaveText("APPROVED", { timeout: 15_000 });

  await page.goto(`${EP}/edit`);
  const rev = await revisionOf(page);
  await expect(item(page, "3A").getByTestId("item-badges")).toContainText("Replacement available");
  await expect(item(page, "3A")).toContainText("Generation #1"); // still pinned: nothing followed the approval
  const editor = await openEditor(page, "3A");
  await editor.getByTestId("use-replacement").click();
  await expectRevision(page, rev + 1);
  await expect(item(page, "3A")).toContainText("Generation #2");
  await expect(item(page, "3A").getByTestId("item-badges")).not.toContainText("Replacement available");
  await expect(item(page, "3A").getByTestId("item-badges")).toContainText("Approved");
});

test("a change from a stale page is refused with the conflict message and never overwrites the newer edit", async ({
  page,
  context,
}) => {
  await page.goto(`${EP}/edit`);
  const rev = await revisionOf(page);
  // another tab changes the edit first
  const other = await context.newPage();
  await other.goto(`${EP}/edit`);
  await item(other, "4A").getByTestId("move-down").click();
  await expectRevision(other, rev + 1);
  const newerOrder = await order(other);

  // the first tab still shows the old revision and submits against it
  const editor = await openEditor(page, "1A");
  await editor.getByTestId("hold-duration").fill("2");
  await editor.getByTestId("apply-hold").click();
  await expect(
    page.getByText(
      "This edit changed before your update was saved. Review the latest version and try again.",
    ),
  ).toBeVisible();

  await page.reload();
  await expectRevision(page, rev + 1);
  expect(await order(page)).toEqual(newerOrder);
  await expect(item(page, "1A").getByTestId("item-timing")).not.toContainText("Duration 2.0s");
  await other.close();
});

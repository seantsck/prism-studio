import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * Phase 3A.4C predecessor-bound cut intent, memory mode, through the UI. ISOLATED STORE (its own Playwright project and
 * memory server, playwright.config.ts port 3108): it creates the Episode's edit, a free mock clip and intents.
 *
 *   persisted edit → one free mock clip pinned on 3A → Supervisor: declare the cut 2E → 3A deliberate (one revision,
 *   badge + details, survives a reload, the state stays "No sequence QA yet") → trim 3A: the intent stays → reorder so
 *   another item precedes 3A: the intent is gone → no transition run, no provider call, no derived media.
 * No provider network: the free MockProvider only (REAL GEMINI / OPENAI / GENERATION CALLS: 0).
 */

const EP = "/projects/ojousama/episodes/ep-1";
test.describe.configure({ mode: "serial" });

const item = (page: Page, code: string) =>
  page.locator(`[data-testid="edit-item"][data-shot-code="${code}"]`);
const row = (page: Page, title: string) =>
  page.locator('[data-testid="cut-row"]', {
    has: page.getByTestId("cut-title").getByText(title, { exact: true }),
  });
const revisionOf = async (page: Page) =>
  Number(((await page.getByTestId("edit-revision").textContent()) ?? "").replace("Revision ", ""));
const expectRevision = (page: Page, n: number) =>
  expect(page.getByTestId("edit-revision")).toHaveText(`Revision ${n}`, { timeout: 15_000 });
const supervisorRevision = (page: Page, n: number) =>
  expect(page.getByTestId("continuity-revision")).toHaveText(`Edit revision ${n}`, { timeout: 15_000 });
async function openEditor(page: Page, code: string) {
  const editor = item(page, code).getByTestId("item-editor");
  if (!(await editor.evaluate((d) => (d as HTMLDetailsElement).open)))
    await editor.locator("summary").click();
  return editor;
}

test("setup: a persisted edit with one free mock clip pinned on 3A", async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto(`${EP}/edit`);
  await page.getByTestId("create-episode-edit").click();
  await expect(page.getByTestId("episode-edit-persisted")).toBeVisible();
  await expectRevision(page, 0);

  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: "3A", exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  await page.goto(`${page.url().split("?")[0]}?section=generate`);
  await expect(page.getByTestId("generate-workspace")).toBeVisible();
  await page.getByTestId("generate-button").click();
  await expect(page.getByTestId("shot-generation-state")).toHaveText("READY FOR REVIEW", { timeout: 60_000 });

  await page.goto(`${EP}/edit`);
  const editor = await openEditor(page, "3A");
  await editor.getByTestId("source-option").filter({ hasText: "Generation #1" }).locator("input").check();
  await editor.getByTestId("pin-source").click();
  await expectRevision(page, 1);
  await expect(item(page, "3A").getByTestId("item-kind")).toHaveText("Generated clip");
});

test("declare the cut 2E → 3A deliberate: one revision, shown, kept on reload; the state does not change", async ({
  page,
}) => {
  await page.goto(`${EP}/continuity`);
  await supervisorRevision(page, 1);
  const cut = row(page, "2E → 3A");
  await expect(cut.getByTestId("cut-intent-none")).toBeVisible();
  const stateBefore = await cut.getByTestId("cut-state").textContent();
  await cut.getByTestId("cut-intent-editor").locator("summary").click();
  await cut.getByTestId("cut-intent-kind-time_jump").check();
  await cut.getByTestId("cut-intent-note-input").fill("Later that night: the time jump is deliberate.");
  await expect(async () => {
    await cut.getByTestId("cut-intent-submit").click({ timeout: 2000 });
    await supervisorRevision(page, 2);
  }).toPass({ timeout: 30_000 });
  await expect(cut).toHaveAttribute("data-has-intent", "true");
  await expect(cut.getByTestId("cut-intent-badge")).toHaveText("This cut is deliberate");
  await expect(cut.getByTestId("cut-intent-kinds")).toHaveText("Time jump");
  await expect(cut.getByTestId("cut-intent-scope")).toHaveText("Every continuity category");
  await expect(cut.getByTestId("cut-intent-note")).toContainText("the time jump is deliberate");
  // no transition run exists: the intent never becomes "Intentional discontinuity accepted"
  await expect(cut.getByTestId("cut-state")).toHaveText(stateBefore ?? "");
  await page.reload();
  await supervisorRevision(page, 2);
  await expect(row(page, "2E → 3A").getByTestId("cut-intent-note")).toContainText("deliberate");
  await expect(page.locator('[data-testid="cut-row"][data-has-intent="true"]')).toHaveCount(1);
});

test("trimming a side keeps the intent (its predecessor is unchanged)", async ({ page }) => {
  await page.goto(`${EP}/edit`);
  const rev = await revisionOf(page);
  const editor = await openEditor(page, "3A");
  await editor.getByTestId("trim-in").fill("0");
  await editor.getByTestId("trim-out").fill("4.9");
  await editor.getByTestId("apply-trim").click();
  await expectRevision(page, rev + 1);
  await page.goto(`${EP}/continuity`);
  await expect(row(page, "2E → 3A")).toHaveAttribute("data-has-intent", "true");
  await expect(row(page, "2E → 3A").getByTestId("cut-intent-badge")).toBeVisible();
});

test("a reorder that changes 3A's predecessor clears the intent; nothing else is created", async ({
  page,
}) => {
  await page.goto(`${EP}/edit`);
  const rev = await revisionOf(page);
  await item(page, "2E").getByTestId("move-down").click(); // 2D, 3A, 2E: 3A's predecessor is now 2D
  await expectRevision(page, rev + 1);

  const writes: string[] = [];
  const listener = (r: Request) => {
    if (r.method() !== "GET" && r.method() !== "HEAD") writes.push(`${r.method()} ${r.url()}`);
  };
  page.on("request", listener);
  await page.goto(`${EP}/continuity`);
  await supervisorRevision(page, rev + 1);
  await expect(row(page, "2D → 3A")).toHaveAttribute("data-has-intent", "false");
  await expect(page.locator('[data-testid="cut-row"][data-has-intent="true"]')).toHaveCount(0);
  // no transition run (every cut is in the no-run state), nothing written by reading
  await expect(page.locator('[data-testid="cut-row"]:not([data-state="no_sequence_qa"])')).toHaveCount(0);
  page.off("request", listener);
  expect(writes).toEqual([]);
  // the edit itself still has exactly the one clip generated above: no derived edge media, no analysis
  await page.goto(`${EP}/edit`);
  await expect(page.getByTestId("item-kind").filter({ hasText: "Generated clip" })).toHaveCount(1);
});

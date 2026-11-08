import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 5B-I1 / I1b on its own memory server (memory-5b-isolated): Character, Location and Shot images through the
 * existing generation pipeline with the FREE mock image models and the in-process worker. No provider, no paid call.
 *
 *   A  Character: Generate Image → finished → Use as Character Reference
 *   B  Location:  Generate Image → finished → Use as Location Reference
 *   C  Shot 3A:   Generate Image (the existing Production Frame candidate workflow) → Use as Storyboard Frame
 *   D  Character: Edit Image → new image with lineage → Use as Character Reference (5B-I2)
 *   E  Location:  generated image → Use as Location View (5B-I2)
 *   F  Shot 3A:   Edit Image → new Production Frame candidate with lineage → Use as Production Frame (5B-I2)
 */
test.describe.configure({ mode: "serial" });

const P = "/projects/ojousama";
const EP = `${P}/episodes/ep-1`;

async function waitForFinished(page: Page, scope: ReturnType<Page["getByTestId"]>) {
  await expect
    .poll(
      async () => {
        await page.reload();
        return scope.getByTestId("subject-image").first().getAttribute("data-status");
      },
      { timeout: 90_000, intervals: [1500] },
    )
    .toBe("succeeded");
}

test("A — Character: Generate Image, then Use as Character Reference", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`${P}/characters`);
  await page.getByRole("link", { name: "Yumeko" }).first().click();
  const panel = page.getByTestId("subject-images");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("subject-image-model")).toHaveValue(/^mock\//); // a free model is suggested
  await page.getByTestId("subject-image-intent").selectOption("portrait");
  await page.getByTestId("subject-image-generate").click();
  await expect(page.getByText("Image queued")).toBeVisible({ timeout: 30_000 });
  await waitForFinished(page, panel);
  await expect(panel.getByTestId("subject-image-preview").first()).toBeVisible();
  const first = panel.getByTestId("subject-image").first();
  await first.locator('select[name="slot"]').selectOption("additional");
  await first.getByTestId("use-as-character-reference").click();
  await expect(page.getByText("Character reference set")).toBeVisible({ timeout: 30_000 });
});

test("B — Location: Generate Image, then Use as Location Reference", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`${P}/locations`);
  const card = page.locator('[data-testid^="location-images-"]').first();
  await card.evaluate((el) => {
    const details = el.closest("details");
    if (details) details.open = true;
  });
  const panel = card.getByTestId("subject-images");
  await expect(panel).toBeVisible();
  await panel.getByTestId("subject-image-intent").selectOption("establishing_view");
  await panel.getByTestId("subject-image-generate").click();
  await expect(page.getByText("Image queued")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => {
        await page.reload();
        await card.evaluate((el) => {
          const details = el.closest("details");
          if (details) details.open = true;
        });
        return panel.getByTestId("subject-image").first().getAttribute("data-status");
      },
      { timeout: 90_000, intervals: [1500] },
    )
    .toBe("succeeded");
  // the seeded Locations are locked: using an image is refused until the creator explicitly unlocks
  await panel.getByTestId("subject-image").first().getByTestId("use-as-location-reference").click();
  await expect(
    page.getByText("That location is locked. Unlock it before changing its references."),
  ).toBeVisible({
    timeout: 30_000,
  });
  const details = card.locator("xpath=ancestor::details[1]");
  await details.getByRole("button", { name: "Unlock location" }).click();
  await expect(details.getByRole("button", { name: "Lock location" })).toBeVisible({ timeout: 30_000 });
  await card.evaluate((el) => {
    const d = el.closest("details");
    if (d) d.open = true;
  });
  await panel.getByTestId("subject-image").first().getByTestId("use-as-location-reference").click();
  await expect(page.getByText("Added to the Location's references")).toBeVisible({ timeout: 30_000 });
});

test("C — Shot 3A: Generate Image through the Production Frame workflow, then Use as Storyboard Frame", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: "3A", exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  const shotUrl = page.url().split("?")[0]!;
  await page.goto(`${shotUrl}?section=production_frame`);
  const actions = page.getByTestId("shot-image-actions");
  await expect(actions).toBeVisible();
  await actions.getByTestId("shot-generate-image").click();
  // the existing workflow opens the candidate set page
  await page.waitForURL(/\/candidates\/[0-9a-f-]{36}/, { timeout: 60_000 });
  await expect
    .poll(
      async () => {
        await page.goto(`${shotUrl}?section=production_frame`);
        return page.getByTestId("shot-generated-still").count();
      },
      { timeout: 120_000, intervals: [2000] },
    )
    .toBeGreaterThan(0);
  await page.getByTestId("shot-generated-still").first().getByTestId("shot-use-as-storyboard").click();
  await expect(page.getByText("Added as a Storyboard frame")).toBeVisible({ timeout: 30_000 });
});

// ── Phase 5B-I2: Edit Image (free mock models), lineage and promotion ──

test("D — Character: Edit Image makes a NEW image with visible lineage, then Use as Character Reference", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto(`${P}/characters`);
  await page.getByRole("link", { name: "Yumeko" }).first().click();
  const panel = page.getByTestId("subject-images");
  const before = await panel.getByTestId("subject-image").count();
  const edit = panel.getByTestId("subject-image-edit");
  await edit.locator("summary").click();
  await edit.getByTestId("subject-image-edit-instruction").fill("change the coat to dark green");
  await edit.getByTestId("subject-image-edit-submit").click();
  await expect(page.getByText("Edit queued")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => {
        await page.reload();
        const first = panel.getByTestId("subject-image").first();
        return (await panel.getByTestId("subject-image").count()) > before
          ? first.getAttribute("data-status")
          : "waiting";
      },
      { timeout: 90_000, intervals: [1500] },
    )
    .toBe("succeeded");
  const first = panel.getByTestId("subject-image").first();
  await expect(first.getByTestId("subject-image-lineage")).toContainText("→ edit attempt #");
  await first.locator('select[name="slot"]').selectOption("additional");
  await first.getByTestId("use-as-character-reference").click();
  await expect(page.getByText("Character reference set")).toBeVisible({ timeout: 30_000 });
});

test("E — Location: a generated image becomes a Location View", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${P}/locations`);
  const card = page.locator('[data-testid^="location-images-"]').first();
  await card.evaluate((el) => {
    const details = el.closest("details");
    if (details) details.open = true;
  });
  const first = card.getByTestId("subject-images").getByTestId("subject-image").first();
  await first.locator('input[name="lv_name"]').fill("Generated establishing view");
  await first.getByTestId("use-as-location-view").click();
  await expect(page.getByText("Location View saved")).toBeVisible({ timeout: 30_000 });
});

test("F — Shot 3A: Edit Image is a new Production Frame candidate with lineage, then Use as Production Frame", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: "3A", exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  const shotUrl = page.url().split("?")[0]!;
  await page.goto(`${shotUrl}?section=production_frame`);
  const edit = page.getByTestId("shot-image-edit");
  await edit.locator("summary").click();
  await edit.getByTestId("shot-image-edit-instruction").fill("add falling snow");
  await edit.getByTestId("shot-image-edit-submit").click();
  await page.waitForURL(/\/candidates\/[0-9a-f-]{36}/, { timeout: 60_000 });
  await expect
    .poll(
      async () => {
        await page.goto(`${shotUrl}?section=production_frame`);
        return page.getByTestId("shot-image-lineage").count();
      },
      { timeout: 120_000, intervals: [2000] },
    )
    .toBeGreaterThan(0);
  const edited = page
    .getByTestId("shot-generated-still")
    .filter({ has: page.getByTestId("shot-image-lineage") })
    .first();
  await edited.getByTestId("shot-use-as-production-frame").click();
  await expect(page.getByText("Production Frame set")).toBeVisible({ timeout: 30_000 });
});

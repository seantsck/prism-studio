import { expect, test } from "@playwright/test";

test("project list shows the demo project", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("お嬢様、僕と結婚してください。").first()).toBeVisible();
});

test("shot prep shows the deterministic preflight verdict", async ({ page }) => {
  await page.goto("/projects/ojousama/episodes/ep-1/shots");
  await page.getByRole("link", { name: "2A", exact: true }).click();
  const rail = page.locator("aside").last();
  await expect(rail.getByText("NOT READY TO GENERATE")).toBeVisible();
  await expect(rail.getByText(/Storyboard frame missing/)).toBeVisible();
});

test("selecting a take moves the canonical take and restores it", async ({ page }) => {
  await page.goto("/projects/ojousama/episodes/ep-1/perform");
  const card = page.locator("article", { hasText: "もう帰りたい" }).first();
  const selectTake = async (n: number) => {
    await card
      .locator("div", { hasText: new RegExp(`^#${n}`) })
      .getByRole("button", { name: "Select" })
      .first()
      .click();
    await expect(card.getByText(new RegExp(`canonical: take ${n}`))).toBeVisible();
  };
  await selectTake(3);
  await selectTake(1); // restore seed state: server memory is shared across runs
});

test("animatic renders runtime and timeline", async ({ page }) => {
  await page.goto("/projects/ojousama/episodes/ep-1/animatic");
  await expect(page.getByText(/Runtime/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
});

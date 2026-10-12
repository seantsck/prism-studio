import { expect, test } from "@playwright/test";

// Memory/demo mode has no accounts: the auth-flow pages must still render safely and never expose a form.
test("auth-flow pages render a demo notice in memory mode", async ({ page }) => {
  for (const path of ["/forgot-password", "/update-password"]) {
    await page.goto(path);
    await expect(page.getByText("disabled in demo mode")).toBeVisible();
    await expect(page.locator("input[type=password]")).toHaveCount(0);
  }
});

test("auth error page shows friendly copy and never echoes the query", async ({ page }) => {
  await page.goto("/auth/error?reason=used&code=fake-code-for-tests");
  await expect(page.getByRole("heading", { name: "This link was already used" })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("fake-code-for-tests");
  await expect(page.getByRole("link", { name: "Back to sign in" })).toBeVisible();
});

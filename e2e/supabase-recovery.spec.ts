import { expect, test } from "@playwright/test";

/**
 * Password-recovery pages against the real Supabase-mode app (run with `npm run test:e2e:supabase`).
 * No credentials needed and NO real email is ever sent: the browser's request to Supabase is intercepted.
 * The actual email click is a manual step. All token-like values below are fake.
 */
const FAKE = "fake-value-for-tests";

test("login links to Forgot password and shows the updated notice", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to sign in" })).toBeVisible();

  await page.goto("/login?passwordUpdated=1");
  await expect(page.getByRole("status").filter({ hasText: "Password updated" })).toHaveText(
    "Password updated. Sign in with your new password.",
  );
});

test("malformed email is rejected locally without a network call", async ({ page }) => {
  let recoverCalls = 0;
  await page.route("**/auth/v1/recover**", (route) => {
    recoverCalls++;
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.locator("form [role=alert]")).toHaveText("Enter a valid email address.");
  expect(recoverCalls).toBe(0);
});

test("a (mocked) request shows the generic success text and redirects back to Prism Studio", async ({
  page,
}) => {
  let redirectTo = "";
  await page.route("**/auth/v1/recover**", (route) => {
    redirectTo = new URL(route.request().url()).searchParams.get("redirect_to") ?? "";
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill("someone@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText(
    "If an account exists for that email, we've sent a password reset link.",
  );
  expect(redirectTo).toBe("http://localhost:3101/auth/callback?next=/update-password");
  expect(redirectTo).not.toContain(":3000");
});

test("rate-limit errors are friendly and never show upstream detail", async ({ page }) => {
  await page.route("**/auth/v1/recover**", (route) =>
    route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ code: "over_email_send_rate_limit", message: "raw upstream detail" }),
    }),
  );
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill("someone@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();
  const alert = page.locator("form [role=alert]");
  await expect(alert).toContainText("Too many reset requests");
  await expect(alert).not.toContainText(/raw upstream|over_email/);
});

test("update-password without a recovery session offers a new link and no form", async ({ page }) => {
  await page.goto("/update-password");
  await expect(page.getByRole("link", { name: "Request another reset link" })).toBeVisible();
  await expect(page.locator("input[type=password]")).toHaveCount(0);
});

test("callback without a code, or with an unknown code, ends on the friendly error page", async ({
  page,
}) => {
  await page.goto("/auth/callback");
  await expect(page).toHaveURL(/\/auth\/error\?reason=failed$/);
  await expect(page.getByRole("link", { name: "Request another password reset" })).toBeVisible();

  await page.goto(`/auth/callback?code=${FAKE}&next=${encodeURIComponent("https://evil.example")}`);
  await expect(page).toHaveURL(/\/auth\/error\?reason=/);
  await expect(page.locator("main")).not.toContainText(FAKE);
  expect(page.url()).not.toContain(FAKE);
  await expect(page.getByRole("link", { name: "Back to sign in" })).toBeVisible();
});

test("error page renders only whitelisted wording", async ({ page }) => {
  await page.goto("/auth/error?reason=expired");
  await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
  await page.goto(`/auth/error?reason=${encodeURIComponent(`<b>${FAKE}</b>`)}`);
  await expect(page.getByRole("heading", { name: "We couldn't verify that link" })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(FAKE);
});

test("an old fragment-style link is scrubbed from the URL and sent to the error page", async ({ page }) => {
  await page.goto(`/login#access_token=${FAKE}&refresh_token=${FAKE}&type=recovery`);
  await expect(page).toHaveURL(/\/auth\/error\?reason=legacy$/);
  expect(page.url()).not.toContain("access_token");
  expect(page.url()).not.toContain(FAKE);
  expect(await page.evaluate(() => window.location.hash)).toBe("");
});

import { expect, test, type Page } from "@playwright/test";
import { getPrismStudioTestCredentials } from "./test-credentials";

/**
 * Real Supabase Auth + RLS-bound persistence, end to end (run with `npm run test:e2e:supabase`).
 * The signed-in half needs the dedicated test account: PRISM_STUDIO_TEST_EMAIL and PRISM_STUDIO_TEST_PASSWORD
 * in .env.local (no fallback to the DEV account). The suite fails loudly when either is missing.
 */
const { email: EMAIL, password: PASSWORD } = getPrismStudioTestCredentials();
const EP = "/projects/ojousama/episodes/ep-1";

test.describe("protection (no credentials needed)", () => {
  test("protected pages redirect to /login and remember the destination", async ({ page }) => {
    await page.goto("/projects/ojousama/perform");
    await expect(page).toHaveURL(/\/login\?next=%2Fprojects%2Fojousama%2Fperform/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("the home page and the API require a session", async ({ page, request }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    const res = await request.get("/api/assets/00000000-0000-4000-8000-000000000000");
    expect(res.status()).toBe(401);
    const pkg = await request.get(
      "/api/projects/ojousama/shots/00000000-0000-4000-8000-000000000000/package",
    );
    expect(pkg.status()).toBe(401);
  });

  test("bad credentials give a friendly message with no technical detail", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("nobody@example.invalid");
    await page.getByLabel("Password").fill("definitely-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    // (Next also renders an empty route-announcer alert; target the form message.)
    const alert = page.locator("form [role=alert]");
    await expect(alert).toContainText(/incorrect|failed|Too many|not been confirmed/i);
    await expect(alert).not.toContainText(/supabase|jwt|auth\.|error code|stack|sql/i);
    await expect(page).toHaveURL(/\/login/);
  });
});

async function login(page: Page, next = "/") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("signed-in production flow", () => {
  test.describe.configure({ mode: "serial" });

  test("login → project → perform → take selection → shot prep timing → storyboard → animatic → upload → reload → logout", async ({
    page,
  }) => {
    test.setTimeout(240_000);

    // 1–2 login, open the demo project
    await login(page);
    await expect(page.getByText("お嬢様、僕と結婚してください。").first()).toBeVisible();
    await page.getByText("お嬢様、僕と結婚してください。").first().click();
    await expect(page).toHaveURL(/\/projects\/ojousama/);

    // 3–4 Perform: select a different take, then restore
    await page.goto(`${EP}/perform`);
    const card = page.locator("article", { hasText: "もう帰りたい" }).first();
    const select = async (n: number) => {
      await card
        .locator("div", { hasText: new RegExp(`^#${n}`) })
        .getByRole("button", { name: "Select" })
        .first()
        .click();
      await expect(card.getByText(new RegExp(`canonical: take ${n}`))).toBeVisible();
    };
    await select(3);

    // 5–7 Shot prep reflects the selected performance and the derived timing
    await page.goto(`${EP}/shots`);
    await page.getByRole("link", { name: "3A", exact: true }).click();
    const timing = page.getByTestId("timing-list").last();
    await expect(timing).toContainText("selected Take 3");
    await expect(timing).not.toContainText("Total 4.50s");

    await select_back(page, select);

    // 8 Storyboard + 9–10 Animatic playback
    await page.goto(`${EP}/storyboard`);
    await expect(page.getByText(/3A/).first()).toBeVisible();
    await page.goto(`${EP}/animatic`);
    const time = page.getByTestId("animatic-time");
    await page.getByRole("button", { name: "Play" }).click();
    await expect
      .poll(async () => (await time.textContent()) ?? "", { timeout: 10_000 })
      .not.toContain("0:00.0 /");
    await page.getByRole("button", { name: "Pause" }).click();

    // 11–14 upload an asset, see it in the library, reload, still there
    const name = `e2e-supabase-${Date.now()}.png`;
    await page.goto("/projects/ojousama/assets");
    await page.locator("input[type=file]").setInputFiles({
      name,
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await page.getByRole("button", { name: "Upload asset" }).click();
    await expect(page.getByText("Saved").first()).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await page.getByLabel("Search assets").fill(name);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.locator("tbody tr", { hasText: name })).toBeVisible();

    // the stored object is private: served only through the authorised route (redirect to a signed URL)
    await page.locator("tbody tr", { hasText: name }).getByRole("link").first().click();
    const img = page.locator("aside img").first();
    await expect(img).toBeVisible();

    // cleanup: unused asset can be deleted
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Delete asset" }).click();
    await expect(page.locator("tbody tr", { hasText: name })).toHaveCount(0);

    // 15–16 logout, protected routes redirect again
    await page.goto("/");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto(`${EP}/perform`);
    await expect(page).toHaveURL(/\/login/);
  });
});

async function select_back(page: Page, select: (n: number) => Promise<void>) {
  await page.goto(`${EP}/perform`);
  await select(1);
}

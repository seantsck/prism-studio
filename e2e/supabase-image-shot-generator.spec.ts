import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { getPrismStudioDevCredentials } from "./dev-credentials";

/**
 * Phase 2G.2 Image Shot Generator on the REAL stack: Supabase Auth + RLS, the hosted Prism Studio database, the real
 * generation worker and PRIVATE Storage. MockProvider only: REAL IMAGE-MODEL CALLS 0, PAID CALLS 0. Three free still
 * images are generated for a Shot with no 3D set, compared, reviewed, and one becomes the Production Frame (after the
 * production conform). Everything created is removed afterwards.
 */
const { email: EMAIL, password: PASSWORD } = getPrismStudioDevCredentials();
const EP = "/projects/ojousama/episodes/ep-1";

test.describe.configure({ mode: "serial" });

const tsx = (script: string, args: string[]) =>
  execFileSync("npx", ["tsx", "--env-file=.env.local", script, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRISM_STUDIO_PERSISTENCE: "supabase",
      PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
      NODE_ENV: "test",
      ...(process.env.PRISM_STUDIO_E2E_REAL_WORKER === "1"
        ? {}
        : { PRISM_STUDIO_WORKER_DEV_STORAGE: "1", PRISM_STUDIO_WORKER_DEV_ASSUME_ROLE: "1" }),
    },
    encoding: "utf8",
    timeout: 240_000,
    shell: process.platform === "win32",
  });

const cleanup = () => {
  try {
    tsx("scripts/generation-cleanup.mts", ["--yes"]);
  } catch {
    /* best effort; idempotent */
  }
};
test.beforeAll(cleanup);
test.afterAll(cleanup);

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("お嬢様、僕と結婚してください。").first()).toBeVisible({ timeout: 30_000 });
}

const section = (page: Page) => page.getByTestId("production-frame-section");
const card = (page: Page, model: string) =>
  page.locator(`[data-testid="candidate-card"][data-model="${model}"]`);
const MODELS = ["mock-image-1", "mock-image-lite", "mock-image-wide"];

let shotUrl: string;
let setUrl: string;

test("hosted: three free image candidates → worker → compare → review → conform → Use as Production Frame", async ({
  page,
}) => {
  test.setTimeout(480_000);
  await signIn(page);
  await page.goto(`${EP}/shots`);
  const href = await page.getByRole("link", { name: "4A", exact: true }).first().getAttribute("href");
  await page.goto(href!);
  shotUrl = page.url().split("?")[0]!;
  const brief = async () => {
    await page.goto(`${shotUrl}?section=brief`);
    const link = await page.getByRole("link", { name: /Download brief/ }).getAttribute("href");
    return (await (await page.request.get(link!.replace("format=brief", "format=json"))).json()) as {
      generation: { modality: string };
      references: { startFrameAssetId: string | null; productionFrame?: { assetId: string; source: string } };
    };
  };
  const modalityBefore = (await brief()).generation.modality;

  // Shot Prep → Production Frame → Generate candidates (no 3D set, no GPU, no provider)
  await page.goto(`${shotUrl}?section=production_frame`);
  await expect(section(page).getByTestId("pf-empty")).toBeVisible();
  await section(page).getByTestId("pf-generate-summary").click();
  const panel = section(page).getByTestId("pf-candidates-panel");
  await expect(section(page)).not.toContainText(/3D|GPU|COLMAP|splat|reconstruction|Vulkan/i);
  for (const id of MODELS) {
    const row = panel.locator(`[data-testid="model-row"][data-model="${id}"]`);
    await expect(row.getByTestId("model-cost")).toContainText("free");
    await row.getByTestId("model-pick").check();
  }
  await panel.getByTestId("ack-all").check();
  await panel.getByTestId("create-candidate-set").click();
  await page.waitForURL(/\/candidates\/[0-9a-f-]{36}/, { timeout: 90_000 });
  setUrl = new URL(page.url()).pathname;

  // queued in Postgres: nothing executes inside the request; the real worker process runs the jobs
  await expect(page.getByTestId("candidate-card")).toHaveCount(3);
  await expect(page.getByTestId("set-rollup")).toContainText("0/3 completed");
  const out = tsx("scripts/generation-worker.mts", ["--until-idle"]);
  expect(out).toContain("lyqdxiyjperhniwhzsvg");
  expect(out).not.toMatch(/service|password|postgres:\/\//i);

  await page.goto(setUrl);
  await expect(page.getByTestId("set-rollup")).toContainText("3/3 completed", { timeout: 60_000 });
  await expect(page.getByTestId("candidate-board")).toHaveAttribute("data-purpose", "production_frame");
  for (const id of MODELS) {
    const img = card(page, id).getByTestId("candidate-image");
    await expect(img).toBeVisible();
    // the image is served by the authenticated private asset route, never a Storage URL
    const src = (await img.getAttribute("src"))!;
    expect(src).toMatch(/^\/api\/assets\/[0-9a-f-]{36}$/);
    await expect(img).toHaveJSProperty("complete", true);
  }
  expect(await page.content()).not.toMatch(/supabase\.co\/storage|createSignedUrl|token=/);

  // review: Reject one, Best another (Best is only an experiment preference)
  await card(page, "mock-image-1").getByTestId("review-reject").click();
  await card(page, "mock-image-1").locator('[data-testid="reject-picker"] button').first().click();
  await expect(card(page, "mock-image-1")).toHaveAttribute("data-decision", "reject", { timeout: 30_000 });
  await card(page, "mock-image-lite").getByTestId("review-best").click();
  await expect(card(page, "mock-image-lite")).toHaveAttribute("data-preferred", "1", { timeout: 30_000 });
  await expect(page.getByTestId("current-production-frame")).toHaveCount(0);

  // the provider canvas is not the Shot's production frame: refused until the production conform exists
  const c = card(page, "mock-image-wide");
  await expect(c.getByTestId("use-as-pf")).toBeDisabled();
  await expect(c.getByTestId("pf-unavailable-reason")).toContainText("Create the production conform first.");
  await c.getByTestId("create-production-conform").click();
  await expect(c.getByTestId("use-as-pf")).toBeEnabled({ timeout: 120_000 });
  await c.getByTestId("use-as-pf").click();
  await expect(c.getByTestId("current-production-frame")).toBeVisible({ timeout: 60_000 });
  await expect(card(page, "mock-image-lite")).toHaveAttribute("data-preferred", "1"); // Best is independent

  // persisted in Postgres: Shot Prep shows it canonical, fresh, Generated; the package starts from it
  await page.reload();
  await expect(card(page, "mock-image-wide")).toHaveAttribute("data-current-frame", "1");
  await page.goto(`${shotUrl}?section=production_frame`);
  const selected = section(page).getByTestId("pf-selected");
  await expect(selected).toHaveAttribute("data-source", "generation_output");
  await expect(selected).toHaveAttribute("data-freshness", "fresh");
  await expect(section(page).getByTestId("pf-preview")).toHaveJSProperty("complete", true);
  const json = await brief();
  expect(json.references.productionFrame).toMatchObject({ source: "generation_output" });
  expect(json.references.startFrameAssetId).toBe(json.references.productionFrame!.assetId);
  expect(json.generation.modality).toBe(modalityBefore); // generating stills never changed the Shot

  // staleness through a Shot change; restored afterwards
  await page.goto(`${shotUrl}?section=lighting`);
  const mood = page.locator("#lighting input[name='lighting.mood']");
  const original = await mood.inputValue();
  try {
    await mood.fill("harsh noon sun");
    await page
      .locator("#lighting")
      .getByRole("button", { name: /Save lighting/i })
      .click();
    await expect(page.locator("#lighting")).toContainText("Saved");
    await page.goto(setUrl);
    for (const id of MODELS.slice(0, 2)) {
      await expect(card(page, id).getByTestId("candidate-stale")).toContainText("STALE");
      await expect(card(page, id).getByTestId("use-as-pf")).toBeDisabled();
      await expect(card(page, id).getByTestId("pf-unavailable-reason")).toContainText(
        "The Shot changed after this candidate was generated.",
      );
    }
  } finally {
    await page.goto(`${shotUrl}?section=lighting`);
    await page.locator("#lighting input[name='lighting.mood']").fill(original);
    await page
      .locator("#lighting")
      .getByRole("button", { name: /Save lighting/i })
      .click();
    await expect(page.locator("#lighting")).toContainText("Saved");
  }
});

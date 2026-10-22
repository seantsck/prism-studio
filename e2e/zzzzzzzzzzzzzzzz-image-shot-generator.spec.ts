import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Phase 2G.2 Image Shot Generator, memory mode, through the UI. NO 3D set, GPU, reconstruction or paid provider: the
 * free mock IMAGE models stand in for a provider (REAL IMAGE-MODEL CALLS: 0). Shot 4A is used because no other spec
 * edits it.
 *
 *   Shot Prep → Production Frame → Generate candidates → three still images → compare → review (Reject / Best) →
 *   "Use as Production Frame" (refused until the production conform exists: never a silent crop) → canonical frame →
 *   image-to-video would start from it; Best and the current frame are independent; a Shot change makes the other
 *   candidates STALE and refuses them.
 */

const EP = "/projects/ojousama/episodes/ep-1";
test.describe.configure({ mode: "serial" });

async function openShot(page: Page, code: string) {
  await page.goto(`${EP}/shots`);
  const href = await page.getByRole("link", { name: code, exact: true }).first().getAttribute("href");
  await page.goto(href!);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(code);
  return page.url().split("?")[0]!;
}

async function packageOf(page: Page, request: APIRequestContext, shotUrl: string) {
  await page.goto(`${shotUrl}?section=brief`);
  const href = await page.getByRole("link", { name: /Download brief/ }).getAttribute("href");
  return (await (await request.get(href!.replace("format=brief", "format=json"))).json()) as {
    generation: { modality: string };
    references: { startFrameAssetId: string | null; productionFrame?: Record<string, unknown> };
    assets: Record<string, Record<string, unknown>>;
  };
}

let shotUrl: string;
let setUrl: string;
let modalityBefore: string;

const section = (page: Page) => page.getByTestId("production-frame-section");
const card = (page: Page, model: string) =>
  page.locator(`[data-testid="candidate-card"][data-model="${model}"]`);

test("Generate candidates: three still images from three image models, no 3D set, GPU or paid call", async ({
  page,
  request,
}) => {
  shotUrl = await openShot(page, "4A");
  modalityBefore = (await packageOf(page, request, shotUrl)).generation.modality;

  await page.goto(`${shotUrl}?section=production_frame`);
  const pf = section(page);
  await expect(pf.getByTestId("pf-empty")).toContainText("generate candidates");
  await expect(pf.getByTestId("pf-generate-summary")).toContainText("Generate candidates");
  // no 3D / GPU / reconstruction wording anywhere in the section, candidates panel included
  await pf.getByTestId("pf-generate-summary").click();
  const panel = pf.getByTestId("pf-candidates-panel");
  await expect(panel).toBeVisible();
  await expect(pf).not.toContainText(/3D|GPU|COLMAP|splat|reconstruction|Vulkan/i);
  await expect(panel.getByTestId("pf-text-only")).toContainText("written intent alone");

  // only still-image models are offered, never a video model. The three Runway image models are listed but NOT
  // selectable here: this environment has no Runway key and paid generation is off (a key alone never enables spend).
  const models = panel.getByTestId("model-row");
  await expect(models).toHaveCount(6);
  await expect(models.filter({ hasText: /video/i })).toHaveCount(0);
  for (const id of ["gpt_image_2_5_flare", "muse_image", "seedream5_lite"]) {
    const row = panel.locator(`[data-testid="model-row"][data-model="${id}"]`);
    await expect(row).toContainText(/not configured|disabled|paid generation is switched off/);
    await expect(row.getByTestId("model-pick")).toBeDisabled();
  }
  for (const id of ["mock-image-1", "mock-image-lite", "mock-image-wide"]) {
    const row = panel.locator(`[data-testid="model-row"][data-model="${id}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("model-cost")).toContainText("free");
    await expect(row.getByTestId("model-canvas")).not.toHaveText("—"); // the provider canvas is shown before spend
    await row.getByTestId("model-pick").check();
  }
  // no duration or audio columns for a still
  await expect(panel.getByTestId("model-matrix")).not.toContainText("Duration");
  await expect(panel.getByTestId("model-matrix")).not.toContainText("Audio");

  await expect(panel.getByTestId("selected-count")).toContainText("3 selected");
  await expect(panel.getByTestId("selected-total")).toContainText("free");
  await panel.getByTestId("ack-all").check();
  const create = panel.getByTestId("create-candidate-set");
  await expect(create).toContainText("Generate 3 free images");
  await create.click();

  await expect(page).toHaveURL(/\/candidates\/[0-9a-f-]+$/);
  setUrl = page.url();
  const board = page.getByTestId("candidate-board");
  await expect(board).toHaveAttribute("data-purpose", "production_frame");
  await expect(page.getByTestId("candidate-card")).toHaveCount(3);
  for (const id of ["mock-image-1", "mock-image-lite", "mock-image-wide"])
    await expect(card(page, id)).toHaveAttribute("data-status", "succeeded", { timeout: 25_000 });
  // an IMAGE review surface: large stills, no playback controls
  await expect(board.getByTestId("sync-controls")).toHaveCount(0);
  await expect(page.getByTestId("candidate-video")).toHaveCount(0);
  for (const id of ["mock-image-1", "mock-image-lite", "mock-image-wide"]) {
    await expect(card(page, id).getByTestId("candidate-image")).toHaveJSProperty("complete", true);
    expect(
      await card(page, id)
        .getByTestId("candidate-image")
        .evaluate((el) => (el as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(64);
    // modality-aware copy: nothing calls a still a clip
    await expect(card(page, id)).not.toContainText(/clip|watch|video/i);
  }
  await expect(card(page, "mock-image-wide").getByTestId("dims-canvas")).toContainText("672");
});

test("Compare and review: Reject one, mark another Best; Best is NOT the Production Frame", async ({
  page,
}) => {
  await page.goto(setUrl);
  const a = card(page, "mock-image-1");
  const b = card(page, "mock-image-lite");
  const c = card(page, "mock-image-wide");

  await a.getByTestId("review-reject").click();
  await a.locator('[data-testid="reject-picker"] button').first().click();
  await expect(a).toHaveAttribute("data-decision", "reject");

  await b.getByTestId("review-best").click();
  await expect(b).toHaveAttribute("data-preferred", "1");
  await expect(b).toHaveAttribute("data-decision", "approve"); // Best implies a good verdict

  // Best did not select anything: no Production Frame exists, and nothing is current
  await expect(page.getByTestId("current-production-frame")).toHaveCount(0);
  await expect(c).toHaveAttribute("data-current-frame", "0");
  await page.goto(`${shotUrl}?section=production_frame`);
  await expect(section(page).getByTestId("pf-empty")).toBeVisible();
});

test("Use as Production Frame is refused until the production conform exists, then selects the conform", async ({
  page,
}) => {
  await page.goto(setUrl);
  const c = card(page, "mock-image-wide");
  // the provider canvas is not the Shot's 2.39:1 production frame: truthful reason, no silent crop
  await expect(c.getByTestId("use-as-pf")).toBeDisabled();
  await expect(c.getByTestId("pf-unavailable-reason")).toContainText("Create the production conform first.");

  await c.getByTestId("create-production-conform").click();
  await expect(c.getByTestId("use-as-pf")).toBeEnabled({ timeout: 30_000 });
  await expect(c.getByTestId("pf-unavailable-reason")).toHaveCount(0);
  await c.getByTestId("use-as-pf").click();

  // C is now the CURRENT PRODUCTION FRAME while B is still the BEST: two different things
  await expect(c.getByTestId("current-production-frame")).toContainText("CURRENT PRODUCTION FRAME");
  await expect(c).toHaveAttribute("data-current-frame", "1");
  await expect(card(page, "mock-image-lite")).toHaveAttribute("data-preferred", "1");
  await expect(card(page, "mock-image-lite")).toHaveAttribute("data-current-frame", "0");
  await expect(card(page, "mock-image-wide")).toHaveAttribute("data-preferred", "0");
  // the other candidates are untouched history, still unconformed
  await expect(card(page, "mock-image-lite").getByTestId("use-as-pf")).toBeDisabled();
});

test("Shot Prep: the generated frame is canonical, fresh and what image-to-video starts from", async ({
  page,
  request,
}) => {
  await page.goto(setUrl);
  await page.getByTestId("back-to-shot-prep").click();
  await expect(page).toHaveURL(/section=production_frame/);
  const pf = section(page);
  const selected = pf.getByTestId("pf-selected");
  await expect(selected).toHaveAttribute("data-version", "1");
  await expect(selected).toHaveAttribute("data-source", "generation_output");
  await expect(selected).toHaveAttribute("data-freshness", "fresh");
  await expect(selected).toContainText("Generated");
  await expect(selected).toContainText("2.39:1"); // the production aspect, not the provider canvas
  await expect(pf.getByTestId("pf-preview")).toHaveJSProperty("complete", true);
  await expect(pf.getByTestId("pf-generate-summary")).toContainText("Generate alternatives");
  await expect(page.getByTestId("rail-production-frame")).toContainText("Production Frame v1");
  await expect(pf).not.toContainText(/3D|GPU|COLMAP|splat|reconstruction|Vulkan/i);

  const json = await packageOf(page, request, shotUrl);
  expect(json.references.productionFrame).toMatchObject({
    version: 1,
    source: "generation_output",
    freshness: "fresh",
  });
  // image-to-video uses it automatically: it is the start frame
  expect(json.references.startFrameAssetId).toBe(json.references.productionFrame!.assetId);
  // generating stills never changed what the Shot itself is
  expect(json.generation.modality).toBe(modalityBefore);
  expect(json.assets[json.references.productionFrame!.assetId as string]).toMatchObject({
    purpose: "generation_output",
  });
  // the candidate attempts do not appear as the Shot's output attempts
  await page.goto(`${shotUrl}?section=generate`);
  await expect(page.getByTestId("attempt-card")).toHaveCount(0);
});

test("stale: a Shot change marks the other candidates STALE and refuses them, without rewriting them", async ({
  page,
}) => {
  await page.goto(`${shotUrl}?section=lighting`);
  const mood = page.locator("#lighting input[name='lighting.mood']");
  const original = await mood.inputValue();
  await mood.fill("harsh noon sun");
  await page
    .locator("#lighting")
    .getByRole("button", { name: /Save lighting/i })
    .click();
  await expect(page.locator("#lighting")).toContainText("Saved");

  await page.goto(setUrl);
  for (const id of ["mock-image-1", "mock-image-lite", "mock-image-wide"]) {
    await expect(card(page, id).getByTestId("candidate-stale")).toContainText("STALE");
    await expect(card(page, id).getByTestId("use-as-pf")).toBeDisabled();
    await expect(card(page, id).getByTestId("pf-unavailable-reason")).toContainText(
      "The Shot changed after this candidate was generated. Regenerate it from the current Production Frame intent before using it.",
    );
    await expect(card(page, id).getByTestId("pf-unavailable-reason")).toContainText("Lighting");
  }
  // history is never rewritten: the reviews and the Best mark are still there
  await expect(card(page, "mock-image-1")).toHaveAttribute("data-decision", "reject");
  await expect(card(page, "mock-image-lite")).toHaveAttribute("data-preferred", "1");
  await expect(card(page, "mock-image-wide")).toHaveAttribute("data-current-frame", "1");

  // restoring the Shot makes them usable again: nothing about the candidates was ever rewritten
  await page.goto(`${shotUrl}?section=lighting`);
  await page.locator("#lighting input[name='lighting.mood']").fill(original);
  await page
    .locator("#lighting")
    .getByRole("button", { name: /Save lighting/i })
    .click();
  await expect(page.locator("#lighting")).toContainText("Saved");
  await page.goto(setUrl);
  await expect(card(page, "mock-image-lite").getByTestId("candidate-stale")).toHaveCount(0);
});

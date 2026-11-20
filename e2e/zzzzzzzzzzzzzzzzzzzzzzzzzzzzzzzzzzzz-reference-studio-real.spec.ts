import { expect, test, type Page } from "@playwright/test";
import { portraitFixturePng } from "../src/generation/matting/fixture";

/**
 * The Reference Studio the way a REAL deployment shows it (memory-studio-real-isolated): a real image model can be
 * used, and the server does not ask for test models to be listed beside it. The free test models are switched on here
 * exactly as they are on the hosted review site, where the owner made two "pictures" with the one the Studio suggested
 * and got two gradients.
 *
 * GPT Image is worker-backed with an explicitly EMPTY key and no worker for it, so it can be chosen and priced and
 * nothing can leave this process. This spec never presses Generate.
 */
const STUDIO = "/projects/ojousama/studio";
const PAID_MODEL = "openai-image/gpt-image-2.5-flare";

const priced = async (page: Page) =>
  expect(page.getByTestId("studio-price")).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
const upTo = async (page: Page) =>
  Number((await page.getByTestId("studio-estimate").innerText()).replace("Up to $", ""));

test("no test model is offered: the real model is selected, and its price is on the button before anything is made", async ({
  page,
}) => {
  await page.goto(STUDIO);
  await expect(page.getByTestId("reference-studio")).toBeVisible();
  await page.getByTestId("studio-subject").filter({ hasText: "Yumeko" }).click();
  await expect(page.getByTestId("reference-studio")).toHaveAttribute("data-subject", /^character:/);

  // the only models listed are real ones; nothing here can draw a test pattern
  const model = page.getByTestId("studio-model");
  await expect(model).toHaveValue(PAID_MODEL);
  await expect(model.locator("option", { hasText: /\(test\)|Mock/ })).toHaveCount(0);
  await expect(model.locator(`option[value="${PAID_MODEL}"]`)).toHaveText(
    "GPT Image 2.5 Flare (OpenAI direct) (paid)",
  );
  await expect(page.getByTestId("studio-test-model")).toHaveCount(0);

  // from the written description alone: priced first, and the button says what it will cost
  await priced(page);
  const generate = page.getByTestId("studio-generate");
  await expect(generate).toHaveAttribute("data-paid", "true");
  const words = await upTo(page);
  expect(words).toBeGreaterThan(0);
  await expect(generate).toHaveText(`Generate · up to $${words}`);
  await expect(page.getByTestId("studio-sent").locator("summary")).toContainText("Sends no image");

  // two photographs: both become starting images, and the price on the button covers both
  await page.getByTestId("studio-upload-file").setInputFiles([
    { name: "yumeko-front.png", mimeType: "image/png", buffer: Buffer.from(portraitFixturePng(768, 1024)) },
    { name: "yumeko-side.png", mimeType: "image/png", buffer: Buffer.from(portraitFixturePng(600, 800)) },
  ]);
  await expect(page.getByTestId("studio-upload-item")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('[data-testid="studio-upload-item"][data-state="checking"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  await page.getByTestId("studio-upload-submit").click();
  await expect(page.getByTestId("studio-source")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('[data-testid="studio-source"][aria-pressed="true"]')).toHaveCount(2);
  await expect(page.getByTestId("studio-starting-set")).toHaveAttribute("data-count", "2");
  await expect(page.getByTestId("studio-sent").locator("summary")).toContainText("Sends 2 images", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("studio-sent-strip")).toHaveAttribute("data-count", "2");
  const two = await upTo(page);
  expect(two).toBeGreaterThan(words);
  await expect(generate).toHaveText(`Generate · up to $${two}`);
  await expect(page.locator('input[name="confirmedTotalUsd"]')).toHaveCount(1);

  // nothing was started: this story never presses Generate
  await page.reload();
  await expect(page.getByTestId("studio-take-thumb")).toHaveCount(0);
  await expect(page.getByTestId("studio-spent")).toHaveText("Nothing billed for Yumeko yet");
  await expect(page.getByTestId("studio-model")).toHaveValue(PAID_MODEL);
});

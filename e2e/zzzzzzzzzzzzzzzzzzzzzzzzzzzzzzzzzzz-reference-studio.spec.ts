import { expect, test, type Page } from "@playwright/test";
import { busyFixturePng, portraitFixturePng } from "../src/generation/matting/fixture";
import { readImageSize, readJpegOrientation } from "../src/lib/image-size";

/**
 * The Reference Studio on its own memory server (memory-studio-isolated): one screen that turns a reference photograph
 * into production references, on the EXISTING Character / Location image pipeline.
 *
 * The free test models make a placeholder pattern, so these stories prove the WORKFLOW (what is sent, what is kept,
 * what is labelled, what is promoted), never the look of a picture. GPT Image is also listed, as a PAID worker-backed
 * model with an explicitly EMPTY key and no worker for it: it can be chosen and priced, and nothing can leave this
 * process. No story presses Generate with a paid model.
 *
 *   A  The Studio is in the navigation, opens on the first Character and offers every angle
 *   B  Add a photo → it is the starting image, kept as the original, with honest facts about the file
 *   C  3/4 view FROM the photo → what will be sent is shown → Generate (free) → a labelled, costed take beside its source
 *   D  A second angle → compare both beside what they started from
 *   E  Use as reference (the slot the take suggests) → the Character page shows it as a generated reference
 *   F  Reject a take with a reason → it leaves the starting images, stays in history → Restore
 *   G  Change an image (hair colour) → only the change is sent → a new image; the photo is untouched → Reuse settings
 *   H  A Location from words alone → Use as canonical location
 *   I  A paid model: its dollar price is shown before anything is made, the button carries it, quality moves it
 *   J  The Character page opens the Studio for that Character; a small photo is flagged
 *   K  Cut the person out of the photo with Prism's own free tool (original pixels) → Use as cutout
 *   L  The upload area: choose or drop several photos → each is listed with what will be sent → Upload → the first
 *      becomes the starting image; a file that is not a picture never leaves the browser
 *   M  A photo too large for one upload, and one its camera stored turned, are added as copies that say so
 *
 * This server states a 1 MB upload limit (PRISM_STUDIO_MAX_UPLOAD_BYTES), standing in for a host's small request cap.
 */
test.describe.configure({ mode: "serial" });

const P = "/projects/ojousama";
const STUDIO = `${P}/studio`;
const PAID_MODEL = "openai-image/gpt-image-2.5-flare";

const priced = async (page: Page) =>
  expect(page.getByTestId("studio-price")).toHaveAttribute("data-state", "ready", { timeout: 20_000 });

/** The focused take is number `n` and finished. */
const finished = async (page: Page, n: number) => {
  const take = page.getByTestId("studio-take");
  await expect(take.locator("h2")).toContainText(`#${n} `, { timeout: 30_000 });
  await expect(take).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
};

/** Makes sure a starting image is selected (a click on a selected one would take it out again). */
async function choose(tile: ReturnType<Page["getByTestId"]>) {
  if ((await tile.getAttribute("aria-pressed")) !== "true") await tile.click();
  await expect(tile).toHaveAttribute("aria-pressed", "true");
}

/** Every photo in the upload list has been read (none is still being checked). */
const listed = async (page: Page, count: number) => {
  const items = page.getByTestId("studio-upload-item");
  await expect(items).toHaveCount(count, { timeout: 30_000 });
  await expect(page.locator('[data-testid="studio-upload-item"][data-state="checking"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  return items;
};

type Dropped = { name: string; mimeType: string; buffer: Buffer };

/** Drops files onto an element the way a drag from the desktop does. */
async function dropFiles(page: Page, testId: string, files: Dropped[]) {
  const dataTransfer = await page.evaluateHandle(
    (list) => {
      const dt = new DataTransfer();
      for (const f of list)
        dt.items.add(
          new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name, { type: f.mimeType }),
        );
      return dt;
    },
    files.map((f) => ({ name: f.name, mimeType: f.mimeType, base64: f.buffer.toString("base64") })),
  );
  const target = `[data-testid="${testId}"]`;
  await page.dispatchEvent(target, "dragover", { dataTransfer });
  await expect(page.getByTestId("studio-upload")).toHaveAttribute("data-dragging", "true");
  await page.dispatchEvent(target, "drop", { dataTransfer });
  await expect(page.getByTestId("studio-upload")).toHaveAttribute("data-dragging", "false");
}

/**
 * A JPEG drawn in the page (a drawing, not a person): a red block in the STORED top-left corner on a blue ground, with
 * grain when `grain` > 0, which is what makes a camera file heavy.
 */
async function drawnJpeg(page: Page, width: number, height: number, grain: number): Promise<Buffer> {
  const base64 = await page.evaluate(
    async ({ width, height, grain }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext("2d")!;
      g.fillStyle = "#28408c";
      g.fillRect(0, 0, width, height);
      g.fillStyle = "#d21e1e";
      g.fillRect(0, 0, width / 4, height / 4);
      if (grain > 0) {
        const image = g.getImageData(0, 0, width, height);
        const d = image.data;
        let seed = 12345;
        for (let i = 0; i < d.length; i += 4) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const n = ((seed >>> 24) / 255 - 0.5) * 2 * grain;
          d[i] += n;
          d[i + 1] += n;
          d[i + 2] += n;
        }
        g.putImageData(image, 0, 0);
      }
      const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), "image/jpeg", 0.95));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    },
    { width, height, grain },
  );
  return Buffer.from(base64, "base64");
}

/** The same JPEG with a camera's rotation flag (EXIF orientation) written into it, the way a phone stores a photo. */
function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.from([
    ...[0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1],
    ...[0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0],
    ...[0, 0, 0, 0],
  ]);
  const exif = Buffer.concat([
    Buffer.from([0xff, 0xe1, 0, 2 + 6 + tiff.length]),
    Buffer.from("Exif\0\0", "binary"),
    tiff,
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
}

/** The colour of the stored image at its top corners, read from the bytes Prism serves. */
async function storedCorners(page: Page, assetId: string) {
  return page.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const g = canvas.getContext("2d")!;
    g.drawImage(bitmap, 0, 0);
    const at = (x: number, y: number) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    return { topLeft: at(40, 40), topRight: at(bitmap.width - 40, 40) };
  }, `/api/assets/${assetId}`);
}

async function openYumeko(page: Page) {
  await page.goto(STUDIO);
  await expect(page.getByTestId("reference-studio")).toBeVisible();
  await page.getByTestId("studio-subject").filter({ hasText: "Yumeko" }).click();
  await expect(page.getByTestId("reference-studio")).toHaveAttribute("data-subject", /^character:/);
}

test("A: the Studio is in the navigation, opens on the first Character and offers every angle", async ({
  page,
}) => {
  await page.goto(P);
  await page.getByRole("link", { name: "Reference Studio", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${STUDIO}$`));
  await expect(page.getByRole("heading", { name: "Reference Studio" })).toBeVisible();
  const studio = page.getByTestId("reference-studio");
  await expect(studio).toHaveAttribute("data-subject", /^character:/);
  // every Character and Location of the project can be worked on
  await expect(page.getByTestId("studio-subject").filter({ hasText: "Yumeko" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("studio-subject").filter({ hasText: "Grand Celeste Lobby" })).toBeVisible();
  for (const preset of [
    "portrait",
    "three_quarter",
    "profile_left",
    "profile_right",
    "half_body",
    "full_body",
    "outfit_variant",
    "look_sheet",
    "expression_variant",
    "scene_variation",
  ])
    await expect(page.getByTestId(`studio-preset-${preset}`)).toBeVisible();
  // nothing exists yet: the stage says what to do, and nothing has been billed
  await expect(page.getByTestId("studio-empty")).toContainText("No picture of Yumeko yet");
  await expect(page.getByTestId("studio-spent")).toHaveText("Nothing billed for Yumeko yet");
  // Prism suggests a free model first; the paid one is listed, labelled, and never chosen for the creator
  await expect(page.getByTestId("studio-model")).toHaveValue("mock/mock-image-1");
  await expect(page.getByTestId("studio-model").locator(`option[value="${PAID_MODEL}"]`)).toHaveText(
    "GPT Image 2.5 Flare (OpenAI direct) (paid)",
  );
  await priced(page);
  await expect(page.getByTestId("studio-estimate")).toContainText("No charge: a test model");
  await expect(page.getByTestId("studio-sent").locator("summary")).toContainText(
    "Sends no image, only the written description",
  );
});

test("B: a photo the creator adds becomes the starting image, kept as it is, with honest facts about the file", async ({
  page,
}) => {
  await openYumeko(page);
  const bytes = Buffer.from(portraitFixturePng(768, 1024));
  await page.getByTestId("studio-upload-file").setInputFiles({
    name: "yumeko-front.png",
    mimeType: "image/png",
    buffer: bytes,
  });
  await page.getByTestId("studio-upload-as").selectOption("reference");
  await page.getByTestId("studio-upload-submit").click();
  const source = page.getByTestId("studio-source");
  await expect(source).toHaveCount(1, { timeout: 30_000 });
  // it is selected on arrival (the creator added it to use it), and shown large on the stage
  await expect(source.first()).toHaveAttribute("aria-pressed", "true");
  await expect(source.first()).toHaveAttribute("data-origin", "uploaded");
  await expect(page.getByTestId("studio-starting")).toBeVisible();
  const facts = page.getByTestId("studio-inspection");
  await expect(facts).toHaveAttribute("data-verdict", "usable");
  await expect(facts).toContainText("yumeko-front.png");
  await expect(page.getByTestId("studio-source-origin")).toHaveText("uploaded original");
  await expect(facts).toContainText("768 × 1024 px · PNG");
  await expect(page.getByTestId("studio-verdict")).toHaveText("Usable");
  await facts.locator("summary").click();
  await expect(facts).toContainText(
    "Sharpness, lighting and expression are not measured: judge them by eye.",
  );
  await expect(page.getByTestId("studio-usage")).toContainText("In the project:");
  // the stored original is byte-for-byte what was uploaded
  const assetId = (await source.first().getAttribute("data-asset"))!;
  const stored = await page.request.get(`/api/assets/${assetId}`);
  expect(stored.ok()).toBe(true);
  expect(Buffer.from(await stored.body()).equals(bytes)).toBe(true);
});

test("C: a 3/4 view FROM the photo: what will be sent is shown, then a labelled take appears beside its source", async ({
  page,
}) => {
  await openYumeko(page);
  const photo = page.getByTestId("studio-source").first();
  await expect(photo).toHaveAttribute("aria-pressed", "true");
  const photoId = (await photo.getAttribute("data-asset"))!;
  await page.getByTestId("studio-preset-three_quarter").click();
  await priced(page);
  const sent = page.getByTestId("studio-sent");
  await expect(sent.locator("summary")).toContainText("Sends 1 image");
  await sent.locator("summary").click();
  const prompt = page.getByTestId("studio-prompt");
  await expect(prompt).toContainText("The same person as in the identity reference image");
  await expect(prompt).toContainText("the reference image wins where they differ");
  await expect(prompt).toContainText("Three-quarter view");
  await expect(prompt).toContainText("Plain light-grey studio background");
  // rules for the software, the story's canon and the film's night lighting are not image content
  await expect(prompt).not.toContainText("Guardrails");
  await expect(prompt).not.toContainText("vehicle door");
  await expect(prompt).not.toContainText("Cinematic night photography");

  const generate = page.getByTestId("studio-generate");
  await expect(generate).toHaveText("Generate");
  await expect(generate).toHaveAttribute("data-paid", "false");
  await generate.click();
  await finished(page, 1);
  const take = page.getByTestId("studio-take");
  await expect(take.locator("h2")).toHaveText("#1 3/4 view");
  // a generated picture is never presented as a photograph, and a free model is never shown as money spent
  await expect(page.getByTestId("studio-kind-note")).toHaveText("Generated reference, not a photograph");
  await expect(page.getByTestId("studio-cost")).toHaveText("No charge");
  await expect(page.getByTestId("studio-spent")).toHaveText("Nothing billed for Yumeko yet");
  await expect(page.getByTestId("studio-result")).toBeVisible();
  // the stage shows what it started from, and the record says so too
  await expect(page.getByTestId("studio-inputs").locator("img")).toHaveAttribute(
    "src",
    `/api/assets/${photoId}`,
  );
  await page.getByTestId("studio-provenance").locator("summary").click();
  await expect(page.getByTestId("studio-provenance")).toContainText("1 image: yumeko-front.png.");
  // the result joins the starting images, marked as generated
  const tiles = page.getByTestId("studio-source");
  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(1)).toHaveAttribute("data-origin", "generated");
  await expect(tiles.nth(1)).toContainText("generated");
});

test("D: a second angle, and both compared beside what they started from", async ({ page }) => {
  await openYumeko(page);
  // the creator's photograph is the starting image again on a fresh visit
  await choose(page.getByTestId("studio-source").first());
  await page.getByTestId("studio-preset-profile_left").click();
  await priced(page);
  await page.getByTestId("studio-sent").locator("summary").click();
  await expect(page.getByTestId("studio-prompt")).toContainText("faces the LEFT edge of the picture");
  await page.getByTestId("studio-generate").click();
  await finished(page, 2);
  await expect(page.getByTestId("studio-take").locator("h2")).toHaveText("#2 Left profile");
  await expect(page.getByTestId("studio-take-thumb")).toHaveCount(2);

  const toggles = page.getByTestId("studio-compare-toggle");
  await toggles.nth(0).check();
  await expect(page.getByTestId("studio-surface")).toHaveAttribute("data-view", "take");
  await toggles.nth(1).check();
  await expect(page.getByTestId("studio-surface")).toHaveAttribute("data-view", "compare");
  const compare = page.getByTestId("studio-compare");
  await expect(compare.locator("img")).toHaveCount(3);
  await expect(page.getByTestId("studio-compare-start")).toContainText("What they started from");
  await expect(compare).toContainText("#2 Left profile");
  await expect(compare).toContainText("#1 3/4 view");
  await page.getByTestId("studio-compare-exit").click();
  await expect(page.getByTestId("studio-surface")).toHaveAttribute("data-view", "take");
});

test("E: Use as reference fills the slot the take suggests; the Character page shows a generated reference", async ({
  page,
}) => {
  await openYumeko(page);
  // the older take (#1, the 3/4 view) suggests the 3/4 slot; the newer one (#2, the left profile) the profile slot
  await expect(page.getByTestId("studio-take").locator("h2")).toHaveText("#2 Left profile");
  await expect(page.getByTestId("studio-slot")).toHaveValue("profile");
  await page.getByTestId("studio-take-thumb").nth(1).click();
  await expect(page.getByTestId("studio-take").locator("h2")).toHaveText("#1 3/4 view");
  await expect(page.getByTestId("studio-slot")).toHaveValue("three_quarter");
  // the seeded slot is a placeholder with no image: there is nothing to replace, so nothing to confirm
  await expect(page.getByTestId("studio-confirm-replace-slot")).toHaveCount(0);
  await page.getByTestId("studio-use-reference").click();
  await expect(page.getByTestId("studio-take")).toContainText("Three quarter reference", { timeout: 30_000 });
  await expect(page.getByTestId("studio-take-thumb").nth(1)).toContainText("in use");

  const characterId = (await page.getByTestId("reference-studio").getAttribute("data-subject"))!.split(
    ":",
  )[1]!;
  await page.goto(`${P}/characters/${characterId}`);
  const slot = page.getByTestId("identity-slot-three_quarter");
  await expect(slot.locator("img")).toBeVisible();
  await expect(slot.getByTestId("identity-origin")).toHaveText("generated reference");
  await expect(page.getByTestId("vb-item-three_quarter")).toHaveAttribute("data-done", "true");
  // filling a second image into the same slot from the Studio now asks first
  await page.goto(`${STUDIO}?subject=character:${characterId}`);
  await page.getByTestId("studio-slot").selectOption("three_quarter");
  await expect(page.getByTestId("studio-confirm-replace-slot")).toBeVisible();
  await page.getByTestId("studio-use-reference").click();
  await expect(page.getByText("Yumeko already has a three quarter reference.")).toBeVisible();
});

test("F: a rejected take leaves the starting images, stays in history with its reason, and can be restored", async ({
  page,
}) => {
  await openYumeko(page);
  await expect(page.getByTestId("studio-take").locator("h2")).toHaveText("#2 Left profile");
  await expect(page.getByTestId("studio-source")).toHaveCount(3);
  await page.getByTestId("studio-reject-open").click();
  await page.getByTestId("studio-reject-category").selectOption("identity_drift");
  await page.getByTestId("studio-reject-reason").fill("jaw too narrow");
  await page.getByTestId("studio-reject").click();
  const take = page.getByTestId("studio-take");
  await expect(take).toHaveAttribute("data-rejected", "true", { timeout: 30_000 });
  await expect(page.getByTestId("studio-rejection")).toHaveText("Identity drift · jaw too narrow");
  // kept, not deleted: the picture is still there; it is just no longer something to start from or to use
  await expect(page.getByTestId("studio-result")).toBeVisible();
  await expect(page.getByTestId("studio-source")).toHaveCount(2);
  await expect(page.getByTestId("studio-use")).toHaveCount(0);
  await expect(page.getByTestId("studio-show-rejected")).toBeVisible();

  // a take the Visual Bible uses cannot be rejected until that use ends
  await page.getByRole("button", { name: /^Take 1: 3\/4 view/ }).click();
  await expect(take.locator("h2")).toHaveText("#1 3/4 view");
  await page.getByTestId("studio-reject-open").click();
  await page.getByTestId("studio-reject").click();
  await expect(
    page.getByText(/This image is in use \(Yumeko · three quarter identity reference\)/),
  ).toBeVisible();

  await page.getByTestId("studio-show-rejected").check();
  await page.getByRole("button", { name: /^Take 2: Left profile, rejected/ }).click();
  await page.getByTestId("studio-restore").click();
  await expect(take).toHaveAttribute("data-rejected", "false", { timeout: 30_000 });
  await expect(page.getByTestId("studio-source")).toHaveCount(3);
});

test("G: changing an image sends only the change; the result is new, the photo untouched; settings can be reused", async ({
  page,
}) => {
  await openYumeko(page);
  const photo = page.getByTestId("studio-source").first();
  const photoId = (await photo.getAttribute("data-asset"))!;
  const before = Buffer.from(await (await page.request.get(`/api/assets/${photoId}`)).body());
  await page.getByTestId("studio-mode-change").click();
  await choose(photo);
  for (const edit of [
    "hair_color",
    "wardrobe",
    "lighting_quality",
    "clean_background",
    "replace_background",
    "custom",
  ])
    await expect(page.getByTestId(`studio-edit-${edit}`)).toBeVisible();
  await page.getByTestId("studio-edit-hair_color").click();
  // the change must say what it should be
  await expect(page.getByTestId("studio-problem")).toHaveText("New hair colour: say what it should be.", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("studio-generate")).toBeDisabled();
  await page.getByTestId("studio-value").fill("auburn");
  await priced(page);
  await page.getByTestId("studio-sent").locator("summary").click();
  const prompt = page.getByTestId("studio-prompt");
  await expect(prompt).toContainText(
    "Change only this in the image being edited: Change the hair colour to auburn. Keep the same hairstyle, length and hairline.",
  );
  await expect(prompt).toContainText("Keep everything else exactly as it is");
  // nothing that would re-frame the picture or contradict the change rides along
  await expect(prompt).not.toContainText("Front portrait");
  await expect(prompt).not.toContainText("black hair");
  await expect(page.getByTestId("studio-sent").locator("summary")).toContainText("Sends 1 image");
  // the photo is 3:4; this test model has no such shape, and the Studio says so instead of re-framing silently
  await expect(page.getByTestId("studio-reframed")).toContainText("Your image is 768 × 1024.");
  await expect(page.getByTestId("studio-generate")).toHaveText("Change image");
  await page.getByTestId("studio-generate").click();
  await finished(page, 3);
  await expect(page.getByTestId("studio-take").locator("h2")).toHaveText("#3 Change");
  await expect(page.getByTestId("studio-kind-note")).toHaveText("Generated change, not the original picture");
  const after = Buffer.from(await (await page.request.get(`/api/assets/${photoId}`)).body());
  expect(after.equals(before), "the original photograph is byte-for-byte unchanged").toBe(true);

  // Reuse these settings loads the request back; nothing is sent until Generate is pressed
  await page.getByTestId("studio-mode-make").click();
  await page.getByTestId("studio-reuse").click();
  await expect(page.getByTestId("studio-mode-change")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("studio-edit-hair_color")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("studio-value")).toHaveValue("auburn");
  await expect(page.getByTestId("studio-take-thumb")).toHaveCount(3);
});

test("H: a Location from words alone, then Use as canonical location", async ({ page }) => {
  await page.goto(STUDIO);
  await page.getByTestId("studio-subject").filter({ hasText: "Grand Celeste Lobby" }).click();
  await expect(page.getByTestId("reference-studio")).toHaveAttribute("data-subject", /^location:/);
  for (const preset of [
    "location_concept",
    "establishing_view",
    "interior_view",
    "background",
    "time_variant",
  ])
    await expect(page.getByTestId(`studio-preset-${preset}`)).toBeVisible();
  await expect(page.getByTestId("studio-preset-portrait")).toHaveCount(0);
  await priced(page);
  await expect(page.getByTestId("studio-sent").locator("summary")).toContainText("Sends no image");
  await page.getByTestId("studio-sent").locator("summary").click();
  await expect(page.getByTestId("studio-prompt")).toContainText("Grand Celeste Lobby");
  // a Location is the film's world, so it carries the project's visual style (a Character studio reference does not)
  await expect(page.getByTestId("studio-prompt")).toContainText("Cinematic night photography");
  await page.getByTestId("studio-generate").click();
  await finished(page, 1);
  await expect(page.getByTestId("studio-take").locator("h2")).toHaveText("#1 Location concept");
  // the seeded Location is locked: making a picture is fine, using it is the creator's explicit unlock away
  await expect(page.getByTestId("studio-locked")).toContainText(
    "Grand Celeste Lobby is locked, so its references and Visual Bible cannot change.",
  );
  await expect(page.getByTestId("studio-use-canonical")).toBeDisabled();
  await page.getByTestId("studio-locked").getByRole("link").click();
  const lobby = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Grand Celeste Lobby" }) });
  await lobby.evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
  });
  await lobby.getByRole("button", { name: "Unlock location" }).click();
  await expect(lobby.getByRole("button", { name: "Lock location" })).toBeVisible({ timeout: 30_000 });
  await page.goto(STUDIO);
  await page.getByTestId("studio-subject").filter({ hasText: "Grand Celeste Lobby" }).click();
  await expect(page.getByTestId("studio-take").locator("h2")).toHaveText("#1 Location concept");
  await expect(page.getByTestId("studio-locked")).toHaveCount(0);
  await page.getByTestId("studio-use-canonical").click();
  await expect(page.getByTestId("studio-take")).toContainText("Canonical location", { timeout: 30_000 });
  await expect(page.getByTestId("studio-use-canonical")).toBeDisabled();
  await expect(
    page.getByTestId("studio-subject").filter({ hasText: "Grand Celeste Lobby" }).locator("img"),
  ).toBeVisible();
});

test("I: a paid model shows its dollar price before anything is made, and the button carries that amount", async ({
  page,
}) => {
  await openYumeko(page);
  const takesBefore = await page.getByTestId("studio-take-thumb").count();
  await page.getByTestId("studio-mode-make").click();
  await choose(page.getByTestId("studio-source").first());
  await page.getByTestId("studio-preset-half_body").click();
  await page.getByTestId("studio-model").selectOption(PAID_MODEL);
  await priced(page);
  const estimate = page.getByTestId("studio-estimate");
  await expect(estimate).toHaveText(/^Up to \$0\.\d+$/);
  const medium = Number((await estimate.innerText()).replace("Up to $", ""));
  expect(medium).toBeGreaterThan(0);
  // nothing has been made with this model here, so nothing is guessed
  await expect(page.getByTestId("studio-typical")).toHaveText("Nothing comparable has been made here yet.");
  const generate = page.getByTestId("studio-generate");
  await expect(generate).toHaveAttribute("data-paid", "true");
  await expect(generate).toHaveText(`Generate · up to $${medium}`);
  await expect(page.locator('input[name="confirmedTotalUsd"]')).toHaveCount(1);
  expect(Number(await page.locator('input[name="confirmedTotalUsd"]').inputValue())).toBeCloseTo(medium, 3);
  // a real model offers the picture shapes a reference needs, and its own quality ladder
  await expect(page.getByTestId("studio-format").locator("option").first()).toHaveText("Auto: Portrait 2:3");
  await page.getByTestId("studio-sent").locator("summary").click();
  await expect(page.getByTestId("studio-prompt")).toContainText(
    "Create a new image. The reference images show who or what must be reproduced faithfully",
  );
  await expect(page.getByTestId("studio-prompt")).toContainText("Half-body view");
  // the fine print is in dollars and words, never in provider credits
  await expect(page.getByTestId("studio-basis")).toHaveText(
    "Upper bound from the provider\u2019s published prices. It covers the picture, the image sent with it and the prompt text.",
  );
  await expect(page.getByTestId("studio-price")).not.toContainText(/credit/i);
  await expect(page.getByTestId("studio-sent")).not.toContainText(/credit/i);
  await page.getByTestId("studio-quality").selectOption("high");
  await priced(page);
  await expect
    .poll(async () => Number((await estimate.innerText()).replace("Up to $", "")), { timeout: 20_000 })
    .toBeGreaterThan(medium);
  await page.getByTestId("studio-quality").selectOption("low");
  await expect
    .poll(async () => Number((await estimate.innerText()).replace("Up to $", "")), { timeout: 20_000 })
    .toBeLessThan(medium);
  // from words alone it costs less than with a starting image
  await page.getByTestId("studio-quality").selectOption("");
  await page.getByTestId("studio-source-none").click();
  await expect
    .poll(async () => Number((await estimate.innerText()).replace("Up to $", "")), { timeout: 20_000 })
    .toBeLessThan(medium);
  // this story never presses Generate: nothing was queued and nothing was billed
  await page.reload();
  await expect(page.getByTestId("studio-take-thumb")).toHaveCount(takesBefore);
  await expect(page.getByTestId("studio-spent")).toHaveText("Nothing billed for Yumeko yet");
});

test("J: the Character page opens the Studio for that Character; a small or busy photo is accepted and flagged honestly", async ({
  page,
}) => {
  await page.goto(`${P}/characters`);
  await page.getByRole("link", { name: /Sean/ }).first().click();
  await page.getByTestId("vb-open-studio").click();
  await expect(page.getByTestId("reference-studio")).toHaveAttribute("data-subject", /^character:/);
  await expect(page.getByTestId("studio-subject").filter({ hasText: "Sean" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("studio-empty")).toContainText("No picture of Sean yet");
  await page.getByTestId("studio-upload-file").setInputFiles({
    name: "sean-small.png",
    mimeType: "image/png",
    buffer: Buffer.from(busyFixturePng(200, 260)),
  });
  await page.getByTestId("studio-upload-submit").click();
  await expect(page.getByTestId("studio-source")).toHaveCount(1, { timeout: 30_000 });
  const facts = page.getByTestId("studio-inspection");
  await expect(facts).toHaveAttribute("data-verdict", "low");
  await expect(page.getByTestId("studio-verdict")).toHaveText("Small image");
  await facts.locator("summary").click();
  await expect(facts).toContainText("The shorter side is 200 px.");
  // and a file that only claims to be a picture is refused in the list, in words the creator can act on: there is
  // nothing to upload
  await page.getByTestId("studio-upload-file").setInputFiles({
    name: "notes.png",
    mimeType: "image/png",
    buffer: Buffer.from("these are words, not a picture, and long enough to be read as a file"),
  });
  const refused = await listed(page, 1);
  await expect(refused).toHaveAttribute("data-state", "refused");
  await expect(page.getByTestId("studio-upload-refused")).toHaveText(
    "This file could not be opened as a picture. It may be damaged, or not really an image.",
  );
  await expect(page.getByTestId("studio-upload-submit")).toBeDisabled();
  await page.getByTestId("studio-upload-remove").click();
  await expect(page.getByTestId("studio-upload-item")).toHaveCount(0);
  await expect(page.getByTestId("studio-source")).toHaveCount(1);
});

test("K: cutting the person out keeps the original pixels, costs nothing, and becomes the Character's cutout", async ({
  page,
}) => {
  await openYumeko(page);
  const takes = await page.getByTestId("studio-take-thumb").count();
  await page.getByTestId("studio-mode-change").click();
  await choose(page.getByTestId("studio-source").first());
  await page.getByTestId("studio-edit-cutout").click();
  await expect(page.getByTestId("studio-edit-cutout")).toHaveAttribute("aria-pressed", "true");
  // this is not a generated change: no model, no format, no price to work out
  await expect(page.getByTestId("studio-cutout-note")).toContainText(
    "No charge. Prism's own tool keeps the original pixels and removes a plain background.",
  );
  await expect(page.getByTestId("studio-generate")).toBeHidden();
  await page.getByTestId("studio-cutout").click();
  await finished(page, takes + 1);
  await expect(page.getByTestId("studio-take").locator("h2")).toHaveText(`#${takes + 1} Cutout`);
  await expect(page.getByTestId("studio-kind-note")).toHaveText(
    "Cutout: the original pixels with the background removed",
  );
  await expect(page.getByTestId("studio-cost")).toHaveText("No charge");
  await expect(page.getByTestId("studio-inputs")).toContainText("The original");
  await page.getByTestId("studio-use-cutout").click();
  await expect(page.getByTestId("studio-take")).toContainText("Cutout", { timeout: 30_000 });
  await expect(page.getByTestId("studio-use-cutout")).toBeDisabled();
});

test("L: the upload area takes several photos at once, chosen or dropped, and lists what will be sent first", async ({
  page,
}) => {
  await page.goto(STUDIO);
  await page.getByTestId("studio-subject").filter({ hasText: "Takumi" }).click();
  await expect(page.getByTestId("studio-subject").filter({ hasText: "Takumi" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // with no picture yet, adding one is the first thing on the screen, in the brief and on the stage
  await expect(page.getByTestId("studio-upload-zone")).toContainText("Add reference photos of Takumi");
  await expect(page.getByTestId("studio-upload-zone")).toContainText("JPEG, PNG or WebP, several at once.");
  await expect(page.getByTestId("studio-empty")).toContainText("No picture of Takumi yet");

  const front = Buffer.from(portraitFixturePng(768, 1024));
  const side = Buffer.from(portraitFixturePng(600, 800));
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("studio-empty-choose").click();
  const dialog = await chooser;
  expect(dialog.isMultiple()).toBe(true);
  await dialog.setFiles([
    { name: "takumi-front.png", mimeType: "image/png", buffer: front },
    { name: "takumi-side.png", mimeType: "image/png", buffer: side },
  ]);
  const items = await listed(page, 2);
  await expect(items.nth(0)).toHaveAttribute("data-state", "ready");
  await expect(items.nth(0)).toContainText("takumi-front.png");
  await expect(items.nth(0).getByTestId("studio-upload-facts")).toHaveText(
    "768 × 1024 px · PNG · 52 KB · Usable",
  );
  await expect(items.nth(1).getByTestId("studio-upload-facts")).toContainText("600 × 800 px · PNG");
  // listed, not sent: nothing has been uploaded yet
  await expect(page.getByTestId("studio-source")).toHaveCount(0);
  await expect(page.getByTestId("studio-upload-submit")).toHaveText("Upload 2 photos");

  // a drop anywhere on the Studio joins the same list; a file that is not a picture is refused there and then
  await dropFiles(page, "studio-surface", [
    { name: "takumi-small.png", mimeType: "image/png", buffer: Buffer.from(portraitFixturePng(240, 320)) },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a picture") },
  ]);
  await listed(page, 4);
  await expect(items.nth(2).getByTestId("studio-upload-facts")).toContainText("Small image");
  await expect(items.nth(3)).toHaveAttribute("data-state", "refused");
  await expect(items.nth(3).getByTestId("studio-upload-refused")).toHaveText(
    "This is not a JPEG, PNG or WebP picture.",
  );
  await expect(page.getByTestId("studio-upload-submit")).toHaveText("Upload 3 photos");
  await items.nth(2).getByTestId("studio-upload-remove").click();
  await expect(page.getByTestId("studio-upload-submit")).toHaveText("Upload 2 photos");

  // one slot holds one photo
  await page.getByTestId("studio-upload-as").selectOption("front");
  await expect(page.getByTestId("studio-upload-one-per-slot")).toBeVisible();
  await expect(page.getByTestId("studio-upload-submit")).toBeDisabled();
  await page.getByTestId("studio-upload-as").selectOption("reference");

  await page.getByTestId("studio-upload-submit").click();
  const tiles = page.getByTestId("studio-source");
  await expect(tiles).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("studio-upload-status")).toHaveText(
    "2 photos added to Takumi\u2019s pictures.",
  );
  // the first photo of the batch is the starting image; the second is there to choose
  await expect(page.locator('[data-testid="studio-source"][aria-pressed="true"]')).toHaveCount(1);
  await expect(page.getByTestId("studio-inspection")).toContainText("takumi-front.png");
  await expect(page.getByTestId("studio-source-origin")).toHaveText("uploaded original");
  // stored exactly as chosen
  const chosen = page.locator('[data-testid="studio-source"][aria-pressed="true"]');
  const stored = await page.request.get(`/api/assets/${await chosen.getAttribute("data-asset")}`);
  expect(Buffer.from(await stored.body()).equals(front)).toBe(true);
  // what was refused is still listed, with its reason, until the creator clears it
  await expect(page.getByTestId("studio-upload-item")).toHaveCount(1);
  await page.getByTestId("studio-upload-remove").click();
  await expect(page.getByTestId("studio-upload-item")).toHaveCount(0);
  // with pictures to start from, the upload area stays on the screen
  await expect(page.getByTestId("studio-upload-zone")).toContainText("Add reference photos");
  await expect(page.getByTestId("studio-upload-choose")).toBeVisible();
});

test("M: a photo too large for one upload, and one its camera stored turned, are added as copies that say so", async ({
  page,
}) => {
  await page.goto(STUDIO);
  await page.getByTestId("studio-subject").filter({ hasText: "Takumi" }).click();
  await expect(page.getByTestId("studio-source")).toHaveCount(2);
  await expect(page.getByTestId("studio-upload-zone")).toContainText(
    "A photo over 977 KB is added as a smaller copy.",
  );
  // a camera-sized photograph, heavier than one upload can carry on this server
  const heavy = await drawnJpeg(page, 3000, 4000, 8);
  expect(heavy.length).toBeGreaterThan(2_000_000);
  // a portrait photograph the way a phone stores it: 1600 wide in the file, flagged "turn a quarter"
  const turned = withOrientation(await drawnJpeg(page, 1600, 1200, 0), 6);
  expect(readJpegOrientation(turned)).toBe(6);
  expect(readImageSize(turned)).toEqual({ width: 1600, height: 1200 });

  await page.getByTestId("studio-upload-file").setInputFiles([
    { name: "IMG_2041.jpg", mimeType: "image/jpeg", buffer: heavy },
    { name: "IMG_0007.jpg", mimeType: "image/jpeg", buffer: turned },
  ]);
  const items = await listed(page, 2);
  // the list shows what will be SENT, and says it is a copy and why
  await expect(items.nth(0)).toHaveAttribute("data-copy", "too_large");
  await expect(items.nth(0).getByTestId("studio-upload-facts")).toContainText("1536 × 2048 px · JPEG");
  await expect(items.nth(0).getByTestId("studio-upload-copy")).toContainText(
    "is more than one upload can carry here (977 KB). This smaller copy is added instead. Your full-size file (3000 × 4000,",
  );
  await expect(items.nth(1)).toHaveAttribute("data-copy", "turned");
  await expect(items.nth(1).getByTestId("studio-upload-facts")).toContainText("1200 × 1600 px · JPEG");
  await expect(items.nth(1).getByTestId("studio-upload-copy")).toHaveText(
    "Your camera stored this photo turned on its side. This upright copy is added, so every tool sees it the right way up.",
  );
  await page.getByTestId("studio-upload-submit").click();
  const tiles = page.getByTestId("studio-source");
  await expect(tiles).toHaveCount(4, { timeout: 60_000 });
  await expect(page.getByTestId("studio-upload-item")).toHaveCount(0);

  // the smaller copy: it fits, it is a JPEG of the size shown, and the Studio never calls it the original
  const picked = page.locator('[data-testid="studio-source"][aria-pressed="true"]');
  await expect(picked).toHaveCount(1);
  const facts = page.getByTestId("studio-inspection");
  await expect(facts).toContainText("IMG_2041-copy-1536x2048.jpg");
  await expect(page.getByTestId("studio-source-origin")).toHaveText("uploaded copy");
  await facts.locator("summary").click();
  await expect(facts).toContainText(
    "A smaller copy made in the browser when it was added: one upload here could not carry it at full size. The file chosen was IMG_2041.jpg (3000 × 4000,",
  );
  const smallerId = (await picked.getAttribute("data-asset"))!;
  const smaller = Buffer.from(await (await page.request.get(`/api/assets/${smallerId}`)).body());
  expect(smaller.length).toBeLessThanOrEqual(1_000_000);
  expect(readImageSize(smaller)).toEqual({ width: 1536, height: 2048 });

  // the upright copy: no rotation flag left, the pixels themselves are upright (the stored top-left corner of the
  // camera file is the top-RIGHT corner of the picture once it is turned the way the flag says)
  const uprightTile = page.getByRole("button", { name: /^IMG_0007-copy-1200x1600\.jpg/ });
  await uprightTile.click();
  const uprightId = (await uprightTile.getAttribute("data-asset"))!;
  const upright = Buffer.from(await (await page.request.get(`/api/assets/${uprightId}`)).body());
  expect(readJpegOrientation(upright)).toBeNull();
  expect(readImageSize(upright)).toEqual({ width: 1200, height: 1600 });
  const corners = await storedCorners(page, uprightId);
  expect(corners.topRight[0]).toBeGreaterThan(170);
  expect(corners.topRight[2]).toBeLessThan(90);
  expect(corners.topLeft[0]).toBeLessThan(90);
  expect(corners.topLeft[2]).toBeGreaterThan(100);
  await expect(page.getByTestId("studio-inspection").last()).toContainText("uploaded copy");
  await expect(page.getByTestId("studio-source-turned")).toHaveCount(0);
});

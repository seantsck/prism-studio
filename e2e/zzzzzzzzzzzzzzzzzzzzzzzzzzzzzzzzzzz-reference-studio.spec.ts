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
 *   L  The upload area: choose or drop several photos → each is listed with what will be sent → Upload → EVERY one
 *      is a starting image, shown together on the stage and sent together; a file that is not a picture never leaves
 *      the browser
 *   M  A photo too large for one upload, and one its camera stored turned, are added as copies that say so
 *   N  Photos added AFTER a picture was made: the stage opens on them, all selected; a take's own inputs are named as
 *      that take's; Generate (free) sends every selected photo, and the record lists each one
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
  // the navigation is Home, the four areas (Story, Cast, World, Shots), then the specialist pages under More tools
  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("link").first()).toHaveText("Home");
  for (const area of ["Story", "Cast", "World", "Shots"])
    await expect(nav.getByText(area, { exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Import Story" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Shot QA" })).toBeHidden();
  await nav.getByText("More tools").click();
  await expect(nav.getByRole("link", { name: "Shot QA" })).toBeVisible();
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
  // no photo of her yet: the brief opens on her written description, filled from the Bible, ready to make the front
  // view from words alone (which only fills in the brief)
  const describe = page.getByTestId("studio-describe");
  await expect(describe).toContainText("Describe Yumeko");
  await expect(page.getByTestId("studio-describe-text")).toHaveValue(/shoulder-length black hair/);
  await expect(page.getByTestId("studio-describe-about")).toContainText("Lead — heiress");
  await expect(page.getByTestId("studio-describe-save")).toBeDisabled();
  await page.getByTestId("studio-describe-make").click();
  await expect(page.getByTestId("studio-preset-portrait")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("studio-source-none")).toHaveAttribute("aria-pressed", "true");
  // nothing exists yet: the stage says what to do, and nothing has been billed
  await expect(page.getByTestId("studio-empty")).toContainText("No picture of Yumeko yet");
  await expect(page.getByTestId("studio-spent")).toHaveText("Nothing billed for Yumeko yet");
  // Prism suggests a free model first; the paid one is listed, labelled, and never chosen for the creator
  await expect(page.getByTestId("studio-model")).toHaveValue("mock/mock-image-1");
  await expect(page.getByTestId("studio-model").locator(`option[value="${PAID_MODEL}"]`)).toHaveText(
    "GPT Image 2.5 Flare (OpenAI direct) (paid)",
  );
  await priced(page);
  // a test model says what it draws, its button never promises a picture, and the real model is one click away
  await expect(page.getByTestId("studio-estimate")).toHaveText(
    "No charge: a test model. It draws a coloured pattern, not a real picture.",
  );
  await expect(page.getByTestId("studio-generate")).toHaveText("Generate test pattern");
  await expect(page.getByTestId("studio-use-real-model")).toHaveText(
    "use GPT Image 2.5 Flare (OpenAI direct)",
  );
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
  await expect(page.getByTestId("studio-surface")).toHaveAttribute("data-view", "start");
  await expect(page.getByTestId("studio-starting")).toBeVisible();
  // and the Studio says that more than one picture can be a starting image
  await expect(page.getByTestId("studio-selection")).toHaveText(
    "1 picture selected. Click more pictures to send them together.",
  );
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
  // the image that will be sent is pictured beside the button that sends it
  await expect(page.getByTestId("studio-sent-strip")).toHaveAttribute("data-count", "1");
  await expect(page.getByTestId("studio-sent-strip").locator("img")).toHaveAttribute(
    "src",
    `/api/assets/${photoId}`,
  );
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
  await expect(generate).toHaveText("Generate test pattern");
  await expect(generate).toHaveAttribute("data-paid", "false");
  await generate.click();
  await finished(page, 1);
  const take = page.getByTestId("studio-take");
  await expect(take.locator("h2")).toHaveText("#1 3/4 view");
  // a generated picture is never presented as a photograph, a test model's pattern is never presented as a real
  // picture, and a free model is never shown as money spent
  await expect(page.getByTestId("studio-kind-note")).toHaveText("Generated reference, not a photograph");
  await expect(page.getByTestId("studio-test-take")).toHaveText("Test pattern, not a real picture");
  await expect(page.getByTestId("studio-cost")).toHaveText("No charge");
  await expect(page.getByTestId("studio-spent")).toHaveText("Nothing billed for Yumeko yet");
  await expect(page.getByTestId("studio-result")).toBeVisible();
  // the stage shows what THIS take was made from (named as the take's, not as what comes next), and the record
  // says so too
  await expect(page.getByTestId("studio-surface")).toHaveAttribute("data-view", "take");
  await expect(page.getByTestId("studio-inputs")).toContainText("Take #1 was made from");
  await expect(page.getByTestId("studio-inputs").locator("img")).toHaveAttribute(
    "src",
    `/api/assets/${photoId}`,
  );
  await page.getByTestId("studio-provenance").locator("summary").click();
  await expect(page.getByTestId("studio-provenance")).toContainText("1 image: yumeko-front.png.");
  // the result joins the starting images, marked as generated, and as the test pattern it is
  const tiles = page.getByTestId("studio-source");
  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(1)).toHaveAttribute("data-origin", "generated");
  await expect(tiles.nth(1)).toContainText("test pattern");
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
  await expect(page.getByTestId("studio-generate")).toHaveText("Generate test pattern");
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
  // from the test model, the real one is one click away; choosing it starts nothing
  await page.getByTestId("studio-use-real-model").click();
  await expect(page.getByTestId("studio-model")).toHaveValue(PAID_MODEL);
  await expect(page.getByTestId("studio-test-model")).toHaveCount(0);
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
  // a second starting image is sent WITH the first, and the price says so before anything is made
  const second = page.getByTestId("studio-source").nth(1);
  await second.click();
  await expect(page.getByTestId("studio-selection")).toHaveText(
    "2 pictures selected. They are sent together, as views of the same person.",
  );
  await expect(page.getByTestId("studio-sent").locator("summary")).toContainText("Sends 2 images", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("studio-sent-strip")).toHaveAttribute("data-count", "2");
  const two = Number((await estimate.innerText()).replace("Up to $", ""));
  expect(two).toBeGreaterThan(medium);
  await expect(generate).toHaveText(`Generate · up to $${two}`);
  await expect(page.getByTestId("studio-basis")).toContainText("the 2 images sent with it");
  await second.click();
  await expect(page.getByTestId("studio-sent").locator("summary")).toContainText("Sends 1 image", {
    timeout: 20_000,
  });
  await expect(generate).toHaveText(`Generate · up to $${medium}`);
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
  // the creator's choice of model is remembered: after a reload, and for the next Character too, so the next
  // Generate does not quietly go back to drawing a test pattern. The price is still on the button every time.
  await expect(page.getByTestId("studio-model")).toHaveValue(PAID_MODEL);
  await page.getByTestId("studio-subject").filter({ hasText: "Sean" }).click();
  await expect(page.getByTestId("reference-studio")).toHaveAttribute("data-subject", /^character:/);
  await expect(page.getByTestId("studio-subject").filter({ hasText: "Sean" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("studio-model")).toHaveValue(PAID_MODEL);
  await priced(page);
  await expect(page.getByTestId("studio-generate")).toHaveText(/^Generate · up to \$0\.\d+$/);
  await expect(page.getByTestId("studio-take-thumb")).toHaveCount(0);
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
  await expect(page.getByTestId("studio-inputs")).toContainText(`Take #${takes + 1} was cut out of`);
  await expect(page.getByTestId("studio-inputs")).toContainText("The original");
  await page.getByTestId("studio-use-cutout").click();
  await expect(page.getByTestId("studio-take")).toContainText("Cutout", { timeout: 30_000 });
  await expect(page.getByTestId("studio-use-cutout")).toBeDisabled();
});

test("L: the upload area takes several photos at once, chosen or dropped; every one becomes a starting image, sent together", async ({
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
  // EVERY photo of the batch is a starting image (they were added to be used), numbered in the order it is sent
  const selected = page.locator('[data-testid="studio-source"][aria-pressed="true"]');
  await expect(selected).toHaveCount(2);
  await expect(page.getByTestId("studio-selection")).toHaveText(
    "2 pictures selected. They are sent together, as views of the same person.",
  );
  // the stage shows them all, at a size they can be checked at
  await expect(page.getByTestId("studio-surface")).toHaveAttribute("data-view", "start");
  await expect(page.getByTestId("studio-starting-set")).toHaveAttribute("data-count", "2");
  await expect(page.getByTestId("studio-starting")).toHaveCount(2);
  await expect(page.getByTestId("studio-starting-note")).toHaveText(
    "Your 2 starting images, sent together as views of the same person. Choose what to make from them, then Generate.",
  );
  // each has its own line of facts
  const facts = page.getByTestId("studio-inspection");
  await expect(facts).toHaveCount(2);
  await expect(facts.nth(0)).toContainText("takumi-front.png");
  await expect(facts.nth(0).getByTestId("studio-source-origin")).toHaveText("uploaded original");
  await expect(facts.nth(1)).toContainText("takumi-side.png");
  await expect(facts.nth(1)).toContainText("600 × 800 px");
  // and the request sends both: the count, the pictures beside the button and the prompt all agree
  await priced(page);
  const sent = page.getByTestId("studio-sent");
  await expect(sent.locator("summary")).toContainText("Sends 2 images");
  await expect(page.getByTestId("studio-sent-strip")).toHaveAttribute("data-count", "2");
  await sent.locator("summary").click();
  await expect(page.getByTestId("studio-prompt")).toContainText(
    "The same person as in the identity reference images",
  );
  await expect(page.getByTestId("studio-prompt")).toContainText("the reference images win where they differ");
  await sent.locator("summary").click();
  // stored exactly as chosen
  const frontTile = page.getByRole("button", { name: /^takumi-front\.png/ });
  const stored = await page.request.get(`/api/assets/${await frontTile.getAttribute("data-asset")}`);
  expect(Buffer.from(await stored.body()).equals(front)).toBe(true);
  // taking one out is one click, and so is putting every photo back
  await page.getByRole("button", { name: /^takumi-side\.png/ }).click();
  await expect(selected).toHaveCount(1);
  await expect(page.getByTestId("studio-selection")).toContainText(
    "1 picture selected. Click more pictures to send them together.",
  );
  await expect(page.getByTestId("studio-starting")).toHaveCount(1);
  await expect(sent.locator("summary")).toContainText("Sends 1 image", { timeout: 20_000 });
  await page.getByTestId("studio-select-photos").click();
  await expect(selected).toHaveCount(2);
  await expect(page.getByTestId("studio-select-photos")).toHaveCount(0);
  await expect(sent.locator("summary")).toContainText("Sends 2 images", { timeout: 20_000 });
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

  // both copies join the two photos already selected: four starting images, all on the stage
  await expect(page.locator('[data-testid="studio-source"][aria-pressed="true"]')).toHaveCount(4);
  await expect(page.getByTestId("studio-selection")).toHaveAttribute("data-count", "4");
  await expect(page.getByTestId("studio-starting-set")).toHaveAttribute("data-count", "4");
  await expect(page.getByTestId("studio-starting")).toHaveCount(4);
  const factsOf = (assetId: string) =>
    page.locator(`[data-testid="studio-inspection"][data-asset="${assetId}"]`);

  // the smaller copy: it fits, it is a JPEG of the size shown, and the Studio never calls it the original
  const smallerTile = page.getByRole("button", { name: /^IMG_2041-copy-1536x2048\.jpg/ });
  await expect(smallerTile).toHaveAttribute("aria-pressed", "true");
  const smallerId = (await smallerTile.getAttribute("data-asset"))!;
  const facts = factsOf(smallerId);
  await expect(facts).toContainText("IMG_2041-copy-1536x2048.jpg");
  await expect(facts.getByTestId("studio-source-origin")).toHaveText("uploaded copy");
  await facts.locator("summary").click();
  await expect(facts).toContainText(
    "A smaller copy made in the browser when it was added: one upload here could not carry it at full size. The file chosen was IMG_2041.jpg (3000 × 4000,",
  );
  const smaller = Buffer.from(await (await page.request.get(`/api/assets/${smallerId}`)).body());
  expect(smaller.length).toBeLessThanOrEqual(1_000_000);
  expect(readImageSize(smaller)).toEqual({ width: 1536, height: 2048 });

  // the upright copy: no rotation flag left, the pixels themselves are upright (the stored top-left corner of the
  // camera file is the top-RIGHT corner of the picture once it is turned the way the flag says)
  const uprightTile = page.getByRole("button", { name: /^IMG_0007-copy-1200x1600\.jpg/ });
  await expect(uprightTile).toHaveAttribute("aria-pressed", "true");
  const uprightId = (await uprightTile.getAttribute("data-asset"))!;
  const upright = Buffer.from(await (await page.request.get(`/api/assets/${uprightId}`)).body());
  expect(readJpegOrientation(upright)).toBeNull();
  expect(readImageSize(upright)).toEqual({ width: 1200, height: 1600 });
  const corners = await storedCorners(page, uprightId);
  expect(corners.topRight[0]).toBeGreaterThan(170);
  expect(corners.topRight[2]).toBeLessThan(90);
  expect(corners.topLeft[0]).toBeLessThan(90);
  expect(corners.topLeft[2]).toBeGreaterThan(100);
  await expect(factsOf(uprightId).getByTestId("studio-source-origin")).toHaveText("uploaded copy");
  await expect(page.getByTestId("studio-source-turned")).toHaveCount(0);
});

test("N: photos added after a picture was made open the stage, all selected; Generate sends every one of them", async ({
  page,
}) => {
  await openYumeko(page);
  const surface = page.getByTestId("studio-surface");
  const selected = page.locator('[data-testid="studio-source"][aria-pressed="true"]');
  const sent = page.getByTestId("studio-sent").locator("summary");
  // her one photograph is older than her newest picture, so the Studio opens on that picture; the photograph, not a
  // generated picture, is what the next one starts from
  await expect(surface).toHaveAttribute("data-view", "take");
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAttribute("data-origin", "uploaded");
  const takes = await page.getByTestId("studio-take-thumb").count();
  const tiles = await page.getByTestId("studio-source").count();
  // what the next picture starts from can be put on the stage without changing the selection, and the picture she
  // was looking at is one click away again
  await expect(page.getByTestId("studio-show-start")).toHaveText("Show it large");
  await page.getByTestId("studio-show-start").click();
  await expect(surface).toHaveAttribute("data-view", "start");
  await expect(page.getByTestId("studio-starting")).toHaveCount(1);
  await expect(page.getByTestId("studio-show-start")).toHaveCount(0);
  await expect(selected).toHaveCount(1);
  await page.getByTestId("studio-back-to-take").click();
  await expect(surface).toHaveAttribute("data-view", "take");

  // two more photographs, dropped on the page: a side view, and one in the shape of a full phone screenshot
  await dropFiles(page, "studio-surface", [
    { name: "yumeko-side.png", mimeType: "image/png", buffer: Buffer.from(portraitFixturePng(600, 800)) },
    {
      name: "Screenshot_yumeko.png",
      mimeType: "image/png",
      buffer: Buffer.from(portraitFixturePng(540, 1200)),
    },
  ]);
  await listed(page, 2);
  await page.getByTestId("studio-upload-submit").click();
  await expect(page.getByTestId("studio-source")).toHaveCount(tiles + 2, { timeout: 30_000 });
  // all three of her photographs are starting images now, and the stage shows them instead of the older picture
  await expect(selected).toHaveCount(3);
  for (const tile of await selected.all()) await expect(tile).toHaveAttribute("data-origin", "uploaded");
  await expect(page.getByTestId("studio-selection")).toHaveText(
    "3 pictures selected. They are sent together, as views of the same person.",
  );
  await expect(surface).toHaveAttribute("data-view", "start");
  await expect(page.getByTestId("studio-starting-set")).toHaveAttribute("data-count", "3");
  await expect(page.getByTestId("studio-starting")).toHaveCount(3);
  await expect(page.getByTestId("studio-take")).toHaveCount(0);
  // the very long one is flagged, in words the creator can act on
  await expect(page.getByTestId("studio-source-elongated")).toHaveText(
    "A very long shape (a full phone screenshot?). If the person is small in the frame, or the picture shows anything else, crop it first.",
  );
  await priced(page);
  await expect(sent).toContainText("Sends 3 images");
  await expect(page.getByTestId("studio-sent-strip")).toHaveAttribute("data-count", "3");

  // a fresh visit opens on the photographs too: nothing has been made since they were added
  await page.reload();
  await expect(surface).toHaveAttribute("data-view", "start");
  await expect(selected).toHaveCount(3);
  await expect(page.getByTestId("studio-starting")).toHaveCount(3);
  // the picture she was looking at is one click away
  await page.getByTestId("studio-back-to-take").click();
  await expect(surface).toHaveAttribute("data-view", "take");
  await expect(page.getByTestId("studio-take")).toBeVisible();
  await expect(page.getByTestId("studio-back-to-take")).toHaveCount(0);
  // and choosing among the starting images brings them back to the stage
  await page.getByRole("button", { name: /^yumeko-side\.png/ }).click();
  await expect(surface).toHaveAttribute("data-view", "start");
  await expect(page.getByTestId("studio-starting")).toHaveCount(2);
  await page.getByTestId("studio-select-photos").click();
  await expect(selected).toHaveCount(3);
  await expect(page.getByTestId("studio-starting")).toHaveCount(3);

  // Generate with the free test model: the take was made from all three, in the order they were numbered
  await page.getByTestId("studio-preset-three_quarter").click();
  await priced(page);
  await expect(sent).toContainText("Sends 3 images");
  await page.getByTestId("studio-generate").click();
  await finished(page, takes + 1);
  await expect(surface).toHaveAttribute("data-view", "take");
  const inputs = page.getByTestId("studio-inputs");
  await expect(inputs).toContainText(`Take #${takes + 1} was made from 3 images`);
  await expect(inputs.locator("img")).toHaveCount(3);
  await page.getByTestId("studio-provenance").locator("summary").click();
  await expect(page.getByTestId("studio-provenance")).toContainText(
    "3 images: yumeko-front.png; Screenshot_yumeko.png; yumeko-side.png.",
  );
  await expect(page.getByTestId("studio-cost")).toHaveText("No charge");
  // now the newest picture is newer than every photograph: a fresh visit opens on it, with the photographs still
  // the starting images
  await page.reload();
  await expect(surface).toHaveAttribute("data-view", "take");
  await expect(page.getByTestId("studio-take").locator("h2")).toHaveText(`#${takes + 1} 3/4 view`);
  await expect(selected).toHaveCount(3);
  await expect(page.getByTestId("studio-spent")).toHaveText("Nothing billed for Yumeko yet");
});

test("O: the reference set: what is in each view, Make it for an empty one, and one click to add a take or a photo", async ({
  page,
}) => {
  await openYumeko(page);
  const set = page.getByTestId("studio-reference-set");
  const view = (id: string) => set.locator(`[data-testid="studio-set-view"][data-view="${id}"]`);
  await expect(set).toContainText("Yumeko's reference set");
  // story E put take #1 into the 3/4 slot; the seeded front and profile slots hold no image
  await expect(view("three_quarter")).toHaveAttribute("data-filled", "true");
  await expect(view("three_quarter")).toContainText("take #1");
  await expect(view("profile")).toHaveAttribute("data-filled", "false");
  await expect(page.getByTestId("studio-set-count")).toHaveText("(1 of 6 views)");
  await set.locator("summary").click();
  await expect(page.getByTestId("studio-set-guidance")).toContainText("4 to 8 good ones");
  // her Look's picture is a slot of the same panel; the seeded Look is locked, and says where to unlock it
  const look = set.getByTestId("studio-set-look");
  await expect(look).toHaveCount(1);
  await expect(look).toContainText("Episode 1");
  await expect(look).toContainText("Locked.");
  await expect(look.getByRole("link", { name: "Unlock" })).toHaveAttribute("href", /\/characters\//);

  // an empty view: Make it fills in the brief (nothing is made until Generate)
  const takes = await page.getByTestId("studio-take-thumb").count();
  await view("profile").getByTestId("studio-set-make").click();
  await expect(page.getByTestId("studio-preset-profile_left")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("studio-take-thumb")).toHaveCount(takes);
  await priced(page);
  await page.getByTestId("studio-generate").click();
  await finished(page, takes + 1);

  // the take suggests the view it was made for; one click puts it there
  const onTake = page.getByTestId("studio-use");
  const add = onTake.getByTestId("studio-add-to-set-submit");
  await expect(onTake.getByTestId("studio-set-choice")).toHaveValue("profile");
  await expect(add).toHaveText("Add to the set as left profile");
  await add.click();
  await expect(view("profile")).toHaveAttribute("data-filled", "true", { timeout: 30_000 });
  await expect(view("profile")).toContainText(`take #${takes + 1}`);
  await expect(add).toHaveText("In the set as left profile");
  await expect(page.getByTestId("studio-set-count")).toHaveText("(2 of 6 views)");

  // the creator's own photo as the front, which is the canonical identity
  // (all three of her photos are starting images: each has a line of facts that opens to its details)
  await expect(page.getByRole("button", { name: /^yumeko-front\.png/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const facts = page.locator('[data-testid="studio-inspection"]').filter({ hasText: "yumeko-front.png" });
  await facts.locator("summary").first().click();
  const photoControl = facts.getByTestId("studio-add-to-set");
  await photoControl.getByTestId("studio-set-choice").selectOption("front");
  await expect(photoControl.getByTestId("studio-add-to-set-submit")).toHaveText("Add to the set as front");
  await photoControl.getByTestId("studio-add-to-set-submit").click();
  await expect(view("front")).toHaveAttribute("data-filled", "true", { timeout: 30_000 });
  await expect(view("front")).toContainText("your photo");
  await expect(view("front")).toContainText("canonical");
  await expect(page.getByTestId("studio-set-count")).toHaveText("(3 of 6 views)");

  // Choose on a view: pick any picture of hers
  await view("half_body").getByTestId("studio-set-choose").click();
  const picker = page.getByTestId("studio-set-picker");
  await expect(picker).toContainText("Choose the half body");
  await picker.locator('[data-testid="studio-set-pick"]').first().click();
  await expect(view("half_body")).toHaveAttribute("data-filled", "true", { timeout: 30_000 });
  await expect(view("half_body").getByTestId("studio-set-message")).toHaveText("Added");
  await expect(picker).toHaveCount(0);

  // drag a take onto a view
  const thumb = page.getByTestId("studio-take-thumb").first();
  await thumb.dragTo(view("full_body"));
  await expect(view("full_body")).toHaveAttribute("data-filled", "true", { timeout: 30_000 });
  await expect(view("full_body")).toContainText("take #");
  await expect(page.getByTestId("studio-set-count")).toHaveText("(5 of 6 views)");

  // dropping onto a filled view replaces it (the drop is the explicit act); the old picture stays in the library
  // (the tile is at the top of the page and the view far below it: the drop is dispatched the way a browser does)
  const before = await view("profile").locator("img").getAttribute("src");
  const photoId = (await page.getByTestId("studio-source").first().getAttribute("data-asset"))!;
  const dataTransfer = await page.evaluateHandle((assetId) => {
    const dt = new DataTransfer();
    dt.setData("application/x-prism-picture", JSON.stringify({ assetId, attemptId: null }));
    return dt;
  }, photoId);
  await view("profile").dispatchEvent("dragover", { dataTransfer });
  await view("profile").dispatchEvent("drop", { dataTransfer });
  await expect(view("profile").getByTestId("studio-set-message")).toHaveText("Replaced", { timeout: 30_000 });
  await expect(view("profile").locator("img")).not.toHaveAttribute("src", before!);
  const old = await page.request.get(before!);
  expect(old.ok()).toBe(true);
});

test("P: the Production checklist lists what each person, outfit, place and Shot still needs, with the button for each", async ({
  page,
}) => {
  await page.goto(P);
  // Home: the four areas, each with where it stands and the one next thing
  const areas = page.getByTestId("home-area");
  await expect(areas).toHaveCount(4);
  await expect(page.locator('[data-testid="home-area"][data-area="cast"]')).toContainText("Yumeko");
  await expect(page.locator('[data-testid="home-area"][data-area="world"]')).toContainText("places pictured");
  await expect(page.getByTestId("home-next")).toContainText("Next steps");
  // and the full list, one click away
  await page
    .getByTestId("home-next")
    .getByRole("link", { name: /^All \d+$/ })
    .click();
  await expect(page.getByRole("heading", { name: "Production checklist" })).toBeVisible();
  const next = page.getByTestId("checklist-next");
  await expect(next).toContainText("Next steps for");
  const steps = page.getByTestId("checklist-step");
  expect(await steps.count()).toBeGreaterThan(0);
  // every person in the Episode's Shots, with their photos and views
  const yumeko = page.getByTestId("checklist-person").filter({ hasText: "Yumeko" });
  await expect(yumeko).toContainText("photos of their own");
  await expect(yumeko).toContainText("Front");
  // every Shot has a light
  const shots = page.getByTestId("checklist-shot");
  expect(await shots.count()).toBeGreaterThan(5);
  for (const light of await shots.evaluateAll((els) => els.map((e) => e.getAttribute("data-light"))))
    expect(["ready", "partial", "blocked"]).toContain(light);
  // a person step opens the Studio on that person, already set up
  const sean = steps.filter({ hasText: "Add photos of Sean (1 of 4)" });
  await expect(sean).toHaveCount(1);
  await sean.getByTestId("checklist-step-go").click();
  await expect(page.getByTestId("reference-studio")).toHaveAttribute("data-subject", /^character:/);
  await expect(page.getByTestId("studio-subject").filter({ hasText: "Sean" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("Q: a series from a prompt: the season planned, edited and refined without reloading, then every episode written (free here)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  const premise =
    "A shy sushi apprentice in Osaka secretly enters a televised cooking contest under a false name.";
  await page.getByTestId("new-project-premise").fill(premise);
  // the count can be typed (any number, up to 500); the shortcuts set it too
  await page.getByTestId("new-series-episodes-input").fill("120");
  await expect(page.getByTestId("new-series-episodes-input")).toHaveValue("120");
  await page.getByTestId("new-series-episodes-6").click();
  await expect(page.getByTestId("new-series-episodes-input")).toHaveValue("6");
  // the title is the creator's own, in the box itself
  await page.getByTestId("new-series-title").fill("Night Counter");
  await page.getByTestId("new-series-create").click();
  await expect(page).toHaveURL(/\/projects\/night-counter\/start$/);
  await expect(page.getByRole("heading", { name: "Start your series" })).toBeVisible();
  await expect(page.getByTestId("start-premise")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("start-premise-text")).toHaveText(premise);
  await expect(page.getByTestId("start-plan")).toHaveAttribute("data-state", "now");
  await expect(page.getByTestId("start-plan")).toContainText("Plan the season (6 episodes)");
  await expect(page.getByTestId("start-write")).toHaveAttribute("data-state", "later");
  await expect(page.getByRole("navigation").getByRole("link", { name: "Start from a prompt" })).toBeVisible();
  // the plan can be written by hand from the start
  await expect(page.getByTestId("start-plan-editor")).toHaveAttribute("data-source", "episodes");

  // plan the season: the price is on the button; Prism's plan arrives in the editor on its own (no reload)
  const planGo = page.getByTestId("start-plan-go");
  await expect(planGo).toHaveText(/^Plan 6 episodes with Prism · free with /);
  await planGo.click();
  const editor = page.getByTestId("start-plan-editor");
  await expect(editor).toHaveAttribute("data-source", "prism", { timeout: 30_000 });
  await expect(editor.getByTestId("start-plan-draft-note")).toContainText("Prism's plan.");
  await expect(editor.getByTestId("start-plan-episode")).toHaveCount(6);
  await expect(editor.getByLabel("What happens in episode 1")).not.toHaveValue("");
  // edit Prism's plan before using it
  await editor.getByLabel("Episode 2 title").fill("The Tasting");
  await editor.getByLabel("What happens in episode 2").fill("He cooks for the judges under his false name.");
  await editor.getByTestId("start-plan-save").click();
  await expect(page.getByTestId("start-plan")).toHaveAttribute("data-state", "done", { timeout: 30_000 });
  await expect(editor).toHaveAttribute("data-source", "episodes");
  await page.reload();
  await expect(page.getByTestId("start-plan-editor").getByLabel("Episode 2 title")).toHaveValue(
    "The Tasting",
  );

  // refine: an unsaved edit is saved with it; Prism's revision arrives on its own; "Keep my plan" sets it aside
  await editor.getByLabel("Episode 3 title").fill("The Rival");
  const refine = editor.getByTestId("start-plan-refine");
  await expect(refine.getByTestId("start-plan-refine-go")).toHaveText(/^Save and refine · free with /);
  await refine.getByTestId("start-plan-note").fill("Raise the stakes in the middle of the season.");
  await refine.getByTestId("start-plan-refine-go").click();
  await expect(editor).toHaveAttribute("data-source", "prism", { timeout: 30_000 });
  await expect(editor.getByTestId("start-plan-draft-note")).toContainText("Prism's revised plan.");
  await editor.getByTestId("start-plan-keep").click();
  await expect(editor).toHaveAttribute("data-source", "episodes", { timeout: 30_000 });
  await expect(editor.getByLabel("Episode 2 title")).toHaveValue("The Tasting");
  await expect(editor.getByLabel("Episode 3 title")).toHaveValue("The Rival");
  // each episode's length: one value for all, then one changed by hand
  await editor.getByTestId("start-plan-all-minutes-input").fill("24");
  await editor.getByTestId("start-plan-all-minutes-go").click();
  await expect(editor.getByLabel("Episode 6 length in minutes")).toHaveValue("24");
  await editor.getByLabel("Episode 3 length in minutes").fill("45");
  await editor.getByTestId("start-plan-save").click();
  await expect(page.getByTestId("start-write")).toContainText("45 min", { timeout: 30_000 });
  await page.reload();
  await expect(page.getByTestId("start-plan-editor").getByLabel("Episode 3 length in minutes")).toHaveValue(
    "45",
  );

  // write all 6: the writer and the episodes are chosen (every one is ticked to start with), then a confirmation
  // names the price before anything runs
  const write = page.getByTestId("write-it");
  await expect(write.locator('[data-testid="write-it-writer"][data-value="recommended"]')).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const boxes = write.getByTestId("write-it-episode");
  await expect(boxes).toHaveCount(6);
  await write.getByTestId("write-it-none").click();
  await expect(write.getByTestId("write-it-open")).toBeDisabled();
  await boxes.nth(1).check();
  await boxes.nth(3).check();
  await expect(write.getByTestId("write-it-open")).toHaveText("Write 2 episodes…");
  await write.getByTestId("write-it-all").click();
  await expect(write.getByTestId("write-it-open")).toHaveText("Write all 6 episodes…");
  await expect(write.getByTestId("write-it-price")).toHaveText(/^free with /);
  await write.getByTestId("write-it-open").click();
  const confirm = page.getByTestId("write-it-confirm");
  await expect(confirm).toContainText("Write all 6 episodes?");
  await expect(confirm).toContainText("Nothing goes into a script until you accept it.");
  await confirm.getByTestId("write-it-confirm-go").click();
  await expect(page.getByTestId("start-writing-row")).toHaveCount(6, { timeout: 30_000 });
  // each episode becomes ready to review on its own Write page
  await expect(async () => {
    await page.reload();
    await expect(page.locator('[data-testid="start-writing-row"][data-state="ready"]')).toHaveCount(6, {
      timeout: 1000,
    });
  }).toPass({ timeout: 60_000 });
  await page.getByTestId("start-writing-review").first().click();
  await expect(page).toHaveURL(/\/projects\/night-counter\/episodes\/ep-1\/write\?session=/);
});

test("R: a take is archived out of the Studio and restored (delete offered); a set view is refused", async ({
  page,
}) => {
  await openYumeko(page);
  // a fresh take (free test model), then Archive on it
  const takes = await page.getByTestId("studio-take-thumb").count();
  await priced(page);
  await page.getByTestId("studio-generate").click();
  await finished(page, takes + 1);
  const take = page.getByTestId("studio-take");
  const attempt = await take.getAttribute("data-attempt");
  await take.getByTestId("studio-archive").click();
  await expect(page.locator(`[data-testid="studio-take-thumb"][data-attempt="${attempt}"]`)).toHaveCount(0, {
    timeout: 30_000,
  });
  const archived = page.getByTestId("studio-archived");
  await expect(archived.locator("summary")).toHaveText(/^Archived \(\d+\)$/);
  await archived.locator("summary").click();
  const item = archived.getByTestId("studio-archived-item").filter({ hasText: `Take #${takes + 1}` });
  // nothing depends on it: it can be deleted (to the Trash); here it is restored instead
  await expect(item.getByTestId("studio-delete")).toBeVisible();
  // Restore puts it back among the takes
  await item.getByTestId("studio-restore").click();
  await expect(page.locator(`[data-testid="studio-take-thumb"][data-attempt="${attempt}"]`)).toHaveCount(1, {
    timeout: 30_000,
  });

  // a picture that is a view of the reference set (the left profile, a take since story O) is refused with what to
  // change first, and stays where it is
  const profile = page.locator('[data-testid="studio-set-view"][data-view="profile"]');
  await expect(profile).toHaveAttribute("data-filled", "true");
  const inSet = await profile.getAttribute("data-asset");
  // from its Start from tile: selected alone, its card offers Archive too
  await page.getByTestId("studio-source-none").click();
  await choose(page.locator(`[data-testid="studio-source"][data-asset="${inSet}"]`));
  await page
    .locator(`[data-testid="studio-inspection"][data-asset="${inSet}"]`)
    .getByTestId("studio-archive")
    .click();
  await expect(page.getByText(/take it out of the reference set first/)).toBeVisible();
  await expect(profile).toHaveAttribute("data-asset", inSet!);
});

test("S: Archive is in view on every selected photo, and a Character's page lists every picture with Archive", async ({
  page,
}) => {
  await openYumeko(page);
  // several of the creator's photos selected: each line keeps its Archive in view (not folded away)
  const photos = page.locator('[data-testid="studio-source"][data-origin="uploaded"]');
  expect(await photos.count()).toBeGreaterThan(1);
  for (const i of [0, 1]) await choose(photos.nth(i));
  const lines = page.getByTestId("studio-inspection");
  expect(await lines.count()).toBeGreaterThan(1);
  for (const line of await lines.all()) await expect(line.getByTestId("studio-archive")).toBeVisible();

  // the Character page: every picture, each with Archive, and the archive under them
  await page.goto(`${P}/characters`);
  await page.getByRole("main").getByRole("link", { name: "Yumeko" }).first().click();
  await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: "Yumeko", level: 1 })).toBeVisible();
  const panel = page.getByTestId("character-pictures");
  const pictures = panel.getByTestId("character-picture");
  await expect(pictures.first()).toBeVisible();
  const before = await pictures.count();
  expect(before).toBeGreaterThan(0);
  for (const p of await pictures.all()) await expect(p.getByTestId("studio-archive")).toBeVisible();
  // a take that has no job: archive it here, find it in Archived, restore it
  const free = pictures.filter({ hasText: "generated reference" }).first();
  const asset = await free.getAttribute("data-asset");
  await free.getByTestId("studio-archive").click();
  await expect(panel.locator(`[data-testid="character-picture"][data-asset="${asset}"]`)).toHaveCount(0, {
    timeout: 30_000,
  });
  await panel.getByTestId("studio-archived").locator("summary").click();
  const item = panel.locator(`[data-testid="studio-archived-item"][data-asset="${asset}"]`);
  await item.getByTestId("studio-restore").click();
  await expect(pictures).toHaveCount(before, { timeout: 30_000 });
});

test("T: on the Projects page a project is archived, restored, and deleted only once its title is typed", async ({
  page,
}) => {
  await page.goto("/");
  // a title alone (no idea yet) makes an empty project, as before
  await page.getByTestId("new-series-more").locator("summary").click();
  await page.getByTestId("new-series-title").fill("Throwaway Pilot");
  await page.getByTestId("new-series-create").click();
  await expect(page).toHaveURL(/\/projects\/throwaway-pilot$/);
  await page.goto("/");
  const row = page.locator('[data-testid="project-row"][data-slug="throwaway-pilot"]');
  await expect(row).toHaveCount(1);

  // archive: it leaves the list and waits under Archived; Restore brings it back
  await row.getByTestId("project-archive").click();
  const archived = page.getByTestId("projects-archived");
  await expect(archived).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('[data-testid="project-row"][data-slug="throwaway-pilot"]:not([data-archived])'),
  ).toHaveCount(0);
  await archived.locator("summary").click();
  await archived.locator('[data-slug="throwaway-pilot"]').getByTestId("project-restore").click();
  await expect(
    page.locator('[data-testid="project-row"][data-slug="throwaway-pilot"]:not([data-archived])'),
  ).toHaveCount(1, {
    timeout: 30_000,
  });

  // delete: a confirmation, then the project goes to the Trash (out of the list, can't be opened)
  const live = page.locator('[data-testid="project-row"][data-slug="throwaway-pilot"]');
  await live.getByTestId("project-delete-open").click();
  const confirm = live.getByTestId("project-delete-confirm");
  await expect(confirm).toContainText("restore it for 30 days");
  await confirm.getByTestId("project-delete").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('[data-testid="project-row"][data-slug="throwaway-pilot"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  await page.goto("/projects/throwaway-pilot");
  await expect(page.getByText(/not found|could not be found|404/i).first()).toBeVisible();

  // the Trash on the Projects page: Restore brings it back whole
  await page.goto("/");
  const trash = page.getByTestId("projects-trash");
  await trash.locator("summary").click();
  const trashed = trash.locator('[data-testid="project-trash-row"][data-slug="throwaway-pilot"]');
  await expect(trashed).toContainText("30 days left");
  await trashed.getByTestId("project-trash-restore").click();
  await expect(page.locator('[data-testid="project-row"][data-slug="throwaway-pilot"]')).toHaveCount(1, {
    timeout: 30_000,
  });

  // delete again, then for good from the Trash: the button stays off until the exact title is typed
  await page
    .locator('[data-testid="project-row"][data-slug="throwaway-pilot"]')
    .getByTestId("project-delete-open")
    .click();
  await page.getByTestId("project-delete").click();
  await expect(page.getByTestId("projects-trash")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("projects-trash").locator("summary").click();
  const again = page.locator('[data-testid="project-trash-row"][data-slug="throwaway-pilot"]');
  await again.getByTestId("project-trash-delete-open").click();
  const forGood = again.getByTestId("project-trash-delete-confirm");
  await expect(forGood).toContainText("can't be undone");
  const go = forGood.getByTestId("project-trash-delete");
  await expect(go).toBeDisabled();
  await forGood.getByTestId("project-trash-delete-title").fill("Throwaway");
  await expect(go).toBeDisabled();
  await forGood.getByTestId("project-trash-delete-title").fill("Throwaway Pilot");
  await go.click();
  await expect(page.locator('[data-testid="project-trash-row"][data-slug="throwaway-pilot"]')).toHaveCount(
    0,
    {
      timeout: 30_000,
    },
  );
  // the demo project is untouched
  await expect(page.locator('[data-testid="project-row"][data-slug="ojousama"]')).toHaveCount(1);
});

test("U: a film from the Projects page: written whole, with the writer and the price confirmed first (free here)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What's your series about?" })).toBeVisible();
  const create = page.getByTestId("new-series-create");
  await expect(create).toBeDisabled();
  // an idea fills the box; it can be edited
  await page.getByTestId("new-series-idea").first().click();
  const premise = page.getByTestId("new-project-premise");
  await expect(premise).not.toHaveValue("");
  await premise.fill("A night-shift paramedic keeps getting calls from a number disconnected years ago.");
  await page.getByTestId("new-series-type-film").click();
  await expect(page.getByTestId("new-series-type-film")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("new-series-episodes-8")).toHaveCount(0); // a film is one screenplay
  await expect(create).toHaveText("Create");
  await create.click();
  // titled from the idea; a film has no season to plan: straight to writing it
  await expect(page).toHaveURL(/\/projects\/a-night-shift-paramedic-keeps-getting-calls[^/]*\/start$/);
  await expect(page.getByRole("heading", { name: "Start your film" })).toBeVisible();
  await expect(page.getByTestId("start-plan")).toHaveCount(0);
  await expect(page.getByTestId("start-write")).toHaveAttribute("data-state", "now");
  const write = page.getByTestId("write-it");
  await expect(write.getByTestId("write-it-episodes")).toHaveCount(0);
  // its length, set before it is written
  await page.getByTestId("start-runtime-input").fill("90");
  await page.getByTestId("start-runtime-save").click();
  await expect(page.getByTestId("start-runtime")).toContainText("Length saved", { timeout: 30_000 });
  await page.reload();
  await expect(page.getByTestId("start-runtime-input")).toHaveValue("90");
  await write.getByTestId("write-it-open").click();
  const confirm = page.getByTestId("write-it-confirm");
  await expect(confirm).toContainText("Write the whole film?");
  await expect(confirm.getByTestId("write-it-confirm-price")).toHaveText("free");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0); // nothing ran
  await expect(page.getByTestId("start-writing-row")).toHaveCount(0);
  await write.getByTestId("write-it-open").click();
  await confirm.getByTestId("write-it-confirm-go").click();
  await expect(async () => {
    await page.reload();
    await expect(page.locator('[data-testid="start-writing-row"][data-state="ready"]')).toHaveCount(1, {
      timeout: 1000,
    });
  }).toPass({ timeout: 60_000 });
  await page.goto("/");
  await expect(
    page
      .locator('[data-testid="project-row"]')
      .filter({ hasText: "A night-shift paramedic keeps getting calls" }),
  ).toContainText("Film");
});

test("V: the Bible drafted with Prism, edited and applied where ticked; a draft refined as edited, then discarded (free here)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // the series made in story Q
  await page.goto("/projects/night-counter/start");
  await expect(page.getByTestId("start-bible")).toHaveAttribute("data-state", "now");
  await page.getByTestId("start-bible-open").click();
  await expect(page).toHaveURL(/\/projects\/night-counter\/bible$/);
  const panel = page.getByTestId("bible-ai");
  await expect(panel.getByTestId("bible-ai-draft")).toHaveText(/^Draft the Bible · free with /);
  await panel.getByTestId("bible-ai-draft").click();
  // Prism's draft arrives on its own (no reload), in editable fields
  const review = page.getByTestId("bible-ai-review");
  await expect(review).toBeVisible({ timeout: 30_000 });
  const fields = review.getByTestId("bible-ai-field");
  await expect(fields).toHaveCount(11);
  // keep only the genre, edited: untick the rest
  for (const f of await fields.all())
    if ((await f.getAttribute("data-field")) !== "genre") {
      const box = f.getByRole("checkbox");
      if (await box.isChecked()) await box.uncheck();
    }
  const genre = review.locator('[data-field="genre"]').getByTestId("bible-ai-text");
  await expect(genre).toHaveValue("Test genre for Night Counter.");
  await genre.fill("Kitchen drama with a comic heart");
  const toneBefore = await page.locator('input[name="tone"]').inputValue();
  await review.getByTestId("bible-ai-apply").click();
  await expect(page.locator('input[name="genre"]')).toHaveValue("Kitchen drama with a comic heart", {
    timeout: 30_000,
  });
  await expect(page.locator('input[name="tone"]')).toHaveValue(toneBefore); // not ticked: unchanged
  await expect(review).toHaveCount(0); // applied: the draft is done

  // a new draft, edited, then refined as edited: Prism's revision arrives on its own; the Bible is unchanged
  await panel.getByTestId("bible-ai-draft").click();
  await expect(review).toBeVisible({ timeout: 30_000 });
  await review.locator('[data-field="visualStyle"]').getByTestId("bible-ai-text").fill("Neon over steel.");
  await review.getByTestId("bible-ai-draft-note").fill("Warmer, and mostly Japanese dialogue.");
  await review.getByTestId("bible-ai-draft-refine-go").click();
  await expect(page.getByTestId("bible-ai-review")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('input[name="genre"]')).toHaveValue("Kitchen drama with a comic heart");
  // set it aside: the draft and refine forms come back
  await page.getByTestId("bible-ai-discard").click();
  await expect(page.getByTestId("bible-ai-review")).toHaveCount(0, { timeout: 30_000 });
  await expect(panel.getByTestId("bible-ai-draft")).toBeVisible();
  await expect(page.locator('input[name="tone"]')).toHaveValue(toneBefore);
});

test("W: a character saved to the library is added to another project as its own copy, pictures included", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // Yumeko, in the seeded project: save her to the library from her page
  await page.goto(`${P}/characters`);
  await page.locator(`a[href^="${P}/characters/"]`).filter({ hasText: "Yumeko" }).first().click();
  await expect(page.getByRole("heading", { name: "Yumeko" })).toBeVisible();
  const toggle = page.getByTestId("library-toggle");
  await expect(toggle).toHaveAttribute("data-saved", "0");
  await toggle.getByTestId("library-toggle-go").click();
  await expect(page.getByTestId("library-toggle")).toHaveAttribute("data-saved", "1", { timeout: 30_000 });
  // her own project does not offer her
  await page.goto(`${P}/characters`);
  await expect(page.getByTestId("library-panel").getByTestId("library-character")).toHaveCount(0);

  // the series made in story Q: she is offered, and added as a copy with her pictures
  await page.goto("/projects/night-counter/characters");
  const offered = page.getByTestId("library-character").filter({ hasText: "Yumeko" });
  await expect(offered).toHaveCount(1);
  await expect(offered).toContainText("picture");
  await offered.getByTestId("library-add").click();
  await expect(
    page.locator('a[href^="/projects/night-counter/characters/"]').filter({ hasText: "Yumeko" }),
  ).toHaveCount(1, { timeout: 30_000 });
  await page.locator('a[href^="/projects/night-counter/characters/"]').filter({ hasText: "Yumeko" }).click();
  await expect(page.getByRole("heading", { name: "Yumeko" })).toBeVisible();
  // the copy is this project's own: not the library entry (saving it would be a second, separate entry)
  await expect(page.getByTestId("library-toggle")).toHaveAttribute("data-saved", "0");

  // deleting the seeded project would take her out of the library: the confirmation says so
  await page.goto("/");
  const row = page.locator(`[data-testid="project-row"][data-slug="${P.split("/").pop()}"]`);
  await row.getByTestId("project-delete-open").click();
  await expect(row.getByTestId("project-delete-library")).toContainText(
    "Yumeko leaves your library while it is in the Trash",
  );
});

test("X: Delete moves a picture to the Trash; it comes back with Restore, or is deleted for good from there", async ({
  page,
}) => {
  page.on("dialog", (d) => void d.accept()); // "Delete now" asks the browser to confirm
  await openYumeko(page);
  // a fresh take (free test model), then Delete on it: out of the takes, into the Trash
  const takes = await page.getByTestId("studio-take-thumb").count();
  await priced(page);
  await page.getByTestId("studio-generate").click();
  await finished(page, takes + 1);
  const take = page.getByTestId("studio-take");
  const attempt = await take.getAttribute("data-attempt");
  await take.getByTestId("picture-delete").click();
  await expect(page.locator(`[data-testid="studio-take-thumb"][data-attempt="${attempt}"]`)).toHaveCount(0, {
    timeout: 30_000,
  });

  // on the character's page every picture offers Delete too: another take (the next attempt number)
  await priced(page);
  await page.getByTestId("studio-generate").click();
  await finished(page, takes + 2);
  await page.goto(`${P}/characters`);
  await page.locator(`a[href^="${P}/characters/"]`).filter({ hasText: "Yumeko" }).first().click();
  await expect(page.getByRole("heading", { name: "Yumeko" })).toBeVisible();
  const generated = page.getByTestId("character-picture").filter({ hasText: "Generated #" });
  await expect(generated.first()).toBeVisible();
  const before = await generated.count();
  const one = generated.first();
  const asset = await one.getAttribute("data-asset");
  await one.getByTestId("picture-delete").click();
  await expect(page.locator(`[data-testid="character-picture"][data-asset="${asset}"]`)).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(generated).toHaveCount(before - 1);

  // the Trash (in the sidebar, with a count): both are there, 30 days left
  await page.getByRole("link", { name: /^Trash/ }).click();
  await expect(page).toHaveURL(new RegExp(`${P}/trash$`));
  const items = page.getByTestId("trash-item");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText("30 days left");
  // Restore: the picture is back on the character's page
  const back = page.locator(`[data-testid="trash-item"][data-asset="${asset}"]`);
  await back.getByTestId("trash-restore").click();
  await expect(back).toHaveCount(0, { timeout: 30_000 });
  // Delete now: gone for good (after the browser's confirmation)
  await items.first().getByTestId("trash-delete-now").click();
  await expect(page.getByTestId("trash-empty-note")).toBeVisible({ timeout: 30_000 });
  await page.goto(`${P}/characters`);
  await page.locator(`a[href^="${P}/characters/"]`).filter({ hasText: "Yumeko" }).first().click();
  await expect(page.locator(`[data-testid="character-picture"][data-asset="${asset}"]`)).toHaveCount(1);
});

test("Y: a character is deleted to the Trash, restored, then deleted for good; one the story uses is refused with where", async ({
  page,
}) => {
  page.on("dialog", (d) => void d.accept()); // Delete asks the browser to confirm
  // a character nothing uses yet
  await page.goto(`${P}/characters`);
  await page.locator('input[name="name"]').fill("Extra Waiter");
  await page.getByRole("button", { name: "Create" }).click();
  // Create opens the new character's page
  await expect(page.getByRole("heading", { name: "Extra Waiter" })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("subject-delete-go").click();
  await expect(page).toHaveURL(new RegExp(`${P}/characters$`), { timeout: 30_000 });
  await expect(page.locator(`a[href^="${P}/characters/"]`).filter({ hasText: "Extra Waiter" })).toHaveCount(
    0,
  );

  // in the Trash: Restore brings them back
  await page.goto(`${P}/trash`);
  const row = page.locator('[data-testid="trash-subject"][data-name="Extra Waiter"]');
  await expect(row).toContainText("Character · 30 days left");
  await row.getByTestId("trash-subject-restore").click();
  await expect(row).toHaveCount(0, { timeout: 30_000 });
  await page.goto(`${P}/characters`);
  await expect(page.locator(`a[href^="${P}/characters/"]`).filter({ hasText: "Extra Waiter" })).toHaveCount(
    1,
  );

  // deleted again, then for good from the Trash
  await page.locator(`a[href^="${P}/characters/"]`).filter({ hasText: "Extra Waiter" }).click();
  await page.getByTestId("subject-delete-go").click();
  await expect(page).toHaveURL(new RegExp(`${P}/characters$`), { timeout: 30_000 });
  await page.goto(`${P}/trash`);
  await page
    .locator('[data-testid="trash-subject"][data-name="Extra Waiter"]')
    .getByTestId("trash-subject-delete-now")
    .click();
  await expect(page.locator('[data-testid="trash-subject"][data-name="Extra Waiter"]')).toHaveCount(0, {
    timeout: 30_000,
  });

  // Yumeko is in the story's Shots: her Delete is refused with where she is used
  await page.goto(`${P}/characters`);
  await page.locator(`a[href^="${P}/characters/"]`).filter({ hasText: "Yumeko" }).first().click();
  await page.getByTestId("subject-delete-go").click();
  await expect(page.getByTestId("subject-delete")).toContainText("can't be deleted yet: it is still used in");
  await expect(page.getByRole("heading", { name: "Yumeko" })).toBeVisible();
});

import { expect, test, type Page } from "@playwright/test";
import { buildSeedProject } from "../src/data/seed";
import { FfmpegEpisodeRenderer } from "../src/render/ffmpeg-renderer";
import { MediaLab } from "../src/render/__tests__/media-checks";
import { stillPng } from "../src/render/__tests__/render-fixtures";

/**
 * Phase 5B-I1 / I1b on its own memory server (memory-5b-isolated): Character, Location and Shot images through the
 * existing generation pipeline with the FREE mock image models and the in-process worker. No provider, no paid call.
 *
 *   A  Character: Generate Image → finished → Use as Character Reference
 *   B  Location:  Generate Image → finished → Use as Location Reference
 *   C  Shot 3A:   Generate Image (the existing Production Frame candidate workflow) → Use as Storyboard Frame
 *   D  Character: Edit Image → new image with lineage → Use as Character Reference (5B-I2)
 *   E  Location:  generated image → Use as Location View (5B-I2)
 *   F  Shot 3A:   Edit Image → new Production Frame candidate with lineage → existing PF guard → Use as Storyboard (5B-I2)
 *   G  Character: upload a plain-background portrait → Remove Background → review → Use as Character Reference (5B-I3)
 *   H  Character: Visual Bible readiness → Use as Canonical → the large canonical image (5B-I4)
 *   I  Location:  Visual Bible readiness → Use as Canonical → views from E → replacement needs confirmation (5B-I5)
 *   J  Shot 3A:   Production Frame Inputs from the Visual Bibles (Yumeko canonical + Look, the selected Lobby view,
 *                 the Lobby canonical) → Generate Production Frame → Use as Production Frame → refresh → Generate
 *                 Alternatives → the canonical frame is unchanged (5B-I6)
 *   K  Import Story: paste the Ojou-sama screenplay → Analyze with the free test analyser → Proposal → review (deselect a
 *                 Shot, edit a Scene) → Apply selected → the new Episode's Shot opens with its Production Frame Inputs
 *                 (5B-S1)
 *   L  Write: Ojou-sama Episode 1, Scene 6 → select the exchange → Ask Prism (guarded Yumeko) → inspect the diff →
 *                 Reject → ask again → Accept → refresh: the accepted revision is the screenplay and the old one is in the
 *                 history → three warmer alternatives for the last line → Accept B → only B is canon; the Shot shows
 *                 "Story changed after production breakdown" (5B-S2)
 *   M  Plan Shots: Ojou-sama Scene 3 → Plan Shots with Prism → review (duplicate, reorder, edit, deselect, replace 3A with
 *                 approval) → Apply → Shot 3A's Characters / Location feed the I6 Production Frame Inputs → a screenplay
 *                 change through S2 marks the plan story-changed; nothing is replaced (5B-S4)
 *   N  Direct with Prism: Shot 3A (selected Location View = hard constraint) → Camera / Blocking / Lighting /
 *                 Composition / Storyboard → edit + save → Apply Direction → same Shot → the I6 Production Frame Inputs
 *                 show the camera, blocking and lighting → 3B keeps Yumeko screen-right (5B-S5)
 *   O  The integrated loop by navigation only: Import Story → Write (accept) → Scenes → Plan Shots (re-plan, apply) →
 *                 Shot 3A (story changed) → Direct with Prism (needs review → direct again → apply) → Production Frame
 *                 Inputs (Visual Bibles + View + direction + story) → mock candidate → conform → canonical (5B loop)
 *   P  Animate: Shot 3A's canonical Production Frame → Video Inputs → free mock clip → play → Use as Shot Clip →
 *                 refresh → Generate Alternative (motion note; the Shot Clip is unchanged) → a new S5 direction marks the
 *                 clip "needs review", still playable (5B-V1)
 *   Q  Sequence + Animatic: Episode → Edit (the Episode Sequence) → 3A / 3B Shot Clips, 3C Production Frame → reorder
 *                 3B / 3C → Play Animatic follows the new order → pause / scrub / next → reset to story order → replace
 *                 3A's Shot Clip → the row says "Replacement available" → Use current Shot Clips → an upstream direction
 *                 change: 3B's clip still plays, "Needs review" (5B-V2)
 *   R  Episode Edit: the V2 rough cut → trim 3A and 3B → hold 3C 4.5 s → opening title → reorder → cross dissolve
 *                 3C → 3B → preview from the start (title, scrub into the dissolve, select an item) → Save revision →
 *                 refresh (same state) → the Shot Clip is still the full clip; the Production Frame unchanged → another
 *                 revision → restore the first as a new revision (5B-V3)
 *   S  Render Episode: resolve missing media → save the revision → Render Episode → Queued … Completed (the in-process
 *                 segmented render worker, real ffmpeg) → Play Final → download through the private route and verify
 *                 the real MP4 (H.264 1920×804 24 fps, frame-exact duration, the title, 3A / 3C / 3B and the other
 *                 Scene at their places) → a new revision → the old render says so → render it → both remain (5B-V4)
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
  await edit.locator("summary").first().click();
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
  await edit.locator("summary").first().click();
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
  // the EXISTING Production Frame promotion stays authoritative: the edit is accepted as a candidate (not "stale"), and
  // 3A's 2.39:1 frame needs its production conform first (never a silent crop): 5B-I6 offers the conform here, and
  // never offers a Use as Production Frame that would be refused
  await expect(edited.getByTestId("shot-create-conform")).toBeVisible();
  await expect(edited.getByTestId("shot-use-as-production-frame")).toHaveCount(0);
  await expect(page.getByText(/no longer the canonical one/)).toHaveCount(0);
  await edited.getByTestId("shot-use-as-storyboard").click();
  await expect(page.getByText("Added as a Storyboard frame")).toBeVisible({ timeout: 30_000 });
});

// ── Phase 5B-I3: Remove Background (local, free; nothing generated) ──

test("G — Character: upload a portrait, Remove Background, review original vs cutout, Use as Character Reference", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { portraitFixturePng } = await import("../src/generation/matting/fixture");
  await page.goto(`${P}/characters`);
  await page.getByRole("link", { name: "Yumeko" }).first().click();
  await expect(page.getByTestId("subject-images")).toBeVisible();
  // the seeded identity references are locked: the creator explicitly unlocks them before uploading (as in story B)
  const unlock = page.getByRole("button", { name: "Unlock", exact: true });
  if ((await unlock.count()) > 0) {
    await unlock.first().click();
    await expect(page.getByRole("button", { name: "Lock all", exact: true })).toBeVisible({
      timeout: 30_000,
    });
  }
  // an unlocked identity slot takes the fixture (the real upload path: magic bytes, checksum, private storage)
  const slot = page.locator('[data-testid^="identity-slot-"]').last();
  await expect(slot).toBeVisible();
  await slot.getByTestId("identity-file").setInputFiles({
    name: "yumeko-portrait.png",
    mimeType: "image/png",
    buffer: Buffer.from(portraitFixturePng()),
  });
  await slot.getByTestId("identity-upload").click();
  await page.waitForTimeout(1500);
  await page.reload();
  const panel = page.getByTestId("subject-images");
  const box = panel.getByTestId("subject-image-remove-background");
  await box.locator("summary").first().click();
  const option = box
    .getByTestId("remove-background-source")
    .locator("option", { hasText: "Reference:" })
    .first();
  await box.getByTestId("remove-background-source").selectOption((await option.getAttribute("value"))!);
  await box.getByTestId("remove-background-submit").click();
  await expect(page.getByText("Background removal queued")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => {
        await page.reload();
        const cut = panel
          .getByTestId("subject-image")
          .filter({ has: page.getByTestId("subject-image-cutout-lineage") });
        return (await cut.count()) > 0 ? cut.first().getAttribute("data-status") : "waiting";
      },
      { timeout: 90_000, intervals: [1500] },
    )
    .toBe("succeeded");
  const cut = panel
    .getByTestId("subject-image")
    .filter({ has: page.getByTestId("subject-image-cutout-lineage") })
    .first();
  await expect(cut.getByTestId("subject-image-cutout-review")).toBeVisible();
  await expect(cut.getByTestId("subject-image-cutout-lineage")).toContainText("→ background removal #");
  await cut.locator('select[name="slot"]').selectOption("additional");
  await cut.getByTestId("use-as-character-reference").click();
  await expect(page.getByText("Character reference set")).toBeVisible({ timeout: 30_000 });
});

// ── Phase 5B-I4: Character Visual Bible ──

test("H — Character: the Visual Bible shows readiness; Use as Canonical sets the large canonical image", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(`${P}/characters`);
  await page.getByRole("link", { name: "Yumeko" }).first().click();
  const vb = page.getByTestId("visual-bible");
  await expect(vb).toBeVisible();
  await expect(vb.getByTestId("vb-readiness")).toBeVisible();
  // the earlier stories made generated images: choose one as the canonical identity (an explicit act)
  const source = vb.getByTestId("vb-canonical-source");
  const value = await source.locator("option", { hasText: "Generated" }).first().getAttribute("value");
  await source.selectOption(value!);
  await vb.getByTestId("vb-use-as-canonical").click();
  await expect(page.getByText("Canonical identity set")).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByTestId("vb-canonical-image")).toBeVisible();
  await expect(page.getByTestId("vb-item-canonical")).toHaveAttribute("data-done", "true");
});

test("I — Location: the Visual Bible shows readiness and views; Use as Canonical; replacing it needs confirmation", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(`${P}/locations`);
  const vb = page.locator('[data-testid^="location-visual-bible-"]').first();
  const open = () =>
    vb.evaluate((el) => {
      const details = el.closest("details");
      if (details) details.open = true;
    });
  await open();
  await expect(vb.getByTestId("lvb-readiness")).toBeVisible();
  await expect(vb.getByTestId("lvb-presets")).toBeVisible();
  // story E made a Location View of this Location: it appears among the Views
  await expect(vb.getByTestId("lvb-view").first()).toBeVisible();
  await expect(vb.getByTestId("lvb-item-view")).toHaveAttribute("data-done", "true");
  // stories B/E unlocked this Location; choose a generated image as the canonical appearance (an explicit act)
  const source = vb.getByTestId("lvb-canonical-source");
  const value = await source.locator("option", { hasText: "Generated" }).first().getAttribute("value");
  await source.selectOption(value!);
  await vb.getByTestId("lvb-use-as-canonical").click();
  await expect(page.getByText("Canonical appearance set")).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await open();
  await expect(vb.getByTestId("lvb-canonical-image")).toBeVisible();
  await expect(vb.getByTestId("lvb-item-canonical")).toHaveAttribute("data-done", "true");
  // another image's "Use as Canonical" does not silently replace it
  const details = vb.locator("xpath=ancestor::details[1]");
  const images = details.getByTestId("subject-images").getByTestId("subject-image");
  if ((await images.count()) > 1) {
    await images.nth(1).getByTestId("use-as-canonical-location").click();
    await expect(page.getByText(/already has a canonical appearance\. Confirm to replace it/)).toBeVisible({
      timeout: 30_000,
    });
  }
});

test("J — Shot 3A: Production Frame Inputs come from the Visual Bibles; promote one; alternatives never replace it", async ({
  page,
}) => {
  test.setTimeout(420_000);
  // ── the Lobby's Visual Bible, through the UI: a canonical appearance and a named Location View ──
  await page.goto(`${P}/locations`);
  const lobby = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Grand Celeste Lobby" }) });
  const openLobby = () =>
    lobby.evaluate((el) => {
      (el as HTMLDetailsElement).open = true;
    });
  await openLobby();
  await lobby.getByRole("button", { name: "Unlock location" }).click();
  await expect(lobby.getByRole("button", { name: "Lock location" })).toBeVisible({ timeout: 30_000 });
  await openLobby();
  const images = lobby.locator('[data-testid^="location-images-"]').getByTestId("subject-images");
  await images.getByTestId("subject-image-intent").selectOption("establishing_view");
  await images.getByTestId("subject-image-generate").click();
  await expect(page.getByText("Image queued")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => {
        await page.reload();
        await openLobby();
        return images.getByTestId("subject-image").first().getAttribute("data-status");
      },
      { timeout: 90_000, intervals: [1500] },
    )
    .toBe("succeeded");
  const still = images.getByTestId("subject-image").first();
  await still.getByTestId("use-as-canonical-location").click();
  await expect(page.getByText("Canonical appearance set")).toBeVisible({ timeout: 30_000 });
  await openLobby();
  await still.locator('input[name="lv_name"]').fill("Entrance toward elevators");
  await still.getByTestId("use-as-location-view").click();
  await expect(page.getByText("Location View saved")).toBeVisible({ timeout: 30_000 });
  await openLobby();
  await lobby.getByRole("button", { name: "Lock location" }).click();
  await expect(lobby.getByRole("button", { name: "Unlock location" })).toBeVisible({ timeout: 30_000 });

  // ── Shot 3A: select the view, then read the inputs ──
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: "3A", exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  const shotUrl = page.url().split("?")[0]!;
  await page.goto(`${shotUrl}?section=production_frame`);
  await page.getByTestId("location-view-section").getByTestId("lv-choose").first().click();
  await expect(page.getByTestId("lv-selected")).toBeVisible({ timeout: 30_000 });
  await page.goto(`${shotUrl}?section=production_frame`);
  const inputs = page.getByTestId("pf-inputs");
  await expect(inputs).toBeVisible();
  await expect(inputs.getByTestId("pf-inputs-characters")).toContainText("Yumeko — Canonical Identity");
  await expect(inputs.getByTestId("pf-inputs-characters")).toContainText("Formal Black");
  await expect(inputs.getByTestId("pf-inputs-location")).toContainText(
    "Grand Celeste Lobby — Entrance toward elevators",
  );
  await expect(inputs.getByTestId("pf-inputs-location")).toContainText("Grand Celeste Lobby — Canonical");
  await expect(page.getByTestId("pf-ready-characters")).toHaveAttribute("data-done", "true");
  await expect(page.getByTestId("pf-ready-location")).toHaveAttribute("data-done", "true");

  // ── Generate Production Frame (free mock model) → a candidate → Use as Production Frame ──
  const stills = page.getByTestId("shot-generated-still");
  const newest = async () =>
    (await stills.count()) ? await stills.first().getAttribute("data-attempt") : null;
  const before = await newest();
  await page.getByTestId("shot-generate-image").click();
  await page.waitForURL(/\/candidates\/[0-9a-f-]{36}/, { timeout: 60_000 });
  await expect
    .poll(
      async () => {
        await page.goto(`${shotUrl}?section=production_frame`);
        return newest();
      },
      { timeout: 120_000, intervals: [2000] },
    )
    .not.toBe(before);
  const freshAttempt = await stills.first().getAttribute("data-attempt");
  const fresh = page.locator(`[data-testid="shot-generated-still"][data-attempt="${freshAttempt}"]`);
  // 3A is 2.39:1: the existing production conform comes first (never a silent crop), then the promotion
  await fresh.getByTestId("shot-create-conform").click();
  await expect
    .poll(
      async () => {
        await page.goto(`${shotUrl}?section=production_frame`);
        return fresh.getByTestId("shot-use-as-production-frame").count();
      },
      { timeout: 60_000, intervals: [1500] },
    )
    .toBe(1);
  await fresh.getByTestId("shot-use-as-production-frame").click();
  // after a refresh, exactly that candidate is the canonical Production Frame
  const current = page.locator('[data-testid="shot-generated-still"][data-current="true"]');
  await expect
    .poll(
      async () => {
        await page.goto(`${shotUrl}?section=production_frame`);
        return current.count();
      },
      { timeout: 60_000, intervals: [1500] },
    )
    .toBe(1);
  await expect(current).toHaveAttribute("data-attempt", freshAttempt!);
  const pfBefore = await page.getByTestId("pf-selected").getAttribute("data-version");

  // ── Generate Alternatives: a new candidate; the canonical Production Frame is unchanged ──
  await page.getByTestId("shot-alternate-composition").click();
  await page.waitForURL(/\/candidates\/[0-9a-f-]{36}/, { timeout: 60_000 });
  await expect
    .poll(
      async () => {
        await page.goto(`${shotUrl}?section=production_frame`);
        return newest();
      },
      { timeout: 120_000, intervals: [2000] },
    )
    .not.toBe(freshAttempt);
  await expect(current).toHaveAttribute("data-attempt", freshAttempt!);
  await expect(page.getByTestId("pf-selected")).toHaveAttribute("data-version", pfBefore ?? "");
});

test("K — Import Story: screenplay → Production Proposal → review → Apply selected → a Shot ready for the image pipeline", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const script = buildSeedProject().episodes[0]!.scriptText;
  await page.goto(`${P}/story`);
  await page.getByTestId("story-paste-form").getByTestId("story-title").fill("Ojou-sama (imported)");
  await page.getByTestId("story-text").fill(script);
  // the free test analyser is preselected (no paid model, no provider call)
  await expect(page.getByTestId("story-paste-form").getByTestId("story-model")).toHaveValue(
    "prism-test/screenplay-parser-v1",
  );
  await page.getByTestId("story-paste-form").getByTestId("story-analyze").click();
  await page.waitForURL(/\/story\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  const proposalUrl = page.url();
  await expect
    .poll(
      async () => {
        await page.goto(proposalUrl);
        return page.getByTestId("story-status").getAttribute("data-status");
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe("ready");
  await expect(page.getByTestId("story-counts")).toContainText("5 Characters");
  await expect(page.getByTestId("story-counts")).toContainText("5 Locations");
  await expect(page.getByTestId("story-counts")).toContainText("6 Scenes");
  const characters = page.getByTestId("story-section-character");
  for (const name of ["Yumeko", "Sean", "Takumi"]) await expect(characters).toContainText(name);
  const locations = page.getByTestId("story-section-location");
  for (const name of ["Grand Celeste Lobby", "Sky-View Restaurant", "Hotel Hallway", "Tokyo Night Streets"])
    await expect(locations).toContainText(name);
  // the project already has Yumeko: surfaced as a possible match, never merged silently
  const yumeko = characters.getByTestId("story-item").filter({ hasText: "Yumeko" });
  await expect(yumeko.getByTestId("story-match")).toContainText("Possible match: existing Character Yumeko");
  await expect(yumeko.getByTestId("story-source")).toContainText("Why: lines");
  // deselect one optional item: the first suggested Shot
  const shots = page.getByTestId("story-section-shot").getByTestId("story-item");
  await shots.first().getByTestId("story-include").uncheck();
  // edit one proposal field: the Lobby Scene's summary
  const lobby = page
    .getByTestId("story-section-scene")
    .getByTestId("story-item")
    .filter({ hasText: "LOBBY" });
  await lobby.locator("summary", { hasText: "Edit" }).click();
  await lobby.getByTestId("story-edit-summary").fill("Alone at last, Yumeko lets the mask drop.");
  await page.getByTestId("story-apply").click();
  await expect(page.getByTestId("story-applied")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("story-status")).toHaveAttribute("data-status", "applied");
  // the created Shot opens in Shot Prep and reads its Production Frame Inputs from existing Characters / Locations
  const shotHref = await page.getByTestId("story-applied-shot").getAttribute("href");
  await page.goto(`${shotHref}?section=production_frame`);
  const inputs = page.getByTestId("pf-inputs");
  await expect(inputs).toBeVisible({ timeout: 30_000 });
  await expect(inputs.getByTestId("pf-inputs-location")).toContainText("Grand Celeste");
  // the new Episode holds the edited Lobby Scene
  await page.goto(`${P}/story`);
  await expect(page.getByTestId("story-proposal-row").first()).toContainText("applied");
});

test("L — Write: guarded Yumeko proposal → diff → reject → accept the second → history → three alternatives, one canon", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const seed = buildSeedProject();
  const ep1 = seed.episodes[0]!;
  const scene6 = seed.scenes.find((s) => s.episodeId === ep1.id && s.sceneNumber === "6")!;
  const shot6 = seed.shots.find((s) => s.sceneId === scene6.id)!;
  await page.goto(`${EP}/write`);
  await page.getByRole("link", { name: /^6\. INT\. SKY-VIEW RESTAURANT/ }).click();
  await page.waitForURL(/scene=/);
  const script = page.getByLabel("Screenplay text");
  const original = await script.inputValue();
  expect(original).toContain("SEAN approaches the table and stops.");

  /** Selects `from` … end of `to` in the screenplay view (fires the native select event). */
  const select = async (from: string, to: string) => {
    await script.evaluate(
      (el, [a, b]) => {
        const t = el as HTMLTextAreaElement;
        const start = t.value.indexOf(a!);
        const end = t.value.indexOf(b!, start) + b!.length;
        t.focus();
        t.setSelectionRange(start, end);
        t.dispatchEvent(new Event("select"));
      },
      [from, to],
    );
    await expect(page.getByTestId("selection-status")).toContainText("Selected");
  };
  const ask = async (instruction: string) => {
    await page.getByLabel("Instruction for Prism").fill(instruction);
    await page.getByRole("button", { name: "Ask Prism", exact: true }).click();
  };
  const turn = (n: number) => page.getByTestId(`turn-${n}`);
  const GUARDED =
    "Make Yumeko more guarded and emotionally restrained without changing what happens in the scene.";

  // 1. select the exchange, ask Prism (free test writer: no provider call)
  await select("SEAN approaches", "結婚してください。");
  await ask(GUARDED);
  await page.waitForURL(/session=/, { timeout: 30_000 });
  await expect(turn(1).getByTestId("version-A")).toBeVisible({ timeout: 60_000 });
  // 2. the proposal shows a diff and is labelled as a suggestion; the screenplay is untouched
  await expect(turn(1).getByText("AI suggestion — not canon")).toBeVisible();
  await expect(turn(1).getByTestId("revision-diff").locator("ins", { hasText: "Yumeko" })).toBeVisible();
  await expect(turn(1).getByTestId("revision-diff")).toContainText("line");
  await expect(script).toHaveValue(original);
  // 3. reject it: nothing changes
  await turn(1).getByRole("button", { name: "Reject" }).click();
  await expect(turn(1).getByText("Rejected")).toBeVisible({ timeout: 30_000 });
  await expect(script).toHaveValue(original);
  // 4. ask again, accept the second proposal
  await select("SEAN approaches", "結婚してください。");
  await ask(`${GUARDED} Keep it subtle.`);
  await expect(turn(2).getByTestId("version-A")).toBeVisible({ timeout: 60_000 });
  await turn(2).getByRole("button", { name: "Accept version A" }).click();
  await expect(turn(2).getByText("Accepted version A")).toBeVisible({ timeout: 30_000 });
  // 5. refresh: the accepted revision is the screenplay; the old one is recoverable in the history
  await page.reload();
  await expect(script).not.toHaveValue(original);
  await expect(script).toHaveValue(/Yumeko holds his gaze, giving nothing away\./);
  const history = page.getByTestId("revision-history");
  await expect(history).toContainText("#2 Creator-approved Prism AI revision");
  await expect(history).toContainText("#1 Script before Prism AI history began");
  const first = history.locator("li").filter({ hasText: "#1 " });
  await first.locator("summary", { hasText: "View text" }).click();
  await expect(first.locator("pre")).toContainText("SEAN approaches the table and stops.");
  await expect(first.locator("pre")).not.toContainText("Yumeko holds his gaze");
  await expect(first.getByRole("button", { name: "Restore revision 1" })).toBeVisible();
  // 6. three warmer alternatives for the last line; choose B; only B becomes canon
  await select("お嬢様、僕と結婚してください。", "お嬢様、僕と結婚してください。");
  await ask("Give me three warmer alternatives for the last line.");
  for (const v of ["A", "B", "C"])
    await expect(turn(3).getByTestId(`version-${v}`)).toBeVisible({ timeout: 60_000 });
  await turn(3).getByRole("button", { name: "Accept version B" }).click();
  await expect(turn(3).getByText("Accepted version B")).toBeVisible({ timeout: 30_000 });
  await page.reload();
  const canon = await script.inputValue();
  expect(canon).toContain("SEAN\n(gently)\nお嬢様、僕と結婚してください。");
  expect(canon).not.toContain("(warmly)");
  expect(canon).not.toContain("(with a small smile)");
  await expect(history).toContainText("#3 Creator-approved Prism AI revision (version B");
  // 7. downstream: the Scene's Shot is flagged, nothing deleted
  await page.goto(`${EP}/shots/${shot6.id}`);
  await expect(page.getByTestId("story-changed")).toContainText("Story changed after production breakdown");
});

test("M — Plan Shots: Scene 3 → Shot List → reorder / edit / deselect → Apply → Shot 3A feeds Production Frames → story change", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const seed = buildSeedProject();
  const ep1 = seed.episodes[0]!;
  const scene3 = seed.scenes.find((s) => s.episodeId === ep1.id && s.sceneNumber === "3")!;
  const shot3A = seed.shots.find((s) => s.sceneId === scene3.id && s.shotCode === "3A")!;
  // 1. Scene 3 → Plan Shots with Prism (free test planner)
  await page.goto(`${EP}/scenes`);
  const row = page.locator("details").filter({ hasText: "INT. GRAND CELESTE LOBBY - NIGHT" });
  await row.getByTestId("plan-shots-link").click();
  await page.waitForURL(/\/scenes\/[0-9a-f-]{36}\/plan/);
  await expect(page.getByTestId("plan-scene-text")).toContainText("Yumeko stands alone at the elevators.");
  await page.getByTestId("plan-shots").click();
  await page.waitForURL(/proposal=/, { timeout: 30_000 });
  await expect(page.getByTestId("plan-status")).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
  // 2. review: an ordered list with sources and reasons
  const items = page.getByTestId("plan-shot");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).getByTestId("plan-shot-title")).toContainText("Lobby master");
  await expect(items.nth(1).getByTestId("plan-shot-title")).toContainText("Yumeko medium close");
  await expect(items.nth(1).getByTestId("plan-shot-source")).toContainText("Source: lines 23–24");
  await expect(items.nth(1).getByTestId("plan-shot-dialogue")).toContainText("もう帰りたい");
  await expect(items.nth(0).getByTestId("plan-shot-match")).toContainText("3A");
  // 3. a variant of the Yumeko Shot (optional coverage), then reorder: Yumeko first
  await items.nth(1).getByRole("button", { name: "Duplicate" }).click();
  await expect(items).toHaveCount(3, { timeout: 30_000 });
  await page.getByRole("button", { name: "Move Yumeko medium close up" }).first().click();
  await expect(items.nth(0).getByTestId("plan-shot-title")).toContainText("Yumeko medium close", {
    timeout: 30_000,
  });
  // 4. edit one purpose; deselect the optional variant; the master replaces the existing 3A (explicit approval)
  const yumeko = items.nth(0);
  await yumeko.locator("summary", { hasText: "Edit" }).click();
  await yumeko.getByTestId("plan-edit-purpose").fill("Alone, Yumeko finally says what she wants.");
  const variant = items.filter({ hasText: "variant" });
  await variant.getByRole("checkbox", { name: /^Include/ }).uncheck();
  const master = items.filter({ hasText: "Lobby master" });
  await master.getByRole("combobox", { name: /^Apply Lobby master as/ }).selectOption(shot3A.id);
  await page.getByRole("checkbox", { name: /I approve replacing/ }).check();
  await page.getByTestId("plan-apply").click();
  await expect(page.getByTestId("plan-applied")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("plan-status")).toHaveAttribute("data-status", "applied");
  await expect(page.getByTestId("plan-applied")).toContainText("1 created, 1 replaced");
  // 5. Shot 3A: Character + Location relationships, and the existing I6 Production Frame Inputs read them
  await page.goto(`${EP}/shots/${shot3A.id}?section=production_frame`);
  const inputs = page.getByTestId("pf-inputs");
  await expect(inputs).toBeVisible({ timeout: 30_000 });
  await expect(inputs.getByTestId("pf-inputs-characters")).toContainText("Yumeko");
  await expect(inputs.getByTestId("pf-inputs-location")).toContainText("Grand Celeste Lobby");
  await expect(page.getByText("Lobby master").first()).toBeVisible();
  // 6. change the Scene through the S2 revision path (Write → accept); the applied plan is marked, never replaced
  await page.goto(`${EP}/write?scene=${scene3.id}`);
  const script = page.getByLabel("Screenplay text");
  await script.evaluate((el) => {
    const t = el as HTMLTextAreaElement;
    const a = t.value.indexOf("The lobby is hushed.");
    t.focus();
    t.setSelectionRange(a, a + "The lobby is hushed. Yumeko stands alone at the elevators.".length);
    t.dispatchEvent(new Event("select"));
  });
  await page.getByLabel("Instruction for Prism").fill("Make the lobby feel tense.");
  await page.getByRole("button", { name: "Ask Prism", exact: true }).click();
  const turn = page.locator('[data-testid^="turn-"]').last();
  await expect(turn.getByRole("button", { name: "Accept version A" })).toBeVisible({ timeout: 60_000 });
  await turn.getByRole("button", { name: "Accept version A" }).click();
  await expect(turn.getByText("Accepted version A")).toBeVisible({ timeout: 30_000 });
  await page.goto(`${EP}/scenes/${scene3.id}/plan`);
  await expect(page.getByTestId("plan-story-changed")).toContainText(
    "Story changed after production breakdown",
  );
  await expect(page.getByTestId("plan-versions")).toContainText("story changed");
  await expect(page.getByTestId("plan-shots")).toHaveText("Re-plan Shots");
  // nothing was replaced or deleted: 3A and the new 3B are still the Scene's Shots
  await expect(page.getByTestId("plan-existing-shots")).toContainText("3A — Lobby master");
  await expect(page.getByTestId("plan-existing-shots")).toContainText("3B — Yumeko medium close");
});

test("N — Direct with Prism: Shot 3A → direction → edit → Apply → same Shot feeds I6; 3B keeps the screen direction", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const seed = buildSeedProject();
  const shot3A = seed.shots.find((s) => s.shotCode === "3A")!;
  const waitReady = async () => {
    await page.waitForURL(/\/direct\?proposal=/, { timeout: 30_000 });
    await expect
      .poll(
        async () => {
          await page.reload();
          return page.getByTestId("dir-status").getAttribute("data-status");
        },
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe("ready");
  };
  // 1. Shot 3A → Direct with Prism (the selected Location View from story J is a hard constraint)
  await page.goto(`${EP}/shots/${shot3A.id}`);
  await page.getByTestId("direct-with-prism").click();
  await page.waitForURL(/\/direct$/);
  await expect(page.getByTestId("dir-context-view")).toContainText(
    "Entrance toward elevators (a hard constraint)",
  );
  await page.getByTestId("dir-direct").click();
  await waitReady();
  // 2. the sections
  for (const s of ["camera", "blocking", "lighting", "composition", "continuity", "storyboard"])
    await expect(page.getByTestId(`dir-section-${s}`)).toBeVisible();
  await expect(page.getByTestId("dir-storyboardDescription")).toHaveValue(
    /from the Entrance toward elevators view in Grand Celeste Lobby/,
  );
  await expect(page.getByTestId("dir-blocking")).toContainText("Yumeko — screen right, midground");
  await expect(page.getByTestId("dir-section-camera")).toContainText(
    'Uses the selected "Entrance toward elevators" view.',
  );
  // 3. edit one field, save the review
  const key = "Warm chandelier overhead, cool city spill through the glass";
  await page.getByTestId("dir-lighting.key").fill(key);
  await page.getByRole("button", { name: "Save review" }).click();
  await expect
    .poll(async () => (await page.reload(), page.getByTestId("dir-lighting.key").inputValue()), {
      timeout: 30_000,
    })
    .toBe(key);
  // 4. Apply Direction → refresh → the same Shot, now directed
  await page.getByTestId("dir-apply").click();
  await expect(page.getByTestId("dir-applied")).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByTestId("dir-status")).toHaveAttribute("data-status", "applied");
  await page.getByRole("link", { name: "Production Frame Inputs →" }).click();
  await page.waitForURL(new RegExp(`/shots/${shot3A.id}\\?section=production_frame`));
  // 5. the EXISTING I6 Production Frame Inputs show the applied camera, blocking and lighting
  const inputs = page.getByTestId("pf-inputs");
  await expect(inputs).toBeVisible({ timeout: 30_000 });
  const direction = inputs.getByTestId("pf-inputs-direction");
  await expect(direction).toContainText("wide environmental");
  await expect(direction).toContainText("Hushed, lonely");
  await expect(direction).toContainText("Angle: eye level");
  await expect(direction).toContainText("Yumeko in the midground, frame right");
  await expect(inputs.getByTestId("pf-inputs-characters")).toContainText("Yumeko — screen right, midground");
  await expect(inputs.getByTestId("pf-inputs-location")).toContainText(
    "Grand Celeste Lobby — Entrance toward elevators",
  );
  // 6. the next Shot in the Scene keeps Yumeko where 3A put her
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: "3B", exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  await page.getByTestId("direct-with-prism").click();
  await page.waitForURL(/\/direct$/);
  await expect(page.getByTestId("dir-context-adjacent")).toContainText("3A Lobby master");
  await page.getByTestId("dir-direct").click();
  await waitReady();
  await expect(page.getByTestId("dir-blocking")).toContainText("Yumeko — screen right");
  await expect(page.getByTestId("dir-section-continuity")).toContainText("Cuts with 3A (Lobby master)");
  await page.getByTestId("dir-apply").click();
  await expect(page.getByTestId("dir-applied")).toBeVisible({ timeout: 30_000 });
});

test("O — the integrated loop by navigation: Import Story → Write → Scenes → Plan Shots → Shot → Direct → Production Frame", async ({
  page,
}) => {
  test.setTimeout(420_000);
  const seed = buildSeedProject();
  const shot3A = seed.shots.find((s) => s.shotCode === "3A")!;
  const scene3 = seed.scenes.find((s) => s.id === shot3A.sceneId)!;
  const shotUrl = `${EP}/shots/${shot3A.id}`;
  // 1. Import Story (S1): the project menu leads there; story K's proposal is listed as applied
  await page.goto(P);
  await page.getByRole("link", { name: "Import Story" }).first().click();
  await page.waitForURL(/\/story$/);
  await expect(page.getByTestId("story-proposal-row").first()).toContainText("applied");
  // 2. Write (S2): the Episode's Write tab → Scene 3 → a Prism revision → Accept → it is canon, with history
  await page.goto(`${EP}/script`);
  await page.getByRole("link", { name: "Write", exact: true }).click();
  await page.waitForURL(/\/write/);
  await page.getByRole("link", { name: /^3\. INT\. GRAND CELESTE LOBBY/ }).click();
  await page.waitForURL(/scene=/);
  const script = page.getByLabel("Screenplay text");
  await script.evaluate((el) => {
    const t = el as HTMLTextAreaElement;
    const a = t.value.indexOf("YUMEKO");
    t.focus();
    t.setSelectionRange(a, t.value.length);
    t.dispatchEvent(new Event("select"));
  });
  await page.getByLabel("Instruction for Prism").fill("Make Yumeko more guarded.");
  await page.getByRole("button", { name: "Ask Prism", exact: true }).click();
  const turn = page.locator('[data-testid^="turn-"]').last();
  await expect(turn.getByRole("button", { name: "Accept version A" })).toBeVisible({ timeout: 60_000 });
  await turn.getByRole("button", { name: "Accept version A" }).click();
  await expect(turn.getByText("Accepted version A")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("revision-history")).toContainText("Creator-approved Prism AI revision");
  // 3. Scenes → Plan Shots (S4): the story change asks for a re-plan; plan, apply (new Shots, nothing replaced)
  await page.getByRole("link", { name: "Scenes", exact: true }).click();
  await page.waitForURL(/\/scenes$/);
  await page
    .locator("details")
    .filter({ hasText: "INT. GRAND CELESTE LOBBY - NIGHT" })
    .getByTestId("plan-shots-link")
    .click();
  await page.waitForURL(new RegExp(`/scenes/${scene3.id}/plan`));
  await expect(page.getByTestId("plan-story-changed")).toBeVisible();
  await page.getByTestId("plan-shots").click();
  await page.waitForURL(/proposal=/, { timeout: 30_000 });
  await expect(page.getByTestId("plan-status")).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
  await expect(page.getByTestId("plan-scene-text")).toContainText("(guardedly)");
  await page.getByTestId("plan-apply").click();
  await expect(page.getByTestId("plan-applied")).toBeVisible({ timeout: 30_000 });
  // 4. → Shot 3A → Direct with Prism (S5): the earlier direction needs review after the story change; direct again
  await page
    .getByTestId("plan-existing-shots")
    .getByRole("link", { name: /^3A — / })
    .click();
  await page.waitForURL(new RegExp(`/shots/${shot3A.id}`));
  await expect(page.getByTestId("story-changed")).toContainText("Story changed after production breakdown");
  await page.getByTestId("direct-with-prism").click();
  await page.waitForURL(/\/direct$/);
  await expect(page.getByTestId("dir-needs-review")).toBeVisible();
  await page.getByTestId("dir-direct").click();
  await page.waitForURL(/\/direct\?proposal=/, { timeout: 30_000 });
  await expect
    .poll(async () => (await page.reload(), page.getByTestId("dir-status").getAttribute("data-status")), {
      timeout: 60_000,
      intervals: [1000],
    })
    .toBe("ready");
  await page.getByTestId("dir-apply").click();
  await expect(page.getByTestId("dir-applied")).toBeVisible({ timeout: 30_000 });
  // 5. → Production Frame Inputs: Visual Bibles + View + S5 direction + story, all automatic
  await page.getByRole("link", { name: "Production Frame Inputs →" }).click();
  await page.waitForURL(new RegExp(`/shots/${shot3A.id}\\?section=production_frame`));
  const inputs = page.getByTestId("pf-inputs");
  await expect(inputs.getByTestId("pf-inputs-characters")).toContainText("Yumeko — Canonical Identity");
  await expect(inputs.getByTestId("pf-inputs-characters")).toContainText("Formal Black");
  await expect(inputs.getByTestId("pf-inputs-characters")).toContainText("Yumeko — screen right");
  await expect(inputs.getByTestId("pf-inputs-location")).toContainText(
    "Grand Celeste Lobby — Entrance toward elevators",
  );
  await expect(inputs.getByTestId("pf-inputs-location")).toContainText("Grand Celeste Lobby — Canonical");
  await expect(inputs.getByTestId("pf-inputs-direction")).toContainText("Angle: eye level");
  await expect(inputs.getByTestId("pf-inputs-direction")).toContainText("Hushed, lonely");
  await expect(inputs.getByTestId("pf-inputs-story")).toContainText("3A — Lobby master");
  // 6. Generate Production Frame (free mock) → production conform → Use as Production Frame → refresh → canonical
  const stills = page.getByTestId("shot-generated-still");
  const newest = async () =>
    (await stills.count()) ? await stills.first().getAttribute("data-attempt") : null;
  const before = await newest();
  await page.getByTestId("shot-generate-image").click();
  await page.waitForURL(/\/candidates\/[0-9a-f-]{36}/, { timeout: 60_000 });
  await expect
    .poll(async () => (await page.goto(`${shotUrl}?section=production_frame`), newest()), {
      timeout: 120_000,
      intervals: [2000],
    })
    .not.toBe(before);
  const attempt = await stills.first().getAttribute("data-attempt");
  const fresh = page.locator(`[data-testid="shot-generated-still"][data-attempt="${attempt}"]`);
  await fresh.getByTestId("shot-create-conform").click();
  await expect
    .poll(
      async () => (
        await page.goto(`${shotUrl}?section=production_frame`),
        fresh.getByTestId("shot-use-as-production-frame").count()
      ),
      { timeout: 60_000, intervals: [1500] },
    )
    .toBe(1);
  await fresh.getByTestId("shot-use-as-production-frame").click();
  const current = page.locator('[data-testid="shot-generated-still"][data-current="true"]');
  await expect
    .poll(async () => (await page.goto(`${shotUrl}?section=production_frame`), current.count()), {
      timeout: 60_000,
      intervals: [1500],
    })
    .toBe(1);
  await page.reload();
  await expect(current).toHaveAttribute("data-attempt", attempt!);
});

test("P — Animate: canonical Production Frame → Video Inputs → mock clip → Use as Shot Clip → alternative → review-needed", async ({
  page,
}) => {
  test.setTimeout(360_000);
  const seed = buildSeedProject();
  const shot3A = seed.shots.find((s) => s.shotCode === "3A")!;
  const animateUrl = `${EP}/shots/${shot3A.id}?section=animate`;
  const panel = page.getByTestId("animate-panel");
  // 1. the canonical Production Frame (story O) is the first frame: Animate is ready
  await page.goto(animateUrl);
  await expect(panel).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  const inputs = page.getByTestId("video-inputs");
  await expect(inputs.getByTestId("video-inputs-first-frame")).toContainText(
    /Production Frame v\d+ — Shot 3A/,
  );
  await expect(inputs.getByTestId("video-inputs-first-frame")).toContainText("production conform");
  await expect(inputs.getByTestId("video-inputs-camera")).toContainText("eye level");
  await expect(inputs.getByTestId("video-inputs-continuity")).toContainText("Formal Black Look");
  await expect(inputs.getByTestId("video-inputs-continuity")).toContainText("Grand Celeste Lobby");
  await expect(inputs.getByTestId("video-inputs-performance")).not.toBeEmpty();
  await inputs.locator("summary", { hasText: "Advanced" }).click();
  await expect(inputs.getByTestId("video-inputs-prompt")).toContainText(
    "Begin exactly from the supplied Production Frame",
  );
  await expect(inputs.getByTestId("video-inputs-prompt")).toContainText("Protect each Character's identity");
  // 2. choose the free mock model → generate → the worker completes a real (mock) video
  await panel
    .locator('[data-testid="model-row"][data-model="mock-video-1"]')
    .getByTestId("model-pick")
    .check();
  await panel.getByTestId("ack-all").check();
  await panel.getByTestId("create-candidate-set").click();
  await page.waitForURL(/\/candidates\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(page.getByTestId("set-rollup")).toContainText("1/1 completed", { timeout: 120_000 });
  const card = page.locator('[data-testid="candidate-card"][data-model="mock-video-1"]');
  await expect(card.getByTestId("candidate-animation")).toHaveAttribute("data-first-frame", "match");
  // 3. play the candidate
  const video = card.getByTestId("candidate-video");
  await expect(video).toHaveCount(1);
  await expect
    .poll(async () => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 })
    .toBeGreaterThan(0);
  // 4. Use as Shot Clip (explicit) → refresh → the same Shot Clip
  await card.getByTestId("use-as-shot-clip").click();
  await expect(card.getByTestId("use-as-shot-clip")).toHaveText("Current Shot Clip", { timeout: 30_000 });
  const attempt = await card.getAttribute("data-attempt");
  await page.goto(animateUrl);
  const current = page.getByTestId("shot-clip-current");
  await expect(current).toHaveAttribute("data-attempt", attempt!);
  await page.reload();
  await expect(current).toHaveAttribute("data-attempt", attempt!);
  // 5. Generate Alternative with a motion note → a new candidate; the Shot Clip is unchanged
  const entry = page.locator(`[data-testid="shot-clip-candidate"][data-attempt="${attempt}"]`);
  await entry.getByLabel("Alternative motion").fill("Less movement. Yumeko only glances toward Sean.");
  await entry.getByTestId("generate-alternative").click();
  await page.waitForURL(/\/candidates\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(page.getByTestId("set-rollup")).toContainText("1/1 completed", { timeout: 120_000 });
  await page.goto(animateUrl);
  await expect(page.getByTestId("shot-clip-candidate")).toHaveCount(2);
  await expect(current).toHaveAttribute("data-attempt", attempt!);
  await expect(page.getByTestId("shot-clip-candidates")).toContainText(
    "Less movement. Yumeko only glances toward Sean.",
  );
  // 6. an upstream input changes (a new S5 direction is applied): the clip stays, marked for review
  await page.goto(`${EP}/shots/${shot3A.id}/direct`);
  await page.getByLabel("Direction note").fill("handheld");
  await page.getByTestId("dir-direct").click();
  await page.waitForURL(/\/direct\?proposal=/, { timeout: 30_000 });
  await expect
    .poll(async () => (await page.reload(), page.getByTestId("dir-status").getAttribute("data-status")), {
      timeout: 60_000,
      intervals: [1000],
    })
    .toBe("ready");
  await page.getByTestId("dir-apply").click();
  await expect(page.getByTestId("dir-applied")).toBeVisible({ timeout: 30_000 });
  await page.goto(animateUrl);
  await expect(current).toHaveAttribute("data-attempt", attempt!);
  await expect(current.getByTestId("shot-clip-stale")).toContainText("Needs review");
  await expect(current.getByTestId("shot-clip-video")).toHaveCount(1); // still playable history
});

test("Q — Sequence + Animatic: 3A/3B Shot Clips, 3C Production Frame; reorder, play, scrub, reset; clip replacement; Needs review", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const shotUrlOf = async (code: string) => {
    await page.goto(`${EP}/shots`);
    await page.getByRole("link", { name: code, exact: true }).first().click();
    await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
    return page.url().split("?")[0]!;
  };
  /** The existing Production Frame flow: free mock still → production conform → Use as Production Frame. */
  /** A Shot from the S4 plan carries Yumeko without a Look: assign her Episode Look in the existing Character section. */
  const seed = buildSeedProject();
  const yumeko = seed.characters.find((c) => c.name === "Yumeko")!;
  const assignLook = async (shotUrl: string) => {
    await page.goto(`${shotUrl}?section=character`);
    const look = page.locator(`select[name="look:${yumeko.id}"]`);
    if (await look.inputValue()) return;
    const options = await look
      .locator("option")
      .evaluateAll((os) =>
        os.map((o) => ({ value: (o as HTMLOptionElement).value, label: o.textContent ?? "" })),
      );
    await look.selectOption(options.find((o) => o.label.includes("Formal Black"))!.value);
    await page.getByRole("button", { name: "Save characters" }).click();
    await expect
      .poll(async () => (await page.goto(`${shotUrl}?section=character`), look.inputValue()), {
        timeout: 30_000,
        intervals: [1000],
      })
      .not.toBe("");
  };
  /**
   * A Shot from the S4 plan is a draft: complete it through its existing sections, as a creator would (Look, a 5 s
   * manual duration, the previous Shot, weather, continuity / performance approval). The preflight is unchanged.
   */
  const prepareShot = async (shotUrl: string, previousCode: string) => {
    await assignLook(shotUrl);
    await page.goto(`${shotUrl}?section=story`);
    await page.locator('select[name="durationMode"]').selectOption("manual");
    await page.locator('input[name="targetDurationMs"]').fill("5");
    await page.getByRole("button", { name: "Save story" }).click();
    await expect
      .poll(
        async () => (
          await page.goto(`${shotUrl}?section=story`),
          page.locator('input[name="targetDurationMs"]').inputValue()
        ),
        { timeout: 30_000, intervals: [1000] },
      )
      .toBe("5");
    await page.goto(`${shotUrl}?section=continuity`);
    const previous = page.locator('select[name="continuity.previousShotId"]');
    const options = await previous
      .locator("option")
      .evaluateAll((os) =>
        os.map((o) => ({ value: (o as HTMLOptionElement).value, label: o.textContent ?? "" })),
      );
    await previous.selectOption(options.find((o) => o.label.startsWith(`${previousCode} —`))!.value);
    if (!(await page.locator('input[name="continuity.weather"]').inputValue()))
      await page.locator('input[name="continuity.weather"]').fill("Clear night");
    await page.getByRole("button", { name: "Save continuity" }).click();
    await expect
      .poll(async () => (await page.goto(`${shotUrl}?section=continuity`), previous.inputValue()), {
        timeout: 30_000,
        intervals: [1000],
      })
      .not.toBe("");
    for (const [section, label] of [
      ["continuity", "Continuity approved"],
      ["performance", "Performance approved"],
    ] as const) {
      await page.goto(`${shotUrl}?section=${section}`);
      const gate = page.locator("form").filter({ hasText: label });
      const button = gate.getByRole("button", { name: "Approve", exact: true });
      if (await button.count()) {
        await button.click();
        await expect(gate.getByRole("button", { name: /Approved ✓/ })).toBeVisible({ timeout: 30_000 });
      }
    }
  };
  /** S5: Direct with Prism (the free test director) → Apply — the camera and blocking a Production Frame depicts. */
  const direct = async (shotUrl: string, note?: string) => {
    await page.goto(`${shotUrl}/direct`);
    if (note) await page.getByLabel("Direction note").fill(note);
    await page.getByTestId("dir-direct").click();
    await page.waitForURL(/\/direct\?proposal=/, { timeout: 30_000 });
    await expect
      .poll(async () => (await page.reload(), page.getByTestId("dir-status").getAttribute("data-status")), {
        timeout: 60_000,
        intervals: [1000],
      })
      .toBe("ready");
    await page.getByTestId("dir-apply").click();
    await expect(page.getByTestId("dir-applied")).toBeVisible({ timeout: 30_000 });
  };
  const productionFrame = async (shotUrl: string) => {
    await page.goto(`${shotUrl}?section=production_frame`);
    const stills = page.getByTestId("shot-generated-still");
    const newest = async () =>
      (await stills.count()) ? await stills.first().getAttribute("data-attempt") : null;
    const before = await newest();
    await page.getByTestId("shot-generate-image").click();
    await page.waitForURL(/\/candidates\/[0-9a-f-]{36}/, { timeout: 60_000 });
    await expect
      .poll(async () => (await page.goto(`${shotUrl}?section=production_frame`), newest()), {
        timeout: 120_000,
        intervals: [2000],
      })
      .not.toBe(before);
    const attempt = await stills.first().getAttribute("data-attempt");
    const fresh = page.locator(`[data-testid="shot-generated-still"][data-attempt="${attempt}"]`);
    // a frame that does not match the Shot's aspect ratio goes through the existing production conform first
    if (await fresh.getByTestId("shot-create-conform").count())
      await fresh.getByTestId("shot-create-conform").click();
    await expect
      .poll(
        async () => (
          await page.goto(`${shotUrl}?section=production_frame`),
          fresh.getByTestId("shot-use-as-production-frame").count()
        ),
        { timeout: 60_000, intervals: [1500] },
      )
      .toBe(1);
    await fresh.getByTestId("shot-use-as-production-frame").click();
    await expect
      .poll(
        async () => (
          await page.goto(`${shotUrl}?section=production_frame`),
          page.locator('[data-testid="shot-generated-still"][data-current="true"]').count()
        ),
        { timeout: 60_000, intervals: [1500] },
      )
      .toBe(1);
  };
  /** V1: animate the canonical frame with the free mock model and Use as Shot Clip. */
  const shotClip = async (shotUrl: string) => {
    await page.goto(`${shotUrl}?section=animate`);
    const panel = page.getByTestId("animate-panel");
    await expect(panel).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
    await panel
      .locator('[data-testid="model-row"][data-model="mock-video-1"]')
      .getByTestId("model-pick")
      .check();
    await panel.getByTestId("ack-all").check();
    await panel.getByTestId("create-candidate-set").click();
    await page.waitForURL(/\/candidates\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByTestId("set-rollup")).toContainText("1/1 completed", { timeout: 120_000 });
    const card = page.locator('[data-testid="candidate-card"][data-model="mock-video-1"]');
    await card.getByTestId("use-as-shot-clip").click();
    await expect(card.getByTestId("use-as-shot-clip")).toHaveText("Current Shot Clip", { timeout: 30_000 });
  };
  // ── prepare: 3A has its Shot Clip (story P); 3B gets a frame + clip; 3C a canonical Production Frame only ──
  const url3B = await shotUrlOf("3B");
  await prepareShot(url3B, "3A");
  await productionFrame(url3B);
  await shotClip(url3B);
  const url3C = await shotUrlOf("3C");
  await direct(url3C);
  await prepareShot(url3C, "3B");
  await productionFrame(url3C);

  // ── the Episode Sequence (the Edit tab): created from the Episode's Shots, story order ──
  await page.goto(`${EP}/edit`);
  await page.getByTestId("create-episode-edit").click();
  await expect(page.getByTestId("episode-edit-persisted")).toBeVisible({ timeout: 30_000 });
  const item = (code: string) => page.locator(`[data-testid="edit-item"][data-shot-code="${code}"]`);
  await expect(item("3A").getByTestId("sequence-line")).toContainText("3A — Shot Clip");
  await expect(item("3B").getByTestId("sequence-line")).toContainText("3B — Shot Clip");
  await expect(item("3C").getByTestId("sequence-line")).toContainText("3C — Production Frame");
  const order = async () =>
    (
      await page
        .locator('[data-testid="edit-item"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-shot-code")))
    ).filter((c) => /^3[ABC]$/.test(c ?? ""));
  expect(await order()).toEqual(["3A", "3B", "3C"]);
  const revision = async () => page.getByTestId("edit-revision").innerText();

  // ── reorder 3B / 3C ──
  let rev = await revision();
  await item("3C").getByRole("button", { name: "Move 3C up" }).click();
  await expect.poll(revision, { timeout: 30_000 }).not.toBe(rev);
  expect(await order()).toEqual(["3A", "3C", "3B"]);
  await expect(page.getByTestId("reset-story-order")).toHaveText("Reset to story order");

  // ── Play Animatic: the player follows the NEW order; pause; scrub ──
  const player = page.getByTestId("edit-player");
  const seekTo = (ms: number) =>
    page.getByTestId("player-seek").evaluate((el, v) => {
      const input = el as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(v));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, Math.round(ms));
  const startOf = async (code: string) => Number(await item(code).getAttribute("data-start-ms"));
  await page.getByTestId("play-animatic").click();
  await expect.poll(async () => player.getAttribute("data-item-id"), { timeout: 30_000 }).not.toBe("");
  expect(await startOf("3C")).toBeLessThan(await startOf("3B"));
  await seekTo((await startOf("3A")) + 10);
  await expect(player).toHaveAttribute("data-kind", "video");
  await seekTo((await startOf("3C")) + 10);
  await expect(player).toHaveAttribute("data-kind", "production_frame");
  await seekTo((await startOf("3B")) + 10);
  await expect(player).toHaveAttribute("data-kind", "video");
  await page.getByTestId("player-play").click();
  await expect(player).toHaveAttribute("data-playing", "true");
  await page.getByTestId("player-play").click();
  await expect(player).toHaveAttribute("data-playing", "false");
  await page.getByTestId("player-next").click();
  await expect(player).not.toHaveAttribute("data-item-id", (await item("3B").getAttribute("data-item-id"))!);

  // ── reset to story order ──
  rev = await revision();
  await page.getByTestId("reset-story-order").click();
  await expect.poll(revision, { timeout: 30_000 }).not.toBe(rev);
  expect(await order()).toEqual(["3A", "3B", "3C"]);
  await expect(page.getByTestId("reset-story-order")).toHaveText("In story order");

  // ── replace 3A's selected Shot Clip (V1, confirmed) → the Sequence surfaces it → one explicit re-pin ──
  const pinned = await item("3A").locator("video").first().getAttribute("src");
  const url3A = await shotUrlOf("3A");
  await page.goto(`${url3A}?section=animate`);
  const selectedBefore = await page.getByTestId("shot-clip-current").getAttribute("data-attempt");
  // story P's alternative (same canonical frame, motion note) becomes the Shot Clip, with the replace confirmation
  const alternative = page
    .locator('[data-testid="shot-clip-candidate"]')
    .filter({ has: page.getByTestId("use-as-shot-clip") })
    .first();
  await alternative.getByTestId("confirm-replace-clip").check();
  await alternative.getByTestId("use-as-shot-clip").click();
  await expect
    .poll(
      async () => (
        await page.goto(`${url3A}?section=animate`),
        page.getByTestId("shot-clip-current").getAttribute("data-attempt")
      ),
      { timeout: 30_000, intervals: [1000] },
    )
    .not.toBe(selectedBefore);
  await page.goto(`${EP}/edit`);
  await expect(item("3A").getByTestId("item-badges")).toContainText("Replacement available");
  await expect(item("3A").locator("video").first()).toHaveAttribute("src", pinned!); // pinned until told otherwise
  rev = await revision();
  await page.getByTestId("use-current-media").click();
  await expect.poll(revision, { timeout: 30_000 }).not.toBe(rev);
  await expect(item("3A").locator("video").first()).not.toHaveAttribute("src", pinned!);
  await expect(page.getByTestId("use-current-media")).toHaveText("Using current Shot Clips and frames");

  // ── an upstream direction change makes 3B's selected clip Needs review: it still plays, with the warning ──
  await direct(url3B, "more intimate");
  await page.goto(`${EP}/edit`);
  await expect(item("3B").getByTestId("item-badges")).toContainText("Needs review");
  await seekTo((await startOf("3B")) + 10);
  await expect(player).toHaveAttribute("data-kind", "video");
});

test("R — Episode Edit: trims, still hold, opening title, cross dissolve, reorder, preview, saved revisions", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const OPENING = "お嬢様、僕と結婚してください。";
  const item = (code: string) => page.locator(`[data-testid="edit-item"][data-shot-code="${code}"]`);
  const revision = async () => page.getByTestId("edit-revision").innerText();
  const changed = async (action: () => Promise<void>) => {
    const before = await revision();
    await action();
    await expect.poll(revision, { timeout: 30_000 }).not.toBe(before);
  };
  const player = page.getByTestId("edit-player");
  const seekTo = (ms: number) =>
    page.getByTestId("player-seek").evaluate((el, v) => {
      const input = el as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(v));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, Math.round(ms));
  const editor = (code: string) => item(code).getByTestId("item-editor");
  const open = async (code: string) => {
    if (!(await editor(code).evaluate((d) => (d as HTMLDetailsElement).open)))
      await editor(code).locator("summary").click();
  };
  /** Trims a Shot Clip by 0.3 s at the head and 0.2 s at the tail (staying long enough for its placed takes). */
  const trim = async (code: string) => {
    await open(code);
    const out = Number(await editor(code).getByTestId("trim-out").inputValue());
    const inS = (Number(await editor(code).getByTestId("trim-in").inputValue()) + 0.3).toFixed(1);
    const outS = (out - 0.2).toFixed(1);
    await editor(code).getByTestId("trim-in").fill(inS);
    await editor(code).getByTestId("trim-out").fill(outS);
    await changed(() => editor(code).getByTestId("apply-trim").click());
    await expect(item(code)).toHaveAttribute(
      "data-duration-ms",
      String(Math.round((Number(outS) - Number(inS)) * 1000)),
    );
    return { inMs: Math.round(Number(inS) * 1000), outMs: Math.round(Number(outS) * 1000) };
  };

  // ── the V2 rough cut from story Q ──
  await page.goto(`${EP}/edit`);
  await expect(page.getByTestId("episode-edit-persisted")).toBeVisible();
  await expect(item("3A").getByTestId("sequence-line")).toContainText("3A — Shot Clip");
  await expect(item("3B").getByTestId("sequence-line")).toContainText("3B — Shot Clip");
  await expect(item("3C").getByTestId("sequence-line")).toContainText("3C — Production Frame");
  await expect(page.getByTestId("edit-saved-state")).toContainText("Not saved yet");
  const pinned3A = await item("3A").locator("video").first().getAttribute("src");

  // the Production Frame of 3C before editing (verified unchanged at the end)
  const url3C = await (async () => {
    await page.goto(`${EP}/shots`);
    await page.getByRole("link", { name: "3C", exact: true }).first().click();
    await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
    return page.url().split("?")[0]!;
  })();
  await page.goto(`${url3C}?section=production_frame`);
  const pf3C = await page
    .locator('[data-testid="shot-generated-still"][data-current="true"]')
    .getAttribute("data-attempt");
  await page.goto(`${EP}/edit`);

  // ── trim 3A and 3B; hold 3C ──
  const t3A = await trim("3A");
  await trim("3B");
  await open("3C");
  await editor("3C").getByTestId("hold-duration").fill("4.5");
  await changed(() => editor("3C").getByTestId("apply-hold").click());
  await expect(item("3C")).toHaveAttribute("data-duration-ms", "4500");

  // ── opening title ──
  const opening = page.locator('[data-testid="title-slot"][data-placement="opening"]');
  await opening.getByTestId("title-text").fill(OPENING);
  await opening.getByTestId("title-subtitle").fill("Episode 1 — The Arrangement");
  await opening.getByTestId("title-duration").fill("4");
  await changed(() => opening.getByTestId("save-title").click());
  await expect(opening).toHaveAttribute("data-exists", "true");
  await expect(page.locator('[data-testid="edit-item"]').first()).toHaveAttribute("data-start-ms", "4000");

  // ── reorder: 3C before 3B ──
  await changed(() => item("3C").getByRole("button", { name: "Move 3C up" }).click());
  const order = async () =>
    (
      await page
        .locator('[data-testid="edit-item"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-shot-code")))
    ).filter((c) => /^3[ABC]$/.test(c ?? ""));
  expect(await order()).toEqual(["3A", "3C", "3B"]);

  // ── a cross dissolve 3C → 3B ──
  const totalBefore = Number(await player.getAttribute("data-total-ms"));
  const tf = item("3B").getByTestId("transition-form");
  await tf.getByTestId("transition-kind").selectOption("dissolve");
  await tf.getByTestId("transition-duration").fill("0.75");
  await changed(() => tf.getByTestId("apply-transition").click());
  await expect(item("3B")).toHaveAttribute("data-transition", "dissolve");
  await expect(item("3B").getByTestId("transition-label")).toHaveText("Cross dissolve 0.75 s");
  await expect(player).toHaveAttribute("data-total-ms", String(totalBefore - 750));
  // the preview and the render manifest describe the same timeline
  await expect(page.getByTestId("render-manifest")).toHaveAttribute(
    "data-total-ms",
    String(totalBefore - 750),
  );
  const start3B = Number(await item("3B").getAttribute("data-start-ms"));
  const start3C = Number(await item("3C").getAttribute("data-start-ms"));
  expect(start3B).toBe(start3C + 4500 - 750);

  // ── preview from the beginning: the title, then the cut; scrub into the dissolve ──
  await page.getByTestId("player-restart").click();
  await expect(player).toHaveAttribute("data-segment", "title");
  await expect(page.getByTestId("player-title-text")).toHaveText(OPENING);
  await expect(page.getByTestId("player-title-subtitle")).toHaveText("Episode 1 — The Arrangement");
  await page.getByTestId("player-play").click();
  await expect(player).toHaveAttribute("data-playing", "true");
  await page.getByTestId("player-play").click();
  await expect(player).toHaveAttribute("data-playing", "false");
  await seekTo(start3B + 375); // halfway through the dissolve
  await expect(player).toHaveAttribute("data-item-id", (await item("3B").getAttribute("data-item-id"))!);
  await expect(player).toHaveAttribute(
    "data-outgoing-item-id",
    (await item("3C").getAttribute("data-item-id"))!,
  );
  await expect(player).toHaveAttribute("data-mix", "0.50");
  // selecting an item moves the playhead to it
  await item("3A").getByTestId("seek-item").click();
  await expect(player).toHaveAttribute("data-item-id", (await item("3A").getAttribute("data-item-id"))!);
  await expect(player).toHaveAttribute("data-time-ms", (await item("3A").getAttribute("data-start-ms"))!);
  await expect(player).toHaveAttribute("data-video-src-ms", String(t3A.inMs)); // the trim's in point

  // ── save revision → refresh → the same state ──
  await page.getByTestId("revision-label").fill("A — first cut");
  await page.getByTestId("save-revision").click();
  await expect(page.getByTestId("edit-saved-state")).toHaveAttribute("data-saved-as", /^\d+$/, {
    timeout: 30_000,
  });
  const savedA = await page.getByTestId("edit-saved-state").getAttribute("data-saved-as");
  const revA = await revision();
  const fingerprintA = await page.getByTestId("render-manifest").getAttribute("data-state-fingerprint");
  await page.reload();
  expect(await revision()).toBe(revA);
  await expect(page.getByTestId("edit-saved-state")).toHaveAttribute("data-saved-as", savedA!);
  await expect(page.getByTestId("render-manifest")).toHaveAttribute("data-state-fingerprint", fingerprintA!);
  expect(await order()).toEqual(["3A", "3C", "3B"]);
  await expect(item("3B")).toHaveAttribute("data-transition", "dissolve");
  await expect(item("3C")).toHaveAttribute("data-duration-ms", "4500");
  await expect(opening).toHaveAttribute("data-exists", "true");
  await expect(item("3A").locator("video").first()).toHaveAttribute("src", pinned3A!);

  // ── the source Shot Clip is still the full clip on the Shot page; the Production Frame is unchanged ──
  const url3A = await (async () => {
    await page.goto(`${EP}/shots`);
    await page.getByRole("link", { name: "3A", exact: true }).first().click();
    await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
    return page.url().split("?")[0]!;
  })();
  await page.goto(`${url3A}?section=animate`);
  const shotVideo = page.getByTestId("shot-clip-current").getByTestId("shot-clip-video");
  await expect(shotVideo).toHaveAttribute("src", pinned3A!); // the same immutable Asset the edit pins
  await expect
    .poll(
      async () =>
        shotVideo.evaluate((v: HTMLVideoElement) => (Number.isFinite(v.duration) ? v.duration * 1000 : -1)),
      {
        timeout: 30_000,
      },
    )
    .toBeGreaterThanOrEqual(t3A.outMs); // the full clip (the edit plays only its trimmed interval)
  await page.goto(`${url3C}?section=production_frame`);
  await expect(page.locator('[data-testid="shot-generated-still"][data-current="true"]')).toHaveAttribute(
    "data-attempt",
    pf3C!,
  );

  // ── another revision, then restore A (a NEW revision; A itself never changes) ──
  await page.goto(`${EP}/edit`);
  await opening.getByTestId("title-duration").fill("3");
  await changed(() => opening.getByTestId("save-title").click());
  await expect(page.getByTestId("edit-saved-state")).toContainText("Unsaved changes");
  await page.getByTestId("revision-label").fill("B — shorter title");
  await page.getByTestId("save-revision").click();
  const savedB = String(Number(savedA) + 1);
  await expect(page.getByTestId("edit-saved-state")).toHaveAttribute("data-saved-as", savedB, {
    timeout: 30_000,
  });
  await expect(page.locator(`[data-testid="saved-revision"][data-number="${savedB}"]`)).toHaveAttribute(
    "data-current",
    "true",
  );
  const rowA = page.locator(`[data-testid="saved-revision"][data-number="${savedA}"]`);
  await expect(rowA).toHaveAttribute("data-current", "false");
  await changed(() => rowA.getByTestId("restore-revision").click());
  const savedC = String(Number(savedA) + 2);
  await expect(page.getByTestId("edit-saved-state")).toHaveAttribute("data-saved-as", savedC);
  await expect(page.locator(`[data-testid="saved-revision"][data-number="${savedC}"]`)).toContainText(
    `restored from #${savedA}`,
  );
  await expect(rowA).toHaveAttribute("data-current", "true"); // the same state as A again
  await expect(opening.getByTestId("title-duration")).toHaveValue("4");
  await expect(page.getByTestId("render-manifest")).toHaveAttribute("data-state-fingerprint", fingerprintA!);
});

test("S — Render Episode: saved revision → segmented render → Final MP4 → play / download → a newer revision renders too", async ({
  page,
}) => {
  test.setTimeout(900_000);
  page.on("dialog", (d) => void d.accept()); // "Remove … from the edit?" confirmations
  const item = (code: string) => page.locator(`[data-testid="edit-item"][data-shot-code="${code}"]`);
  const revision = async () => page.getByTestId("edit-revision").innerText();
  const changed = async (action: () => Promise<void>) => {
    const before = await revision();
    await action();
    await expect.poll(revision, { timeout: 30_000 }).not.toBe(before);
  };
  const renderRow = (n: number) => page.locator(`[data-testid="episode-render"][data-number="${n}"]`);

  // ── the Episode Edit from stories Q / R; a FINAL render needs every item to have a picture ──
  await page.goto(`${EP}/edit`);
  await expect(page.getByTestId("render-panel")).toBeVisible();
  // the Shot of the previous Scene (just before 3A) gets a real picture the creator's way: a Production Frame uploaded
  // on its Shot page, then "Use current Shot Clips and frames" pins it in the edit (the seed's frames are placeholders)
  const order = await page
    .locator('[data-testid="edit-item"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-shot-code")!));
  const otherCode = order
    .slice(0, order.indexOf("3A"))
    .reverse()
    .find((c) => !/^3/.test(c))!;
  expect(otherCode).toBeTruthy();
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: otherCode, exact: true }).first().click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  const otherUrl = page.url().split("?")[0]!;
  await page.goto(`${otherUrl}?section=production_frame`);
  await page.getByTestId("pf-upload-file").setInputFiles({
    name: "other-scene-frame.png",
    mimeType: "image/png",
    buffer: Buffer.from(stillPng("0xc0a030", 1912, 800)),
  });
  await page.getByTestId("pf-upload-submit").click();
  await page.goto(`${EP}/edit`);
  await expect
    .poll(async () => (await page.reload(), page.getByTestId("use-current-media").isEnabled()), {
      timeout: 30_000,
    })
    .toBe(true);
  await changed(() => page.getByTestId("use-current-media").click());
  await expect(item(otherCode).first().getByTestId("sequence-line")).toContainText("Production Frame");
  for (let i = 0; i < 40; i++) {
    const missing = (await page.getByTestId("render-fact-missing").innerText()).trim();
    if (missing === "None") break;
    await expect(page.getByTestId("render-blocked")).toContainText("with missing media");
    await expect(page.getByTestId("render-episode")).toBeDisabled();
    const code = missing.split(",")[0]!.trim();
    await changed(() => item(code).first().getByTestId("remove-item").click());
  }
  await expect(page.getByTestId("render-fact-missing")).toHaveText("None");
  for (const code of ["3A", "3B", "3C"]) await expect(item(code)).toHaveCount(1);

  // ── save the current revision; the render facts ──
  if ((await page.getByTestId("edit-saved-state").getAttribute("data-saved-as")) === "") {
    await expect(page.getByTestId("render-blocked")).toHaveText(
      "Save this Edit revision before rendering it.",
    );
    await page.getByTestId("revision-label").fill("For the final render");
    await page.getByTestId("save-revision").click();
    await expect(page.getByTestId("edit-saved-state")).toHaveAttribute("data-saved-as", /^\d+$/, {
      timeout: 30_000,
    });
  }
  const savedA = (await page.getByTestId("edit-saved-state").getAttribute("data-saved-as"))!;
  await expect(page.getByTestId("render-fact-revision")).toContainText(`Saved revision #${savedA}`);
  await expect(page.getByTestId("render-fact-target")).toContainText("1920×804");
  await expect(page.getByTestId("render-fact-target")).toContainText("24 fps");
  await expect(page.getByTestId("render-fact-cost")).toContainText("$0.00");
  const totalMs = Number(await page.getByTestId("render-fact-duration").getAttribute("data-ms"));
  expect(totalMs).toBe(Number(await page.getByTestId("edit-player").getAttribute("data-total-ms"))); // = the preview
  const rows = await page.locator('[data-testid="edit-item"]').evaluateAll((els) =>
    els.map((e) => ({
      code: e.getAttribute("data-shot-code")!,
      start: Number(e.getAttribute("data-start-ms")),
      duration: Number(e.getAttribute("data-duration-ms")),
      // the row's own thumbnail (a still item shows its image; a clip shows a video)
      image: e.firstElementChild?.querySelector("img")?.getAttribute("src") ?? null,
    })),
  );

  // ── Render Episode → Queued / Rendering / … → Completed ──
  await page.getByTestId("render-episode").click();
  await expect(renderRow(1)).toBeVisible({ timeout: 30_000 });
  await expect(renderRow(1).getByTestId("render-revision")).toHaveText(
    `Rendered from Edit revision #${savedA}`,
  );
  await expect(renderRow(1)).toHaveAttribute("data-status", "completed", { timeout: 600_000 });
  const out = renderRow(1).getByTestId("render-output");
  await expect(out.getByTestId("render-output-resolution")).toHaveText("1920×804");

  // ── Play Final (when this browser decodes H.264 / AAC: Chromium builds without proprietary codecs cannot) ──
  const video = renderRow(1).getByTestId("render-video");
  await expect(video).toHaveAttribute("src", /^\/api\/assets\/[0-9a-f-]{36}$/);
  if (
    await page.evaluate(() =>
      document.createElement("video").canPlayType('video/mp4; codecs="avc1.64002a, mp4a.40.2"'),
    )
  ) {
    await video.evaluate((v: HTMLVideoElement) => v.play());
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000 })
      .toBeGreaterThan(0);
    await video.evaluate((v: HTMLVideoElement) => v.pause());
    expect(
      Math.abs((await video.evaluate((v: HTMLVideoElement) => v.duration)) * 1000 - totalMs),
    ).toBeLessThan(100);
  }

  // ── Export / Download (the owner, through the private asset route) → verify the real file ──
  const download = renderRow(1).getByTestId("render-download");
  await expect(download).toHaveText("Download ojousama-episode-1-the-arrangement.mp4");
  const res = await page.request.get((await download.getAttribute("href"))!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toContain("attachment");
  expect(res.headers()["content-disposition"]).toContain("ojousama-episode-1-the-arrangement.mp4");
  const bytes = new Uint8Array(await res.body());
  const lab = new MediaLab(1920, 804);
  try {
    const file = lab.write(bytes, "mp4");
    const probe = await new FfmpegEpisodeRenderer().probe(lab.dir, file.split(/[\\/]/).pop()!);
    expect(probe).toMatchObject({
      videoCodec: "h264",
      width: 1920,
      height: 804,
      frameRate: "24/1",
      pixFmt: "yuv420p",
    });
    expect(probe.frames).toBe(Math.floor((totalMs * 24) / 1000)); // = the V3 timeline (frame-exact)
    // the opening title is on screen first
    const black = lab.black();
    expect(lab.psnr(lab.frameAt(file, 1000), black)).toBeLessThan(45);
    // scrub through 3A / 3C / 3B and the other Scene's Shot: each is a real picture at its timeline place; a still
    // item IS its Production Frame
    const others = rows.filter((r) => r.code === otherCode);
    expect(others.length).toBe(1);
    for (const r of [...rows.filter((x) => ["3A", "3B", "3C"].includes(x.code)), others[0]!]) {
      const frame = lab.frameAt(file, r.start + Math.min(r.duration / 2, 1000));
      expect(lab.psnr(frame, black), r.code).toBeLessThan(45);
      if (r.image) {
        const img = await page.request.get(r.image);
        expect(
          lab.psnr(frame, lab.normalizedStill(new Uint8Array(await img.body()))),
          r.code,
        ).toBeGreaterThan(30);
      }
    }
  } finally {
    lab.dispose();
  }

  // ── a new Edit revision: the finished render belongs to the earlier one; render the new one; both remain ──
  const opening = page.locator('[data-testid="title-slot"][data-placement="opening"]');
  await opening.getByTestId("title-duration").fill("3");
  await changed(() => opening.getByTestId("save-title").click());
  await expect(renderRow(1).getByTestId("render-newer")).toHaveText("A newer Edit revision exists.");
  await expect(renderRow(1).getByTestId("render-revision")).toHaveText(
    `Rendered from Edit revision #${savedA}`,
  );
  await expect(page.getByTestId("render-episode")).toBeDisabled(); // unsaved changes
  await page.getByTestId("revision-label").fill("Shorter opening");
  await page.getByTestId("save-revision").click();
  await expect(page.getByTestId("edit-saved-state")).toHaveAttribute(
    "data-saved-as",
    String(Number(savedA) + 1),
    {
      timeout: 30_000,
    },
  );
  await page.getByTestId("render-episode").click();
  await expect(renderRow(2)).toHaveAttribute("data-status", "completed", { timeout: 600_000 });
  await expect(renderRow(2).getByTestId("render-revision")).toHaveText(
    `Rendered from Edit revision #${Number(savedA) + 1}`,
  );
  await expect(renderRow(1)).toHaveAttribute("data-status", "completed");
  await expect(renderRow(1).getByTestId("render-download")).toBeVisible();
  const d1 = Number(await renderRow(1).getByTestId("render-video").getAttribute("data-duration-ms"));
  const d2 = Number(await renderRow(2).getByTestId("render-video").getAttribute("data-duration-ms"));
  expect(d1 - d2).toBe(1000); // the opening title is 1 s shorter
});

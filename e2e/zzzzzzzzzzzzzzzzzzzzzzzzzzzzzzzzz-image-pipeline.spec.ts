import { expect, test, type Page } from "@playwright/test";
import { buildSeedProject } from "../src/data/seed";

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

import { crc32, deflateSync } from "node:zlib";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Phase 2G.4 Character Continuity Locks, memory mode, through the UI. NO provider spend, 3D set or GPU: the free mock
 * IMAGE model stands in for a provider (REAL IMAGE-MODEL CALLS: 0). Shot 4C (Yumeko, Sky-View Restaurant) runs after the
 * Location View spec, so its "Doorway" Location View is already selected (optional for this milestone).
 *
 *   Character Yumeko → new Look "Ivory Suit" + front / profile identity images + one Look image
 *   → Create Continuity Lock "Yumeko — Ivory Suit v1" (facts + 3 frozen images; no generation)
 *   Shot Prep 4C → assign Ivory Suit → choose the Lock → package v5 carries it by value
 *   → generate a FREE mock Production Frame candidate → the LOCKED images are labelled references → Use as PF
 *   → edit the master Look (wardrobe) → the locked Shot keeps its truth (PF fresh, package unchanged)
 *   → Lock v2 from the edited Look → switch → the Production Frame becomes stale
 */

const EP = "/projects/ojousama/episodes/ep-1";
const LOCK_V1 = "Yumeko — Ivory Suit v1";
const LOCK_V2 = "Yumeko — Ivory Suit v2";
test.describe.configure({ mode: "serial" });

/** A valid RGB PNG of the given size (a single flat colour). */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set(rgb, y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function openCharacter(page: Page, name: string) {
  await page.goto("/projects/ojousama/characters");
  const href = await page.getByRole("link", { name, exact: false }).first().getAttribute("href");
  await page.goto(href!);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(name);
  return page.url();
}

async function openShot(page: Page, code: string) {
  await page.goto(`${EP}/shots`);
  const href = await page.getByRole("link", { name: code, exact: true }).first().getAttribute("href");
  await page.goto(href!);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(code);
  return page.url().split("?")[0]!;
}

interface Pkg {
  version: number;
  characters: Array<{
    name: string;
    look: { name: string; wardrobe: string } | null;
    continuityLock?: { name: string };
  }>;
  references: {
    characterContinuity?: Array<{
      name: string;
      lockId: string;
      references: Array<{ role: string; identitySlot: string | null; assetId: string }>;
    }>;
  };
  assets: Record<string, Record<string, unknown>>;
  provenance: { parts: Record<string, string> };
}

async function packageOf(page: Page, request: APIRequestContext, shotUrl: string): Promise<Pkg> {
  await page.goto(`${shotUrl}?section=brief`);
  const href = await page.getByRole("link", { name: /Download brief/ }).getAttribute("href");
  return (await (await request.get(href!.replace("format=brief", "format=json"))).json()) as Pkg;
}

let characterUrl: string;
let shotUrl: string;
let setUrl: string;
let lockedParts: Record<string, string>;

test("Character: a new Look 'Ivory Suit', real identity images and a Look image (the editable library)", async ({
  page,
}) => {
  characterUrl = await openCharacter(page, "Yumeko");
  const newLook = page.locator("details", { has: page.locator("summary", { hasText: "+ New look" }) });
  await newLook.locator("summary").click();
  await newLook.locator('input[name="name"]').fill("Ivory Suit");
  await newLook.locator('textarea[name="wardrobe"]').fill("ivory tailored suit");
  await newLook.locator('input[name="hair"]').fill("low chignon");
  await newLook.locator('input[name="makeup"]').fill("soft matte");
  await newLook.getByRole("button", { name: "Create look" }).click();
  await expect(page.locator("summary", { hasText: "Ivory Suit" })).toBeVisible({ timeout: 15_000 });

  for (const [slot, rgb] of [
    ["front", [200, 170, 150]],
    ["profile", [180, 150, 130]],
  ] as const) {
    const card = page.getByTestId(`identity-slot-${slot}`);
    await card.getByTestId("identity-file").setInputFiles({
      name: `e2e-yumeko-${slot}.png`,
      mimeType: "image/png",
      buffer: png(300, 400, [...rgb]),
    });
    await card.getByTestId("identity-upload").click();
    await expect(card.locator("img")).toBeVisible({ timeout: 15_000 });
  }

  const ivory = page.locator("details", { has: page.locator("summary", { hasText: "Ivory Suit" }) });
  await ivory.locator("summary").click();
  await ivory.getByTestId("look-ref-file").setInputFiles({
    name: "e2e-ivory-suit.png",
    mimeType: "image/png",
    buffer: png(300, 400, [235, 230, 215]),
  });
  await ivory.getByTestId("look-ref-upload").click();
  await expect(ivory.getByTestId("look-ref-thumb")).toHaveCount(1, { timeout: 15_000 });
});

test("Create Continuity Lock 'Yumeko — Ivory Suit v1': facts + exactly the real images, no generation", async ({
  page,
}) => {
  await page.goto(characterUrl);
  await page.getByTestId("cl-look").selectOption({ label: "Ivory Suit" });
  await page.getByTestId("cl-name").fill(LOCK_V1);
  await page.getByTestId("cl-create").click();
  const card = page.getByTestId("continuity-lock-card").filter({ hasText: LOCK_V1 });
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  await expect(card).toContainText("Look: Ivory Suit");
  // truthful coverage: only the two real identity images (the seed's three-quarter / full-body are placeholders)
  await expect(card.getByTestId("continuity-lock-identity")).toHaveText("front, profile");
  await expect(card.getByTestId("continuity-lock-look-count")).toHaveText("1");
  await expect(card.getByTestId("continuity-lock-wardrobe")).toHaveText("ivory tailored suit");
  await expect(card.getByTestId("continuity-lock-thumb")).toHaveCount(3);
  for (const src of await card
    .getByTestId("continuity-lock-thumb")
    .evaluateAll((els) => els.map((e) => e.getAttribute("src"))))
    expect(src).toMatch(/^\/api\/assets\/[0-9a-f-]+$/); // the private asset route only
  await expect(
    page.getByText(/freezes the exact identity, wardrobe and appearance references/).first(),
  ).toBeVisible();
  await expect(card).not.toContainText(/GPU|COLMAP|splat|3D/i);
});

test("Shot Prep 4C: assign Ivory Suit, choose the Lock; the package (v5) carries it by value", async ({
  page,
  request,
}) => {
  shotUrl = await openShot(page, "4C");
  await page.goto(`${shotUrl}?section=character`);
  const lookSelect = page
    .locator('select[name^="look:"]')
    .filter({ has: page.locator("option", { hasText: "Ivory Suit" }) });
  await lookSelect.selectOption({ label: "Ivory Suit" });
  await page.getByRole("button", { name: "Save characters" }).click();
  await expect(page.getByText("Saved").first()).toBeVisible({ timeout: 15_000 });

  await page.goto(`${shotUrl}?section=look`);
  const cc = page.getByTestId("character-continuity");
  await expect(cc.getByTestId("cc-empty")).toContainText(
    "No Character Continuity Lock selected. Prism will use the Character's current IdentityRefs and Look.",
  );
  await cc.getByTestId("continuity-lock-card").filter({ hasText: LOCK_V1 }).getByTestId("cc-choose").click();
  await expect(cc.getByTestId("cc-selected")).toContainText(LOCK_V1, { timeout: 15_000 });

  const json = await packageOf(page, request, shotUrl);
  expect(json.version).toBe(5);
  const lock = json.references.characterContinuity?.[0];
  expect(lock?.name).toBe(LOCK_V1);
  expect(lock?.references.map((r) => [r.role, r.identitySlot])).toEqual([
    ["identity", "front"],
    ["identity", "profile"],
    ["look", null],
  ]);
  for (const r of lock!.references) expect(json.assets[r.assetId]).toBeTruthy();
  const yumeko = json.characters.find((c) => c.name === "Yumeko")!;
  expect(yumeko.look).toMatchObject({ name: "Ivory Suit", wardrobe: "ivory tailored suit" });
  expect(yumeko.continuityLock?.name).toBe(LOCK_V1);
  expect(JSON.stringify(json)).not.toMatch(/https?:\/\/[^"]*(token|sig)/);
});

test("Generate a FREE mock candidate: the LOCKED identity and Look images are labelled references", async ({
  page,
}) => {
  await page.goto(`${shotUrl}?section=production_frame`);
  const pf = page.getByTestId("production-frame-section");
  await pf.getByTestId("pf-generate-summary").click();
  const panel = pf.getByTestId("pf-candidates-panel");
  const refs = panel.getByTestId("pf-candidate-references");
  await expect(refs).toContainText(`Yumeko identity — front (Continuity Lock "${LOCK_V1}")`);
  await expect(refs).toContainText(`Yumeko identity — profile (Continuity Lock "${LOCK_V1}")`);
  await expect(refs).toContainText(`Yumeko Look "Ivory Suit" (Continuity Lock "${LOCK_V1}")`);
  const row = panel.locator('[data-testid="model-row"][data-model="mock-image-wide"]');
  await expect(row.getByTestId("model-cost")).toContainText("free");
  await row.getByTestId("model-pick").check();
  await panel.getByTestId("ack-all").check();
  await panel.getByTestId("create-candidate-set").click();

  await expect(page).toHaveURL(/\/candidates\/[0-9a-f-]+$/);
  setUrl = page.url();
  const card = page.locator('[data-testid="candidate-card"][data-model="mock-image-wide"]');
  await expect(card).toHaveAttribute("data-status", "succeeded", { timeout: 25_000 });
  await expect(card.getByTestId("candidate-references")).toContainText(
    `Yumeko identity — front (Continuity Lock "${LOCK_V1}")`,
  );
});

test("Use as Production Frame; then edit the MASTER Look: the locked Shot keeps its truth", async ({
  page,
  request,
}) => {
  await page.goto(setUrl);
  const card = page.locator('[data-testid="candidate-card"][data-model="mock-image-wide"]');
  await card.getByTestId("create-production-conform").click();
  await expect(card.getByTestId("use-as-pf")).toBeEnabled({ timeout: 30_000 });
  await card.getByTestId("use-as-pf").click();
  await expect(card.getByTestId("current-production-frame")).toBeVisible();
  await page.goto(`${shotUrl}?section=production_frame`);
  await expect(page.getByTestId("pf-selected")).toHaveAttribute("data-freshness", "fresh");
  lockedParts = (await packageOf(page, request, shotUrl)).provenance.parts;

  // the master Look changes (the editable source library)
  await page.goto(characterUrl);
  const ivory = page.locator("details", { has: page.locator("summary", { hasText: "Ivory Suit" }) });
  await ivory.locator("summary").click();
  await ivory.locator('textarea[name="wardrobe"]').fill("black evening gown");
  await ivory.getByRole("button", { name: "Save look" }).click();
  await expect(ivory.locator('textarea[name="wardrobe"]')).toHaveValue("black evening gown");
  await page.reload();
  await expect(
    page
      .locator("details", { has: page.locator("summary", { hasText: "Ivory Suit" }) })
      .locator('textarea[name="wardrobe"]'),
  ).toHaveValue("black evening gown");

  // the locked Shot: same truth, frame still fresh, package still the Lock's wardrobe
  await page.goto(`${shotUrl}?section=production_frame`);
  await expect(page.getByTestId("pf-selected")).toHaveAttribute("data-freshness", "fresh");
  const json = await packageOf(page, request, shotUrl);
  expect(json.characters.find((c) => c.name === "Yumeko")!.look?.wardrobe).toBe("ivory tailored suit");
  expect(json.provenance.parts.characters).toBe(lockedParts.characters);
  expect(json.provenance.parts.looks).toBe(lockedParts.looks);
});

test("Lock v2 from the edited Look; switching the Shot to it makes the Production Frame stale", async ({
  page,
  request,
}) => {
  await page.goto(characterUrl);
  await page.getByTestId("cl-look").selectOption({ label: "Ivory Suit" });
  await page.getByTestId("cl-name").fill(LOCK_V2);
  await page.getByTestId("cl-create").click();
  await expect(page.getByTestId("continuity-lock-card").filter({ hasText: LOCK_V2 })).toHaveCount(1, {
    timeout: 15_000,
  });
  // both versions stay: grouped under the Look, v1 unchanged
  const v1 = page.getByTestId("continuity-lock-card").filter({ hasText: LOCK_V1 });
  await expect(v1.getByTestId("continuity-lock-wardrobe")).toHaveText("ivory tailored suit");

  await page.goto(`${shotUrl}?section=look`);
  const cc = page.getByTestId("character-continuity");
  await expect(cc.getByTestId("cc-selected")).toContainText(LOCK_V1);
  await cc.getByTestId("continuity-lock-card").filter({ hasText: LOCK_V2 }).getByTestId("cc-choose").click();
  await expect(cc.getByTestId("cc-selected")).toContainText(LOCK_V2, { timeout: 15_000 });

  await page.goto(`${shotUrl}?section=production_frame`);
  await expect(page.getByTestId("pf-selected")).toHaveAttribute("data-freshness", "stale");
  const json = await packageOf(page, request, shotUrl);
  expect(json.characters.find((c) => c.name === "Yumeko")!.look?.wardrobe).toBe("black evening gown");
  expect(json.provenance.parts.looks).not.toBe(lockedParts.looks);
});

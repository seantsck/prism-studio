import { crc32, deflateSync } from "node:zlib";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * Phase 2H Image-to-Video from the canonical Production Frame, memory mode, through the UI. MockProvider ONLY
 * (REAL RUNWAY / OPENAI / GEMINI CALLS: 0, no GPU, no 3D). Runs after every other memory spec.
 *
 * Shot 2C (Grand Celeste Hotel Canopy, 3.5 s, 2.39:1; no other spec edits it):
 *   no Production Frame → Animate blocked
 *   Location View A + PF v1 (upload) → Animate: compare video models (exact first frame, durations, canvas, audio,
 *   cost; a text-to-video-only model INCOMPATIBLE; nothing pre-selected)
 *   → set of 2 free mock clips → worker → board shows "Animated from Production Frame v1", exact first-frame
 *   provenance, a required delivery conform → Best ≠ final approval → conform → Sequence shows the animation state
 *   PF v2 → v1 clips stale, new Animate starts from v2
 *   Location View B → PF stale → Animate blocked, clips stale; the Sequence still shows the canonical STILL
 * Shot 4C, self-contained (no other spec needed): this spec's own Look "2H Linen Suit" and facts-only Lock v1 → an
 * uploaded fresh PF → animate → master Look edit keeps the clip fresh → Lock v2 from the edited Look → switch → clip
 * stale, Animate blocked. Afterwards 4C's Look assignment, Lock selection, selected Production Frame and continuity
 * approval are restored (see afterAll).
 */

const EP = "/projects/ojousama/episodes/ep-1";
const PLACE = "Grand Celeste Hotel Canopy";
// Shot 4C's Look and Locks are this spec's own (never the 2G.4 spec's "Ivory Suit"): it runs alone or after it
const LOOK = "2H Linen Suit";
const LOCK_V1 = "Yumeko — 2H Linen Suit v1";
const LOCK_V2 = "Yumeko — 2H Linen Suit v2";
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

async function openShot(page: Page, code: string) {
  await page.goto(`${EP}/shots`);
  const href = await page.getByRole("link", { name: code, exact: true }).first().getAttribute("href");
  await page.goto(href!);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(code);
  return page.url().split("?")[0]!;
}

interface Pkg {
  references: {
    productionFrame?: { frameId: string; assetId: string; version: number; freshness: string };
    startFrameAssetId: string | null;
  };
}
async function packageOf(page: Page, request: APIRequestContext, shotUrl: string): Promise<Pkg> {
  await page.goto(`${shotUrl}?section=brief`);
  const href = await page.getByRole("link", { name: /Download brief/ }).getAttribute("href");
  return (await (await request.get(href!.replace("format=brief", "format=json"))).json()) as Pkg;
}

async function uploadFrame(page: Page, shotUrl: string, name: string, rgb: [number, number, number]) {
  await page.goto(`${shotUrl}?section=production_frame`);
  const pf = page.getByTestId("production-frame-section");
  await pf
    .getByTestId("pf-upload-file")
    .setInputFiles({ name, mimeType: "image/png", buffer: png(956, 400, rgb) });
  await pf.getByTestId("pf-upload-submit").click();
  return pf;
}

// the Animate panel only: Shot Prep also renders the generic Generate workspace (its own model comparison)
const panel = (page: Page) => page.getByTestId("animate-panel");
const row = (page: Page, model: string) =>
  panel(page).locator(`[data-testid="model-row"][data-model="${model}"]`);
const card = (page: Page, model: string) =>
  page.locator(`[data-testid="candidate-card"][data-model="${model}"]`);

async function placeBlock(page: Page): Promise<Locator> {
  await page.goto("/projects/ojousama/locations");
  const block = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: PLACE }) })
    .first();
  await block.locator("summary").first().click();
  return block;
}

async function uploadView(page: Page, name: string, rgb: [number, number, number]) {
  const block = await placeBlock(page);
  await block.getByTestId("lv-upload").locator("summary").click();
  const form = block.getByTestId("lv-upload");
  await form.getByTestId("lv-upload-file").setInputFiles({
    name: `e2e-2h-${name.toLowerCase()}.png`,
    mimeType: "image/png",
    buffer: png(400, 300, rgb),
  });
  await form.getByTestId("lv-upload-name").fill(name);
  await form.getByTestId("lv-upload-kind").selectOption("establishing");
  await form.getByTestId("lv-upload-viewpoint").fill(`${name} viewpoint for the 2H spec`);
  await form.getByTestId("lv-upload-submit").click();
  await expect(block.getByTestId("location-view-card").filter({ hasText: name })).toHaveCount(1, {
    timeout: 15_000,
  });
}

async function chooseView(page: Page, shotUrl: string, name: string) {
  await page.goto(`${shotUrl}?section=production_frame`);
  const lv = page.getByTestId("location-view-section");
  await lv.getByTestId("location-view-card").filter({ hasText: name }).getByTestId("lv-choose").click();
  await expect(lv.getByTestId("lv-selected")).toContainText(name, { timeout: 15_000 });
}

/** Ticks the given models, acknowledges, creates the set and waits for every clip. */
async function createSet(page: Page, models: string[]) {
  for (const m of models) await row(page, m).getByTestId("model-pick").check();
  await panel(page).getByTestId("ack-all").check();
  await panel(page).getByTestId("create-candidate-set").click();
  await page.waitForURL(/\/candidates\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(page.getByTestId("set-rollup")).toContainText(`${models.length}/${models.length} completed`, {
    timeout: 120_000,
  });
  return new URL(page.url()).pathname;
}

let shotUrl = "";
let setUrl = "";
let v1Asset = "";

test("2C without a Production Frame: Animate is blocked with the exact reason; nothing to compare", async ({
  page,
}) => {
  shotUrl = await openShot(page, "2C");
  await page.goto(`${shotUrl}?section=animate`);
  await expect(panel(page)).toHaveAttribute("data-ready", "0");
  const blocked = panel(page).getByTestId("animate-blocked");
  await expect(blocked.locator('[data-code="no_production_frame"]')).toHaveText(
    "Choose a Production Frame before animating this Shot.",
  );
  await expect(panel(page).getByTestId("model-matrix")).toHaveCount(0);
  // the Storyboard is never offered as a substitute
  await expect(panel(page)).not.toContainText(/storyboard fallback/i);
});

test("Location View A + Production Frame v1: the Animate panel compares video models truthfully, before spend", async ({
  page,
  request,
}) => {
  await uploadView(page, "Canopy Arrival", [200, 180, 140]);
  await uploadView(page, "Canopy Reverse", [90, 110, 140]);
  await chooseView(page, shotUrl, "Canopy Arrival");
  const pf = await uploadFrame(page, shotUrl, "e2e-2h-pf-v1.png", [70, 130, 190]);
  await expect(pf.getByTestId("pf-selected")).toHaveAttribute("data-version", "1");
  const json = await packageOf(page, request, shotUrl);
  v1Asset = json.references.productionFrame!.assetId;

  await page.goto(`${shotUrl}?section=animate`);
  await expect(panel(page)).toHaveAttribute("data-ready", "1");
  await expect(panel(page).getByTestId("animate-pf-version")).toHaveText("v1");
  await expect(panel(page).getByTestId("animate-pf-preview")).toHaveAttribute("src", /^\/api\/assets\//);
  await expect(panel(page).getByTestId("animate-duration")).toContainText("3.5 s");
  await expect(panel(page).getByTestId("animate-override")).toHaveText("none");
  await expect(panel(page).getByTestId("animate-compare-intro")).toBeVisible();

  // native: exact first frame, production = provider = delivery
  const native = row(page, "mock-video-1");
  await expect(native.getByTestId("model-eligibility")).toContainText("Eligible");
  await expect(native.getByTestId("model-first-frame")).toHaveText("YES");
  await expect(native.getByTestId("model-durations")).toContainText("3.5 s → 3.5 s → 3.5 s");
  await expect(native.getByTestId("model-native-audio")).toHaveText("off");
  await expect(native.getByTestId("model-cost")).toHaveText("free");
  // generate longer, then trim; 2.39:1 frame enters a 16:9 provider canvas and is conformed back
  const longer = row(page, "mock-video-169");
  await expect(longer.getByTestId("model-eligibility")).toContainText("Eligible");
  await expect(longer.getByTestId("model-durations")).toContainText("3.5 s → 5 s → 3.5 s");
  await expect(longer.getByTestId("model-canvas")).toContainText("16:9");
  await expect(longer.getByTestId("model-canvas")).toContainText("Production Frame 2.39:1 → provider 16:9");
  // text-to-video only: INCOMPATIBLE, never a fallback
  const t2v = row(page, "mock-video-t2v");
  await expect(t2v.getByTestId("model-eligibility")).toContainText("Incompatible");
  await expect(t2v.getByTestId("model-why")).toContainText(
    "This workflow requires image-to-video from the canonical Production Frame.",
  );
  await expect(t2v.getByTestId("model-pick")).toBeDisabled();
  // a keyframe-only real model keeps the exact first frame and never offers a "references" mode
  await expect(row(page, "seedance2_5").getByTestId("model-first-frame")).toHaveText("YES");
  await expect(row(page, "seedance2_5").locator('select[aria-label$="input mode"]')).toHaveCount(0);
  // nothing pre-selected, nothing generated by opening the panel
  await expect(panel(page).getByTestId("selected-count")).toHaveText("0 selected");
  await expect(panel(page).getByTestId("create-candidate-set")).toBeDisabled();
});

test("create the set: free mock clips start EXACTLY from PF v1; Best stays separate from final approval", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto(`${shotUrl}?section=animate`);
  setUrl = await createSet(page, ["mock-video-1", "mock-video-169"]);
  const source = page.getByTestId("animation-source");
  await expect(source).toContainText("Animated from Production Frame");
  await expect(source).toHaveAttribute("data-version", "1");
  await expect(source).toHaveAttribute("data-selected", "1");
  for (const m of ["mock-video-1", "mock-video-169"]) {
    const c = card(page, m);
    await expect(c).toHaveAttribute("data-status", "succeeded");
    await expect(c.getByTestId("candidate-video")).toHaveCount(1);
    const a = c.getByTestId("candidate-animation");
    await expect(a).toHaveAttribute("data-first-frame", "match");
    await expect(a).toHaveAttribute("data-freshness", "fresh");
    await expect(a).toContainText("Start: Production Frame v1");
  }
  // the adapted clip is not production-shaped until conformed
  await expect(card(page, "mock-video-169").getByTestId("conform-required")).toContainText(
    "Delivery conform required",
  );
  await expect(card(page, "mock-video-1").getByTestId("candidate-animation")).toHaveAttribute(
    "data-conform-required",
    "0",
  );

  // ⭐ Best on the native clip: preferred, but NOT the Shot's approved output
  await card(page, "mock-video-1").getByTestId("review-best").click();
  await expect(card(page, "mock-video-1")).toHaveAttribute("data-preferred", "1", { timeout: 15_000 });
  await expect(card(page, "mock-video-1")).toHaveAttribute("data-promoted", "0");
  await page.goto(`${shotUrl}?section=generate`);
  const attempt = page.getByTestId("attempt-card").filter({ hasText: "mock / mock-video-1" }).first();
  await expect(attempt).toHaveAttribute("data-review", "unreviewed");
});

test("delivery conform: the provider original stays immutable; a separate production-shaped master is made", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto(`${shotUrl}?section=generate`);
  const attempt = page.getByTestId("attempt-card").filter({ hasText: "mock / mock-video-169" }).first();
  await expect(attempt.getByTestId("provider-original-card")).toContainText("Immutable");
  await expect(attempt.getByTestId("production-target-card")).toContainText("2.39:1");
  await expect(attempt.getByTestId("conform-card")).toContainText("Crop 16:9 → 2.39:1");
  await expect(attempt.getByTestId("conform-card")).toContainText("Trim 5.00s → 3.50s");
  await expect(attempt.getByTestId("delivery-size")).toContainText("not created yet");
  await attempt.getByTestId("create-conform").click();
  await expect(attempt.getByTestId("delivery-size")).toContainText("3.50s", { timeout: 90_000 });
  await page.goto(setUrl);
  await expect(card(page, "mock-video-169").getByTestId("candidate-animation")).toHaveAttribute(
    "data-conform-required",
    "0",
  );
  await expect(card(page, "mock-video-169").getByTestId("dims-delivery")).not.toContainText(
    "provider original",
  );
});

test("Sequence: 2C shows its animation state and an Animate link; the canonical STILL stays the visual", async ({
  page,
}) => {
  await page.goto(`${EP}/sequence`);
  const c = page.locator('[data-testid="sequence-card"][data-shot-code="2C"]');
  await expect(c.getByTestId("sequence-animation")).toHaveAttribute("data-state", "candidates");
  await expect(c.getByTestId("sequence-animation")).toContainText("2 of 2 ready");
  const link = c.getByTestId("sequence-animate-link");
  await expect(link).toHaveAttribute("href", /\?section=animate$/);
  await expect(c.getByTestId("sequence-visual")).toHaveAttribute("data-kind", "production_frame");
  await expect(c.locator("video")).toHaveCount(0);
  await link.click();
  await expect(panel(page)).toBeVisible();
});

test("PF v2: the v1 clips go stale (history kept); a new Animate starts from v2", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await uploadFrame(page, shotUrl, "e2e-2h-pf-v2.png", [180, 90, 60]);
  await expect(page.getByTestId("pf-selected")).toHaveAttribute("data-version", "2");
  const json = await packageOf(page, request, shotUrl);
  const v2Asset = json.references.productionFrame!.assetId;
  expect(v2Asset).not.toBe(v1Asset);

  await page.goto(setUrl);
  await expect(page.getByTestId("animation-source")).toHaveAttribute("data-selected", "0");
  for (const m of ["mock-video-1", "mock-video-169"]) {
    await expect(card(page, m).getByTestId("candidate-animation")).toHaveAttribute("data-freshness", "stale");
    await expect(card(page, m).getByTestId("candidate-stale-reasons")).toContainText(
      "The selected Production Frame changed",
    );
    await expect(card(page, m).getByTestId("candidate-video")).toHaveCount(1); // never deleted
  }

  await page.goto(`${shotUrl}?section=animate`);
  await expect(panel(page).getByTestId("animate-pf-version")).toHaveText("v2");
  await expect(panel(page).getByTestId("animate-set")).toContainText("from Production Frame v1");
  await expect(panel(page).getByTestId("animate-set").first()).toContainText("stale");
  await createSet(page, ["mock-video-1"]);
  await expect(page.getByTestId("animation-source")).toHaveAttribute("data-version", "2");
  await expect(card(page, "mock-video-1").getByTestId("candidate-animation")).toHaveAttribute(
    "data-first-frame",
    "match",
  );
});

test("Location View B: the PF goes stale, so Animate is blocked and the clips are stale; the Sequence keeps the still", async ({
  page,
}) => {
  await chooseView(page, shotUrl, "Canopy Reverse");
  await page.goto(`${shotUrl}?section=animate`);
  await expect(panel(page)).toHaveAttribute("data-ready", "0");
  await expect(panel(page).locator('[data-code="production_frame_stale"]')).toContainText(
    "The selected Production Frame no longer matches the Shot",
  );
  await expect(panel(page).getByTestId("model-matrix")).toHaveCount(0);

  await page.goto(`${EP}/sequence`);
  const c = page.locator('[data-testid="sequence-card"][data-shot-code="2C"]');
  await expect(c.getByTestId("sequence-animation")).toHaveAttribute("data-state", "stale");
  await expect(c.getByTestId("sequence-animate-link")).toHaveCount(0);
  await expect(c.getByTestId("sequence-visual")).toHaveAttribute("data-kind", "production_frame");
  await expect(c.getByTestId("sequence-visual")).toHaveAttribute("data-freshness", "stale");
});

/** What the 4C test changes on Shot 4C, read before it starts and put back afterwards (see `afterAll`). */
interface Shot4CState {
  lookValue: string;
  lockId: string | null;
  pfVersion: string | null;
  continuityApproved: boolean;
}
let original4C: Shot4CState | null = null;
let url4C = "";

// 4C has one character (Yumeko): her Look assignment is the Shot's only Look select
const yumekoLook = (page: Page) => page.locator('select[name^="look:"]').first();
const continuityGate = (page: Page) => page.locator("form").filter({ hasText: "Continuity approved" });

async function read4C(page: Page, url: string): Promise<Shot4CState> {
  await page.goto(`${url}?section=character`);
  const lookValue = await yumekoLook(page).inputValue();
  await page.goto(`${url}?section=look`);
  const sel = page.getByTestId("character-continuity").getByTestId("cc-selected");
  const lockId = (await sel.count()) ? await sel.getAttribute("data-lock-id") : null;
  await page.goto(`${url}?section=production_frame`);
  const pf = page.getByTestId("pf-selected");
  const pfVersion = (await pf.count()) ? await pf.getAttribute("data-version") : null;
  await page.goto(`${url}?section=continuity`);
  const continuityApproved =
    (await continuityGate(page)
      .getByRole("button", { name: /Approved/ })
      .count()) > 0;
  return { lookValue, lockId, pfVersion, continuityApproved };
}

/** Clears the 4C Yumeko Lock selection (a valid one, or one a Look change made invalid). */
async function clear4CLock(page: Page, url: string) {
  await page.goto(`${url}?section=look`);
  const cc = page.getByTestId("character-continuity");
  for (const id of ["cc-clear", "cc-clear-invalid"]) {
    if (await cc.getByTestId(id).count()) {
      await cc.getByTestId(id).click();
      await expect(cc.getByTestId("cc-empty")).toBeVisible({ timeout: 15_000 });
    }
  }
}

async function assign4CLook(page: Page, url: string, value: { value: string } | { label: string }) {
  await page.goto(`${url}?section=character`);
  await yumekoLook(page).selectOption(value);
  await page.getByRole("button", { name: "Save characters" }).click();
  await expect(page.getByText("Saved").first()).toBeVisible({ timeout: 15_000 });
}

async function openYumeko(page: Page) {
  await page.goto("/projects/ojousama/characters");
  await page.getByRole("link", { name: "Yumeko" }).first().click();
}

/** A facts-only Continuity Lock of the spec-owned Look, from the Character page (the 2G.4 spec's own path). */
async function createLock(page: Page, name: string) {
  await openYumeko(page);
  await page.getByTestId("cl-look").selectOption({ label: LOOK });
  await page.getByTestId("cl-name").fill(name);
  await page.getByTestId("cl-create").click();
  await expect(page.getByTestId("continuity-lock-card").filter({ hasText: name })).toHaveCount(1, {
    timeout: 15_000,
  });
}

test("4C Character Lock: a master Look edit keeps the clip fresh; switching to Lock v2 stales it", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const url = await openShot(page, "4C");
  url4C = url;
  original4C = await read4C(page, url);

  // this spec's own minimal fixture (no other spec needed): a Look of Yumeko and a facts-only Lock v1 of it
  await openYumeko(page);
  const newLook = page.locator("details", { has: page.locator("summary", { hasText: "+ New look" }) });
  await newLook.locator("summary").click();
  await newLook.locator('input[name="name"]').fill(LOOK);
  await newLook.locator('textarea[name="wardrobe"]').fill("linen travel suit");
  await newLook.getByRole("button", { name: "Create look" }).click();
  await expect(page.locator("summary", { hasText: LOOK })).toBeVisible({ timeout: 15_000 });
  await createLock(page, LOCK_V1);

  // Shot 4C: Yumeko wears that Look under Lock v1; a Production Frame uploaded under v1 is current
  await clear4CLock(page, url);
  await assign4CLook(page, url, { label: LOOK });
  await page.goto(`${url}?section=look`);
  const cc = page.getByTestId("character-continuity");
  await cc.getByTestId("continuity-lock-card").filter({ hasText: LOCK_V1 }).getByTestId("cc-choose").click();
  await expect(cc.getByTestId("cc-selected")).toContainText(LOCK_V1, { timeout: 15_000 });
  await uploadFrame(page, url, "e2e-2h-4c-v1.png", [150, 110, 90]);
  await expect(page.getByTestId("pf-selected")).toHaveAttribute("data-freshness", "fresh", {
    timeout: 15_000,
  });
  // the Shot's own output readiness still applies (an existing human approval)
  await page.goto(`${url}?section=continuity`);
  const gate = continuityGate(page);
  if (await gate.getByRole("button", { name: "Approve" }).count()) {
    await gate.getByRole("button", { name: "Approve" }).click();
    await expect(gate.getByRole("button", { name: /Approved/ })).toBeVisible({ timeout: 15_000 });
  }

  await page.goto(`${url}?section=animate`);
  await expect(panel(page)).toHaveAttribute("data-ready", "1");
  const lockedSet = await createSet(page, ["mock-video-169"]);
  const clip = card(page, "mock-video-169").getByTestId("candidate-animation");
  await expect(clip).toHaveAttribute("data-freshness", "fresh");

  // edit the MASTER Look (the editable library): the locked Shot's truth is unchanged
  await openYumeko(page);
  const look = page.locator("details", { has: page.locator("summary", { hasText: LOOK }) });
  await look.locator("summary").click();
  await look.locator('textarea[name="wardrobe"]').fill("midnight blue gown");
  await look.getByRole("button", { name: "Save look" }).click();
  await expect(look.locator('textarea[name="wardrobe"]')).toHaveValue("midnight blue gown");
  await page.goto(lockedSet);
  await expect(card(page, "mock-video-169").getByTestId("candidate-animation")).toHaveAttribute(
    "data-freshness",
    "fresh",
  );

  // Lock v2 from the edited Look; switching the Shot to it: the clip is stale and a new animation is blocked (the PF
  // is stale too)
  await createLock(page, LOCK_V2);
  await page.goto(`${url}?section=look`);
  await cc.getByTestId("continuity-lock-card").filter({ hasText: LOCK_V2 }).getByTestId("cc-choose").click();
  await expect(cc.getByTestId("cc-selected")).toContainText(LOCK_V2, { timeout: 15_000 });
  await page.goto(lockedSet);
  await expect(card(page, "mock-video-169").getByTestId("candidate-animation")).toHaveAttribute(
    "data-freshness",
    "stale",
  );
  await page.goto(`${url}?section=animate`);
  await expect(panel(page)).toHaveAttribute("data-ready", "0");
  await expect(panel(page).locator('[data-code="production_frame_stale"]')).toBeVisible();
});

/**
 * Puts Shot 4C's mutable state back exactly as the 4C test found it: Yumeko's Look assignment, the Lock selection,
 * the selected Production Frame and the continuity approval. The spec-owned Look, its Locks, the uploaded frame and
 * the mock clips stay as history: the product has no delete for any of them (append-only by design).
 */
test.afterAll(async ({ browser }) => {
  if (!original4C) return;
  const o = original4C;
  const page = await browser.newPage();
  try {
    await clear4CLock(page, url4C);
    await assign4CLook(page, url4C, { value: o.lookValue });
    if (o.lockId) {
      await page.goto(`${url4C}?section=look`);
      await page
        .getByTestId("character-continuity")
        .locator(`form:has(input[name="continuityLockId"][value="${o.lockId}"])`)
        .getByTestId("cc-choose")
        .click();
      await expect(page.getByTestId("cc-selected")).toHaveAttribute("data-lock-id", o.lockId, {
        timeout: 15_000,
      });
    }
    if (o.pfVersion) {
      await page.goto(`${url4C}?section=production_frame`);
      await page.getByTestId(`pf-select-${o.pfVersion}`).click();
      await expect(page.getByTestId("pf-selected")).toHaveAttribute("data-version", o.pfVersion, {
        timeout: 15_000,
      });
    }
    await page.goto(`${url4C}?section=continuity`);
    const approved =
      (await continuityGate(page)
        .getByRole("button", { name: /Approved/ })
        .count()) > 0;
    if (approved !== o.continuityApproved) {
      await continuityGate(page).getByRole("button").click();
      await expect(
        continuityGate(page).getByRole("button", { name: o.continuityApproved ? /Approved/ : "Approve" }),
      ).toBeVisible({ timeout: 15_000 });
    }
    // the restore is itself verified. One pointer has no undo in the product: a Production Frame selection cannot be
    // cleared (frames are append-only and only re-selectable), so when 4C had none it keeps the uploaded frame.
    const now4C = await read4C(page, url4C);
    expect(o.pfVersion === null ? { ...now4C, pfVersion: null } : now4C).toEqual(o);
  } finally {
    await page.close();
  }
});

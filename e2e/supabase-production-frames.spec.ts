import { execFileSync } from "node:child_process";
import { crc32, deflateSync } from "node:zlib";
import { expect, request as playwrightRequest, test, type Page } from "@playwright/test";
import { getPrismStudioDevCredentials } from "./dev-credentials";

/**
 * Phase 2G.1 Production Frames on the REAL stack: Supabase Auth + RLS, the hosted Prism Studio database and PRIVATE
 * Storage. The demo project has no 3D set here either: a Shot's approved Storyboard is promoted, an image is
 * uploaded, the selection moves between frames and survives a reload, and a Shot change makes the selected frame
 * stale. Everything created is removed afterwards. No provider call, no image model, no GPU.
 */
const { email: EMAIL, password: PASSWORD } = getPrismStudioDevCredentials();
const ORIGIN = "http://localhost:3101";
const EP = "/projects/ojousama/episodes/ep-1";
const PREFIX = `e2e-pf-${Date.now()}`;

test.describe.configure({ mode: "serial" });

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

const cleanupCli = () =>
  execFileSync(
    "npx",
    ["tsx", "--env-file=.env.local", "scripts/previs-cleanup.mts", "--yes", `--e2e-assets-prefix=${PREFIX}`],
    {
      cwd: process.cwd(),
      env: { ...process.env, PRISM_STUDIO_PERSISTENCE: "supabase", NODE_ENV: "test", PRISM_STUDIO_WORKER_DEV_STORAGE: "1" },
      encoding: "utf8",
      timeout: 120_000,
      shell: process.platform === "win32",
    },
  );
const cleanup = () => {
  try {
    cleanupCli();
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

let shotUrl: string;
const section = (page: Page) => page.getByTestId("production-frame-section");
const items = (page: Page) => section(page).getByTestId("pf-history-item");

test("hosted: promote the approved Storyboard, upload a frame, switch, reload, and go stale — with no 3D set", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signIn(page);
  await page.goto(`${EP}/shots`);
  const href = await page.getByRole("link", { name: "5A", exact: true }).first().getAttribute("href");
  await page.goto(href!);
  shotUrl = page.url().split("?")[0]!;

  // an approved storyboard frame with a real private image (the seed's are placeholders)
  await page.goto(`${shotUrl}?section=storyboard`);
  const sb = page.locator("#storyboard");
  const before = await sb.locator("form").count();
  await sb.locator("input[type=file]").setInputFiles({
    name: `${PREFIX}-storyboard.png`,
    mimeType: "image/png",
    buffer: png(478, 200, [180, 70, 70]),
  });
  await sb.getByRole("button", { name: "Add frame version" }).click();
  await expect.poll(() => sb.locator("form").count(), { timeout: 60_000 }).toBeGreaterThan(before);
  const row = sb.locator("form").filter({ hasText: /v\d+ · upload/ }).last();
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(sb.locator("form").filter({ hasText: /v\d+ · upload/ }).last().getByRole("button", { name: /Approved/ })).toBeVisible({
    timeout: 60_000,
  });

  // empty state, no 3D / GPU wording
  await page.goto(`${shotUrl}?section=production_frame`);
  await expect(section(page).getByTestId("pf-empty")).toContainText("No Production Frame yet.");
  await expect(section(page)).not.toContainText(/3D|GPU|COLMAP|splat|Vulkan/i);

  // promote the approved Storyboard: v1, the Storyboard's own Asset
  await section(page).getByTestId("pf-use-storyboard").click();
  const selected = section(page).getByTestId("pf-selected");
  await expect(selected).toHaveAttribute("data-version", "1", { timeout: 60_000 });
  await expect(selected).toHaveAttribute("data-source", "storyboard");
  await expect(selected).toHaveAttribute("data-freshness", "fresh");

  // the preview is the authenticated private route, never a Storage URL
  const src = (await section(page).getByTestId("pf-preview").getAttribute("src"))!;
  expect(src).toMatch(/^\/api\/assets\/[0-9a-f-]{36}$/);
  await expect(section(page).getByTestId("pf-preview")).toHaveJSProperty("naturalWidth", 478);
  expect(await page.content()).not.toMatch(/supabase\.co\/storage|createSignedUrl|token=/);
  const anonymous = await playwrightRequest.newContext({ baseURL: ORIGIN });
  const denied = await anonymous.get(src, { maxRedirects: 0 });
  expect([401, 403, 404, 307, 302, 308]).toContain(denied.status());
  await anonymous.dispose();

  // upload a production-shaped image: v2, a new private `production_frame` Asset
  await section(page).getByTestId("pf-upload-file").setInputFiles({
    name: `${PREFIX}-upload.png`,
    mimeType: "image/png",
    buffer: png(956, 400, [70, 120, 190]),
  });
  await section(page).getByTestId("pf-upload-submit").click();
  await expect(section(page).getByTestId("pf-selected")).toHaveAttribute("data-version", "2", { timeout: 60_000 });
  await expect(items(page)).toHaveCount(2);

  // a wrongly shaped image is refused
  await section(page).getByTestId("pf-upload-file").setInputFiles({
    name: `${PREFIX}-wrong.png`,
    mimeType: "image/png",
    buffer: png(640, 360, [20, 20, 20]),
  });
  await section(page).getByTestId("pf-upload-submit").click();
  await expect(section(page).getByRole("alert")).toContainText("does not crop");
  await expect(items(page)).toHaveCount(2);

  // switch to v1, reload: the selection is persisted, history is intact
  await section(page).getByTestId("pf-select-1").click();
  await expect(section(page).getByTestId("pf-selected")).toHaveAttribute("data-version", "1", { timeout: 60_000 });
  await page.reload();
  await expect(section(page).getByTestId("pf-selected")).toHaveAttribute("data-version", "1");
  await expect(items(page)).toHaveCount(2);
  await section(page).getByTestId("pf-select-2").click();
  await expect(section(page).getByTestId("pf-selected")).toHaveAttribute("data-version", "2", { timeout: 60_000 });

  // staleness through a Shot change; restored afterwards
  await page.goto(`${shotUrl}?section=lighting`);
  const mood = page.locator("#lighting input[name='lighting.mood']");
  const original = await mood.inputValue();
  try {
    await mood.fill("harsh noon sun");
    await page.locator("#lighting").getByRole("button", { name: /Save lighting/i }).click();
    await expect(page.locator("#lighting")).toContainText("Saved");
    await page.goto(`${shotUrl}?section=production_frame`);
    await expect(section(page).getByTestId("pf-selected")).toHaveAttribute("data-freshness", "stale");
    await expect(section(page).getByTestId("pf-stale")).toContainText("Lighting changed");
    await expect(section(page).getByTestId("pf-selected")).toHaveAttribute("data-version", "2");
  } finally {
    await page.goto(`${shotUrl}?section=lighting`);
    await page.locator("#lighting input[name='lighting.mood']").fill(original);
    await page.locator("#lighting").getByRole("button", { name: /Save lighting/i }).click();
    await expect(page.locator("#lighting")).toContainText("Saved"); // the restore is stored before moving on
  }
  await page.goto(`${shotUrl}?section=production_frame`);
  await expect(section(page).getByTestId("pf-selected")).toHaveAttribute("data-freshness", "fresh");

  // approve flag restored by the cleanup helper (it removes the e2e storyboard frame + frames + assets)
});

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { getPrismStudioDevCredentials } from "./dev-credentials";

/**
 * Phase 2G.5 Shot Sequence Board on the REAL stack: Supabase Auth + RLS and the hosted Prism Studio database, through
 * the real Postgres Shot save. No provider, no paid call, no Storage write, no 3D set.
 *
 *   record Scene 1's order and every episode Shot's stored previous-Shot link → drag 1C before 1B → the links did not
 *   move → preview → confirm the sync → exactly the mismatched Shots were written (only their link) → restore the
 *   recorded order and links exactly.
 */
const { email: EMAIL, password: PASSWORD } = getPrismStudioDevCredentials();
const EP = "/projects/ojousama/episodes/ep-1";

test.describe.configure({ mode: "serial" });

type Row = {
  id: string;
  shot_code: string;
  scene_id: string;
  order: number;
  previous_shot_id: string | null;
  status: string;
  continuity: Record<string, unknown>;
  updated_at: string;
};

async function db<T>(fn: (c: pg.Client) => Promise<T>): Promise<T | null> {
  const url = process.env.SUPABASE_DB_URL ?? "";
  if (!url.includes("lyqdxiyjperhniwhzsvg")) return null; // never any other project
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const readShots = () =>
  db(
    async (c) =>
      (
        await c.query<Row>(
          `select s.id, s.shot_code, s.scene_id, s."order", s.previous_shot_id, s.status, s.continuity,
                  s.updated_at::text as updated_at
             from shots s join projects p on p.id = s.project_id join episodes e on e.id = s.episode_id
            where p.slug = 'ojousama' and e.slug = 'ep-1'
            order by s.shot_code`,
        )
      ).rows,
  );

// the episode's Shots exactly as they were (order, link, continuity, updated_at)
let original: Row[] = [];

test.beforeAll(async () => {
  original = (await readShots()) ?? [];
});

test.afterAll(async () => {
  if (original.length === 0) return;
  await db(async (c) => {
    await c.query("begin");
    // the shots_updated trigger stamps updated_at; restore it after the values
    for (const r of original)
      await c.query(`update shots set "order" = $2, previous_shot_id = $3, continuity = $4 where id = $1`, [
        r.id,
        r.order,
        r.previous_shot_id,
        r.continuity,
      ]);
    await c.query("alter table shots disable trigger shots_updated");
    for (const r of original)
      await c.query("update shots set updated_at = $2 where id = $1", [r.id, r.updated_at]);
    await c.query("alter table shots enable trigger shots_updated");
    await c.query("commit");
  });
  const after = (await readShots()) ?? [];
  expect(after).toEqual(original);
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("お嬢様、僕と結婚してください。").first()).toBeVisible({ timeout: 30_000 });
}

const card = (page: Page, code: string) =>
  page.locator(`[data-testid="sequence-card"][data-shot-code="${code}"]`);

test("hosted: reorder keeps links; the confirmed sync writes only the mismatched Shots' links; restored exactly", async ({
  page,
}) => {
  test.skip(original.length === 0, "SUPABASE_DB_URL for the Prism Studio project is not configured");
  test.setTimeout(300_000);
  const byCode = new Map(original.map((r) => [r.shot_code, r]));
  for (const code of ["1A", "1B", "1C"])
    expect(byCode.get(code)?.status, `${code} must be unlocked`).not.toBe("locked");

  await signIn(page);
  await page.goto(`${EP}/sequence`);
  const scene1 = page.locator(
    "[data-testid='sequence-scene'][data-scene-number='1'] [data-testid='sequence-card']",
  );
  await expect(scene1).toHaveCount(3);
  expect(await scene1.evaluateAll((els) => els.map((e) => e.getAttribute("data-shot-code")))).toEqual([
    "1A",
    "1B",
    "1C",
  ]);

  // drag 1C before 1B (the same SortableBoard + reorderShots as the Storyboard)
  const handle = page
    .locator("[data-sortable-item]")
    .filter({ has: card(page, "1C") })
    .getByRole("button", { name: "Drag to reorder" });
  const from = (await handle.boundingBox())!;
  const to = (await card(page, "1B").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 10, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect(page.getByText("Saving order…")).toHaveCount(0, { timeout: 60_000 });
  await page.reload();
  expect(await scene1.evaluateAll((els) => els.map((e) => e.getAttribute("data-shot-code")))).toEqual([
    "1A",
    "1C",
    "1B",
  ]);

  const reordered = (await readShots())!;
  // the reorder changed orders only: every stored link is exactly as before
  expect(reordered.map((r) => [r.shot_code, r.previous_shot_id])).toEqual(
    original.map((r) => [r.shot_code, r.previous_shot_id]),
  );

  // preview → confirm
  const panel = page.getByTestId("sequence-sync");
  await expect(panel).toBeVisible();
  await panel.getByText(/Review \d+ link change/).click();
  const listed = await panel
    .getByTestId("sequence-sync-changes")
    .locator("li")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-shot-code") ?? ""));
  expect(listed).toEqual(expect.arrayContaining(["1C", "1B"]));
  await panel.getByTestId("sequence-sync-confirm").click();
  await expect(page.getByTestId("sequence-sync")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("sequence-summary-link-mismatches")).toHaveText("0");

  const synced = (await readShots())!;
  const before = new Map(reordered.map((r) => [r.shot_code, r]));
  const id = (code: string) => byCode.get(code)!.id;
  expect(synced.find((r) => r.shot_code === "1C")!.previous_shot_id).toBe(id("1A"));
  expect(synced.find((r) => r.shot_code === "1B")!.previous_shot_id).toBe(id("1C"));
  for (const r of synced) {
    const was = before.get(r.shot_code)!;
    expect(r.order, `${r.shot_code} order`).toBe(was.order);
    if (listed.includes(r.shot_code)) {
      // only the link changed (the continuity jsonb holds no link: it is its own column)
      expect(r.continuity, `${r.shot_code} continuity`).toEqual(was.continuity);
    } else {
      expect(r, `${r.shot_code} untouched`).toEqual(was);
    }
  }
});

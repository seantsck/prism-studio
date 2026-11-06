import { execFileSync } from "node:child_process";
import pg from "pg";
import { expect, test, type Page } from "@playwright/test";
import { getPrismStudioDevCredentials } from "./dev-credentials";
import { assertProjectRef } from "../scripts/lib/safety.mjs";

/**
 * Phase 4C-B on the REAL stack: Supabase Auth + RLS, the hosted Prism Studio database at migration 0049 and PRIVATE
 * Storage, with the app running LOCALLY (no deploy) and no provider call (local WebGL rendering only).
 *
 * Shot Prep → Shot Spatial Workspace, the Location page Shot selector as a navigation (P6), a Master Frame with
 * server-derived camera + base-environment provenance (0049), promotion to a Production Frame with the five frozen
 * source fingerprints (checked by 0049's exact-source trigger), the stale confirmation and its digest, source deletion,
 * current-Location authority after a reassignment, and the no-Location path.
 *
 * Isolation: the hosted demo has no 3D data of its own (no scene, Master Frame or Production Frame), so every such row
 * is this spec's. Shot 1A's Location is changed and then restored to its exact prior values (location_id, spatial);
 * its updated_at is trigger-managed (`shots_updated` → set_updated_at()) and so records the restore. Everything created is removed afterwards: this run's previs_master Production Frames + selections, then
 * `scripts/previs-cleanup.mts` (scenes, bookmarks, Master Frames, render assets and their Storage objects).
 */
const { email: EMAIL, password: PASSWORD } = getPrismStudioDevCredentials();
const EP = "/projects/ojousama/episodes/ep-1";
const RUN_START = new Date().toISOString();
const HEX = /^[0-9a-f]{64}$/;

test.use({
  launchOptions: {
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  },
});
test.describe.configure({ mode: "serial" });

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const url = process.env.SUPABASE_DB_URL!;
  assertProjectRef(url, "SUPABASE_DB_URL", process.env);
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

const previsCleanup = () =>
  execFileSync("npx", ["tsx", "--env-file=.env.local", "scripts/previs-cleanup.mts", "--yes"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRISM_STUDIO_PERSISTENCE: "supabase",
      NODE_ENV: "test",
      PRISM_STUDIO_WORKER_DEV_STORAGE: "1",
    },
    encoding: "utf8",
    timeout: 120_000,
    shell: process.platform === "win32",
  });

type ShotRow = { id: string; location_id: string | null; spatial: unknown; updated_at: Date };
let original1A: ShotRow | null = null;

async function cleanup() {
  // Production Frames are append-only for users: this run's previs_master frames (and their selections) are removed
  // as the database owner, exactly like previs-cleanup does for its own frames. The hosted demo had none before.
  const demo = `(select id from projects where slug = 'ojousama')`;
  await sql(
    `delete from shot_production_frame_selections where production_frame_id in
       (select id from shot_production_frames where source = 'previs_master' and created_at >= $1 and project_id in ${demo})`,
    [RUN_START],
  );
  await sql(
    `delete from shot_production_frames where source = 'previs_master' and created_at >= $1 and project_id in ${demo}`,
    [RUN_START],
  );
  if (original1A)
    await sql(
      `update shots set location_id = $2, spatial = $3 where id = $1 and location_id is distinct from $2`,
      [original1A.id, original1A.location_id, JSON.stringify(original1A.spatial)],
    );
  try {
    previsCleanup();
  } catch {
    /* best effort; idempotent (checked again by the final assertion) */
  }
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("お嬢様、僕と結婚してください。").first()).toBeVisible({ timeout: 30_000 });
}

type ShotRef = { code: string; id: string; prepUrl: string; spatialUrl: string };
async function shotOf(page: Page, code: string): Promise<ShotRef> {
  await page.goto(`${EP}/shots`);
  const href = (await page.getByRole("link", { name: code, exact: true }).first().getAttribute("href"))!;
  const id = /\/shots\/([0-9a-f-]{36})/.exec(href)![1]!;
  const prepUrl = `${EP}/shots/${id}`;
  return { code, id, prepUrl, spatialUrl: `${prepUrl}/spatial` };
}

const set = (page: Page) => page.getByTestId("virtual-set");
const attr = async (page: Page, name: string) => (await set(page).getAttribute(name)) ?? "";
async function ready(page: Page) {
  await expect(set(page)).toHaveAttribute("data-ready", "true", { timeout: 90_000 });
  await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
    timeout: 60_000,
  });
  await expect(page.getByTestId("shot-lighting")).toHaveAttribute("data-loaded", "true", { timeout: 60_000 });
}
async function openWorkspace(page: Page, s: ShotRef) {
  await page.goto(`${s.prepUrl}?section=set`);
  await page.getByTestId("open-spatial-workspace").click();
  await page.waitForURL(new RegExp(`/shots/${s.id}/spatial$`), { timeout: 60_000 });
  await ready(page);
}
const setInput = async (page: Page, testId: string, value: string) => {
  const input = page.getByTestId(testId);
  await input.fill(value);
  await input.press("Enter");
  await expect(input).toHaveValue(value);
};
async function saveSet(page: Page, text: string) {
  await page.getByTestId("save-set").click();
  await expect(page.getByTestId("set-status")).toContainText(text, { timeout: 60_000 });
  await expect(set(page)).toHaveAttribute("data-dirty", "false");
}
async function capture(page: Page): Promise<string> {
  const before = await workspaceFrames(page);
  await page.getByTestId("capture-master-frame").click();
  await expect(page.getByTestId("set-status")).toContainText("Master frame saved", { timeout: 120_000 });
  await expect
    .poll(async () => (await workspaceFrames(page)).length, { timeout: 60_000 })
    .toBe(before.length + 1);
  return (await workspaceFrames(page)).find((id) => !before.includes(id))!;
}
const workspaceFrames = (page: Page) =>
  page
    .locator('[data-testid^="workspace-promote-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("workspace-promote-", "")));
type Pkg = {
  references: { productionFrame?: { frameId: string; sourceSpatial?: { masterFrameId: string } } };
};
const pkg = async (page: Page, shotId: string): Promise<Pkg> => {
  const r = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
  expect(r.ok()).toBe(true);
  return (await r.json()) as Pkg;
};
type Mf = {
  id: string;
  location_id: string;
  scene_document_id: string;
  scene_fingerprint: string;
  camera_fingerprint: string | null;
  camera_json: { schema?: string; cameraFingerprint?: string; camera?: unknown } | null;
  blocking_fingerprint: string | null;
  lighting_fingerprint: string | null;
  base_environment_fingerprint: string | null;
};
const masterFrame = async (id: string) =>
  (
    await sql<Mf>(
      `select id, location_id, scene_document_id, scene_fingerprint, camera_fingerprint, camera_json,
              blocking_fingerprint, lighting_fingerprint, base_environment_fingerprint
         from scene_master_frames where id = $1`,
      [id],
    )
  )[0];
type Pf = {
  id: string;
  source: string;
  source_master_frame_id: string | null;
  source_scene_fingerprint: string | null;
  source_camera_fingerprint: string | null;
  source_blocking_fingerprint: string | null;
  source_lighting_fingerprint: string | null;
  source_base_environment_fingerprint: string | null;
};
const productionFrames = (shotId: string) =>
  sql<Pf>(
    `select id, source, source_master_frame_id, source_scene_fingerprint, source_camera_fingerprint,
            source_blocking_fingerprint, source_lighting_fingerprint, source_base_environment_fingerprint
       from shot_production_frames where shot_id = $1 and created_at >= $2 order by created_at`,
    [shotId, RUN_START],
  );
const expectFrozenFrom = (p: Pf, m: Mf) => {
  expect(p.source).toBe("previs_master");
  expect(p.source_master_frame_id).toBe(m.id);
  expect(p.source_scene_fingerprint).toBe(m.scene_fingerprint);
  expect(p.source_camera_fingerprint).toBe(m.camera_fingerprint);
  expect(p.source_blocking_fingerprint).toBe(m.blocking_fingerprint);
  expect(p.source_lighting_fingerprint).toBe(m.lighting_fingerprint);
  expect(p.source_base_environment_fingerprint).toBe(m.base_environment_fingerprint);
};

let A: ShotRef;
let B: ShotRef;
let sceneId = "";
let mf1 = "";
let mf2 = "";

test.beforeAll(async () => {
  // a previous aborted run's fixtures (none expected), then record 1A's exact row for the reassignment story
  await cleanup();
  original1A =
    (
      await sql<ShotRow>(
        `select s.id, s.location_id, s.spatial, s.updated_at from shots s join projects p on p.id = s.project_id
          where p.slug = 'ojousama' and s.shot_code = '1A'`,
      )
    )[0] ?? null;
  expect(original1A?.location_id, "1A starts on its seeded Location").toBeTruthy();
  const existing = await sql<{ n: number }>(
    `select count(*)::int n from location_scene_documents d join projects p on p.id = d.project_id where p.slug = 'ojousama'`,
  );
  expect(
    existing[0]!.n,
    "the hosted demo has no 3D Set of its own (so every scene here is this spec's)",
  ).toBe(0);
});

test.afterAll(async () => {
  await cleanup();
  const left = await sql<Record<string, number>>(
    `select (select count(*)::int from location_scene_documents d join projects p on p.id = d.project_id where p.slug = 'ojousama') scenes,
            (select count(*)::int from scene_master_frames f join projects p on p.id = f.project_id where p.slug = 'ojousama') frames,
            (select count(*)::int from shot_camera_bookmarks b join projects p on p.id = b.project_id where p.slug = 'ojousama') bookmarks,
            (select count(*)::int from shot_production_frames f where f.source = 'previs_master' and f.created_at >= $1) pfs`,
    [RUN_START],
  );
  expect(left[0]).toEqual({ scenes: 0, frames: 0, bookmarks: 0, pfs: 0 });
  if (original1A) {
    const now = (
      await sql<ShotRow>(`select id, location_id, spatial, updated_at from shots where id = $1`, [
        original1A.id,
      ])
    )[0]!;
    expect(now.location_id).toBe(original1A.location_id);
    expect(JSON.stringify(now.spatial)).toBe(JSON.stringify(original1A.spatial));
  }
});

test("anonymous: the Shot Spatial Workspace and the Location 3D page redirect to login", async ({ page }) => {
  const shot = (
    await sql<{ id: string; location_id: string }>(
      `select s.id, s.location_id from shots s join projects p on p.id = s.project_id where p.slug='ojousama' and s.shot_code='1A'`,
    )
  )[0]!;
  await page.goto(`${EP}/shots/${shot.id}/spatial`);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.goto(`/projects/ojousama/locations/${shot.location_id}/3d?shot=${shot.id}`);
  await expect(page).toHaveURL(/\/login\?next=/);
  const r = await page.request.get(`/api/projects/ojousama/shots/${shot.id}/package`);
  expect(r.status()).toBe(401);
});

test("A — Shot Prep → Open Spatial Workspace: the route owns the Shot; Create 3D Set makes THE Location's set", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await signIn(page);
  A = await shotOf(page, "1A");
  B = await shotOf(page, "1B");
  await openWorkspace(page, A);
  await expect(page.getByRole("heading", { name: "Spatial Workspace — Shot 1A" })).toBeVisible();
  await expect(page.getByText("Tokyo Night Streets").first()).toBeVisible(); // the CURRENT Location
  await expect(set(page)).toHaveAttribute("data-mode", "shot");
  await expect(set(page)).toHaveAttribute("data-shot-id", A.id);
  await expect(page.getByTestId("shot-select")).toHaveCount(0);
  await expect(page.getByTestId("new-set-state")).toBeVisible(); // the Location has no 3D Set yet

  await page.getByTestId("load-test-set").click();
  await expect(page.getByTestId("set-status")).toContainText("Hotel Canopy", { timeout: 60_000 });
  await setInput(page, "camera-pos-x", "1");
  await saveSet(page, "3D Set created");
  sceneId = await attr(page, "data-scene-document-id");
  const rows = await sql<{ id: string; location_id: string }>(
    `select id, location_id from location_scene_documents where id = $1`,
    [sceneId],
  );
  expect(rows[0]?.location_id).toBe(original1A!.location_id); // THE Location's row, nothing Shot-owned
  await page.getByTestId("link-shot-camera").click();
  await expect(page.getByTestId("set-status")).toContainText("linked", { timeout: 60_000 });

  // refresh: the same hosted server truth
  await page.reload();
  await ready(page);
  await expect(set(page)).toHaveAttribute("data-scene-document-id", sceneId);
  await expect(set(page)).toHaveAttribute("data-dirty", "false");
  await expect(page.getByTestId("bookmark-info")).toBeVisible();
});

test("B — Location page selector A → B is a navigation; B remounts from hosted truth with no A state", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signIn(page);
  await page.goto(`${A.prepUrl}?section=set`);
  await page.getByTestId("open-in-3d-set").click();
  await page.waitForURL(new RegExp(`/3d\\?shot=${A.id}`), { timeout: 60_000 });
  await ready(page);
  await expect(page.getByTestId("bookmark-info")).toBeVisible();

  await page.getByTestId("shot-select").selectOption(B.id);
  await expect(page).toHaveURL(new RegExp(`[?&]shot=${B.id}`), { timeout: 60_000 });
  await expect(set(page)).toHaveAttribute("data-shot-id", B.id, { timeout: 60_000 });
  await ready(page);
  await expect(set(page)).toHaveAttribute("data-scene-document-id", sceneId); // the same shared Location set
  await expect(page.getByTestId("bookmark-info")).toHaveCount(0); // A's camera is not B's
  expect(await workspaceFrames(page)).toEqual([]);

  await page.getByTestId("shot-select").selectOption(A.id);
  await expect(page).toHaveURL(new RegExp(`[?&]shot=${A.id}`), { timeout: 60_000 });
  await ready(page);
  await expect(page.getByTestId("bookmark-info")).toBeVisible();
});

test("D — Master Frame with 0049 provenance → Use as Production Frame freezes the exact source", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await signIn(page);
  await openWorkspace(page, A);
  mf1 = await capture(page);
  const m = (await masterFrame(mf1))!;
  expect(m.scene_document_id).toBe(sceneId);
  expect(m.camera_fingerprint).toMatch(HEX); // server-derived camera provenance (0049)
  expect(m.camera_json?.schema).toBe("prism.render-camera.v1");
  expect(m.camera_json?.cameraFingerprint).toBe(m.camera_fingerprint);
  expect(m.base_environment_fingerprint).toMatch(HEX); // base-environment provenance (0049)
  for (const axis of ["scene", "camera", "blocking", "lighting"])
    await expect(page.getByTestId(`mf-axis-${mf1}-${axis}`)).toHaveAttribute("data-state", "fresh", {
      timeout: 60_000,
    });

  await page.getByTestId(`pf-use-master-${mf1}`).click();
  await expect(page.getByTestId(`pf-master-row-${mf1}`).getByTestId("pf-master-promoted")).toBeVisible({
    timeout: 60_000,
  });
  const pfs = await productionFrames(A.id);
  expect(pfs).toHaveLength(1);
  expectFrozenFrom(pfs[0]!, m); // accepted by 0049's exact-source trigger on hosted
  expect((await pkg(page, A.id)).references.productionFrame?.sourceSpatial?.masterFrameId).toBe(mf1);

  await page.goto(`${A.prepUrl}?section=production_frame`);
  await expect(page.getByTestId("pf-selected")).toHaveAttribute("data-source", "previs_master");
  await expect(page.getByTestId("pf-lineage-source")).toContainText("From 3D Master Frame captured");
  await expect(page.getByTestId("pf-lineage-provenance")).toContainText(m.scene_fingerprint.slice(0, 12));
  await expect(page.getByTestId(`pf-master-axes-${mf1}-scene`)).toHaveAttribute("data-state", "fresh");
});

test("E — stale: Use as Production Frame asks first; a digest that changed meanwhile promotes nothing", async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  await signIn(page);
  await openWorkspace(page, A);
  mf2 = await capture(page);
  const m2 = (await masterFrame(mf2))!;
  await setInput(page, "camera-pos-x", "3"); // a Location-owned Set change: mf2 becomes STALE SCENE
  await saveSet(page, "Saved — revision");

  await page.goto(`${A.prepUrl}?section=production_frame`);
  await expect(page.getByTestId(`pf-master-axes-${mf2}-scene`)).toHaveAttribute("data-state", "stale");
  await expect(page.getByTestId(`pf-master-axes-${mf1}-scene`)).toHaveAttribute("data-state", "stale");
  const confirm = page.getByTestId(`pf-master-confirm-${mf2}`);
  await page.getByTestId(`pf-use-master-${mf2}`).click();
  await expect(confirm).toContainText("STALE SCENE", { timeout: 60_000 });
  expect(await productionFrames(A.id)).toHaveLength(1); // asked first: nothing promoted

  // the 3D setup changes again (another tab) after the user saw the reasons: the old digest promotes nothing
  const other = await browser.newPage();
  await signIn(other);
  await openWorkspace(other, A);
  await setInput(other, "camera-pos-x", "4");
  await saveSet(other, "Saved — revision");
  await other.close();
  await page.getByTestId(`pf-use-master-anyway-${mf2}`).click();
  await expect(confirm).toContainText("STALE SCENE", { timeout: 60_000 });
  expect(await productionFrames(A.id)).toHaveLength(1);

  await page.getByTestId(`pf-use-master-anyway-${mf2}`).click();
  await expect(page.getByTestId(`pf-master-row-${mf2}`).getByTestId("pf-master-promoted")).toBeVisible({
    timeout: 60_000,
  });
  const pfs = await productionFrames(A.id);
  expect(pfs).toHaveLength(2);
  expectFrozenFrom(pfs[1]!, m2); // the SOURCE setup, never the current one
  const current = (
    await sql<{ scene_fingerprint: string }>(
      `select scene_fingerprint from location_scene_documents where id = $1`,
      [sceneId],
    )
  )[0]!;
  expect(pfs[1]!.source_scene_fingerprint).not.toBe(current.scene_fingerprint);
});

test("F — source deletion: the Production Frame stays selected with its frozen provenance", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await sql(`delete from scene_master_frames where id = $1`, [mf2]); // acceptance-owned frame only
  await signIn(page);
  await page.goto(`${A.prepUrl}?section=production_frame`);
  await expect(page.getByTestId("pf-selected")).toHaveAttribute("data-source", "previs_master");
  await expect(page.getByTestId("pf-lineage-missing")).toContainText(
    "Source Master Frame no longer exists; frozen source provenance retained.",
  );
  await expect(page.getByTestId("pf-preview")).toBeVisible();
  const pfs = await productionFrames(A.id);
  expect(pfs[1]!.source_master_frame_id).toBe(mf2);
  expect(pfs[1]!.source_scene_fingerprint).toMatch(HEX);
});

test("C — current Location authority: after A → another Location, the old set's rows are history only", async ({
  page,
}) => {
  test.setTimeout(400_000);
  await signIn(page);
  await page.goto(`${A.prepUrl}?section=set`);
  const select = page.locator('select[name="spatial.locationId"]');
  const sedan = await select.evaluate(
    (el) =>
      [...(el as HTMLSelectElement).options].find((o) => o.textContent?.startsWith("Black Luxury Sedan"))!
        .value,
  );
  await select.selectOption(sedan);
  await page.getByRole("button", { name: "Save location / set" }).click();
  await expect
    .poll(
      async () =>
        (await sql<{ location_id: string }>(`select location_id from shots where id = $1`, [A.id]))[0]!
          .location_id,
      {
        timeout: 60_000,
      },
    )
    .toBe(sedan);

  await openWorkspace(page, A);
  await expect(page.getByText("Black Luxury Sedan").first()).toBeVisible();
  await expect(page.getByTestId("new-set-state")).toBeVisible(); // the Sedan has no set: Tokyo's is NOT loaded
  await expect(set(page)).toHaveAttribute("data-scene-document-id", "");
  await expect(page.getByTestId("bookmark-info")).toHaveCount(0); // the Tokyo bookmark is history
  await expect(page.getByTestId("master-frame-other-set").first()).toBeVisible(); // mf1 shown as another Location's
  await expect(page.getByTestId(`mf-axis-${mf1}-scene`)).toHaveAttribute("data-state", "stale");

  // restore the assignment (the afterAll also restores the exact prior row, updated_at included)
  await page.goto(`${A.prepUrl}?section=set`);
  await page.locator('select[name="spatial.locationId"]').selectOption(original1A!.location_id!);
  await page.getByRole("button", { name: "Save location / set" }).click();
  await expect
    .poll(
      async () =>
        (await sql<{ location_id: string }>(`select location_id from shots where id = $1`, [A.id]))[0]!
          .location_id,
      {
        timeout: 60_000,
      },
    )
    .toBe(original1A!.location_id);
});

test("G — no Location: the optional spatial empty state, no editor; the image-first path is offered", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = (
    await sql<{ id: string }>(
      `select s.id from shots s join projects p on p.id = s.project_id
      where p.slug = 'continuity-smoke-test' and s.location_id is null order by s.shot_code limit 1`,
    )
  )[0]!;
  await signIn(page);
  const prep = `/projects/continuity-smoke-test/episodes/ep-1/shots/${s.id}`;
  await page.goto(`${prep}/spatial`);
  await expect(page.getByTestId("workspace-no-location")).toContainText(
    "Assign a Location to use optional spatial tools.",
  );
  await expect(set(page)).toHaveCount(0);
  await page.goto(`${prep}?section=production_frame`);
  await expect(page.getByTestId("pf-upload-file")).toBeAttached();
});

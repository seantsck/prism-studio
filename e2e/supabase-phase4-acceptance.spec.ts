import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import pg from "pg";
import { expect, test, type Page } from "@playwright/test";
import { getPrismStudioDevCredentials } from "./dev-credentials";
import { assertProjectRef } from "../scripts/lib/safety.mjs";
import { encodeSplatFile, syntheticPlane } from "../src/lib/splat/synthetic";

/**
 * Phase 4F — Phase 4 production acceptance on the REAL stack: Supabase Auth + RLS, the hosted Prism Studio database at
 * migration 0050 and PRIVATE Storage, with the app running LOCALLY (no deploy) and no provider call (local WebGL only;
 * the mock provider is the only one configured).
 *
 * One owner story across every Phase 4 slice, in production order:
 *   A   Shot 1A builds a Shot-owned setup on Tokyo Night Streets' set: camera, blocking, a Shot Lighting Rig (4B, 4C)
 *   B   1A captures a Master Frame and promotes it: the Production Frame freezes the exact source lineage (4C)
 *   C   1B copies 1A's setup Shot-to-Shot: its own rows, attributed in copy history (4D-I1)
 *   D   1A saves a named template; later edits to 1A change neither the template nor 1A's Production Frame (4D-I2, 4C)
 *   E   1B applies the template: a second attributed copy; 1B's own edits never reach the template or 1A (4D)
 *   F   the template is deleted: 1B stays complete and its history keeps the name (4D)
 *   G   1B captures and promotes its own Master Frame, lit by its own rig only (4B, 4C, 4D)
 *   H   1C's set gets a Gaussian splat: viewable, control passes refused, a stale calibration refused before write (4E)
 *   I   image-first: 1C takes an uploaded Production Frame with no 3D step; a Shot with no Location is offered the same
 *   J   final state: every Shot has a usable, selected Production Frame and a package that names it
 *
 * Isolation: the hosted demo holds no 3D data, templates or Production Frames of its own (asserted), so every such row
 * is this run's. Cleanup: this run's copy history and Production Frames (append-only for API roles: removed as the
 * database owner, as earlier acceptance specs do), then scripts/previs-cleanup.mts with this run's e2e prefix (scenes
 * and, by cascade, bookmarks, rigs, blocking and templates; Master Frames, reconstructions, render, splat and uploaded
 * assets and their Storage objects). The afterAll asserts nothing is left and the Shots' own rows are unchanged.
 */
const { email: EMAIL, password: PASSWORD } = getPrismStudioDevCredentials();
const EP = "/projects/ojousama/episodes/ep-1";
const RUN_START = new Date().toISOString();
const PREFIX = `e2e-4f-${Date.now()}`;
const NAME = "4F Night key";
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
async function readOnly<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const url = process.env.SUPABASE_DB_URL!;
  assertProjectRef(url, "SUPABASE_DB_URL", process.env);
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("begin transaction read only");
    const rows = (await client.query(text, params)).rows as T[];
    await client.query("rollback");
    return rows;
  } finally {
    await client.end();
  }
}

const DEMO = `(select id from projects where slug = 'ojousama')`;
const previsCleanup = () =>
  execFileSync(
    "npx",
    ["tsx", "--env-file=.env.local", "scripts/previs-cleanup.mts", "--yes", `--e2e-assets-prefix=${PREFIX}`],
    {
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
    },
  );

async function cleanup() {
  // append-only for API roles; the hosted demo had none of either before this run (asserted in beforeAll)
  await sql(`delete from shot_setup_copies where project_id in ${DEMO} and copied_at >= $1`, [RUN_START]);
  await sql(
    `delete from shot_production_frame_selections where production_frame_id in
       (select id from shot_production_frames where project_id in ${DEMO} and created_at >= $1)`,
    [RUN_START],
  );
  await sql(`delete from shot_production_frames where project_id in ${DEMO} and created_at >= $1`, [
    RUN_START,
  ]);
  try {
    previsCleanup();
  } catch {
    /* best effort; idempotent (checked again by the afterAll assertion) */
  }
}

async function leftovers() {
  return (
    await readOnly<Record<string, number>>(
      `select (select count(*)::int from location_scene_documents where project_id in ${DEMO}) scenes,
              (select count(*)::int from shot_setup_templates where project_id in ${DEMO}) templates,
              (select count(*)::int from shot_setup_copies where project_id in ${DEMO}) copies,
              (select count(*)::int from shot_camera_bookmarks where project_id in ${DEMO}) bookmarks,
              (select count(*)::int from shot_light_rigs where project_id in ${DEMO}) rigs,
              (select count(*)::int from shot_character_blocking where project_id in ${DEMO}) blocking,
              (select count(*)::int from scene_master_frames where project_id in ${DEMO}) frames,
              (select count(*)::int from shot_production_frames where project_id in ${DEMO}) pfs,
              (select count(*)::int from location_spatial_reconstructions where project_id in ${DEMO}) reconstructions`,
    )
  )[0]!;
}
const NONE = {
  scenes: 0,
  templates: 0,
  copies: 0,
  bookmarks: 0,
  rigs: 0,
  blocking: 0,
  frames: 0,
  pfs: 0,
  reconstructions: 0,
};
const shotRows = () =>
  readOnly(
    `select s.shot_code, s.location_id, s.spatial from shots s join projects p on p.id = s.project_id
      where p.slug = 'ojousama' and s.shot_code in ('1A', '1B', '1C') order by s.shot_code`,
  );
let originalShots = "";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
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
async function open(page: Page, s: ShotRef) {
  await page.goto(s.spatialUrl);
  await expect(set(page)).toHaveAttribute("data-ready", "true", { timeout: 90_000 });
  await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
    timeout: 60_000,
  });
  await expect(page.getByTestId("shot-lighting")).toHaveAttribute("data-loaded", "true", { timeout: 60_000 });
}
const setInput = async (page: Page, testId: string, value: string) => {
  const input = page.getByTestId(testId);
  await input.fill(value);
  await input.press("Enter");
  await expect(input).toHaveValue(value);
};
async function saveLight(page: Page, intensity: string) {
  if ((await page.getByTestId("light-intensity").count()) === 0) {
    await page.getByTestId("lighting-base-mode").selectOption("replace");
    await page.getByTestId("lighting-add-type").selectOption("point");
    await page.getByTestId("lighting-add").click();
  }
  await page.getByTestId("light-intensity").fill(intensity);
  await page.getByTestId("lighting-save").click();
  await expect(page.getByTestId("shot-lighting")).toHaveAttribute("data-dirty", "false", { timeout: 60_000 });
}
const lightingFp = async (page: Page) =>
  (await page.getByTestId("shot-lighting").getAttribute("data-saved-fingerprint")) ?? "";
const templateRow = (page: Page) => page.getByTestId("setup-template").filter({ hasText: NAME });

const rigFp = async (shotId: string) =>
  (
    await readOnly<{ lighting_fingerprint: string }>(
      `select lighting_fingerprint from shot_light_rigs where shot_id = $1`,
      [shotId],
    )
  )[0]?.lighting_fingerprint ?? null;
/** a Shot's own setup rows, as one hash (copied values live here and only here) */
const shotSetup = async (shotId: string) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        await readOnly(
          `select 'camera' k, to_jsonb(b) - 'updated_at' r from shot_camera_bookmarks b where shot_id = $1
           union all select 'lighting', to_jsonb(l) - 'updated_at' from shot_light_rigs l where shot_id = $1
           union all select 'blocking:' || character_id, to_jsonb(f) - 'updated_at' from shot_character_blocking f where shot_id = $1
           order by 1`,
          [shotId],
        ),
      ),
    )
    .digest("hex");
type TemplateRow = {
  id: string;
  revision: number;
  content_fingerprint: string;
  source_shot_code: string | null;
};
const templateDb = async () =>
  (
    await readOnly<TemplateRow>(
      `select id, revision, content_fingerprint, source_shot_code
         from shot_setup_templates where project_id in ${DEMO} and name = $1`,
      [NAME],
    )
  )[0] ?? null;

// ── Master Frames and Production Frames (the 4C lineage) ──
const workspaceFrames = (page: Page) =>
  page
    .locator('[data-testid^="workspace-promote-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("workspace-promote-", "")));
async function capture(page: Page): Promise<string> {
  const before = await workspaceFrames(page);
  await page.getByTestId("capture-master-frame").click();
  await expect(page.getByTestId("set-status")).toContainText("Master frame saved", { timeout: 120_000 });
  await expect
    .poll(async () => (await workspaceFrames(page)).length, { timeout: 60_000 })
    .toBe(before.length + 1);
  return (await workspaceFrames(page)).find((id) => !before.includes(id))!;
}
type Mf = {
  id: string;
  scene_fingerprint: string;
  camera_fingerprint: string | null;
  blocking_fingerprint: string | null;
  lighting_fingerprint: string | null;
  base_environment_fingerprint: string | null;
};
const masterFrame = async (id: string) =>
  (
    await readOnly<Mf>(
      `select id, scene_fingerprint, camera_fingerprint, blocking_fingerprint, lighting_fingerprint,
              base_environment_fingerprint from scene_master_frames where id = $1`,
      [id],
    )
  )[0]!;
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
  readOnly<Pf>(
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
async function promote(page: Page, mf: string) {
  await page.getByTestId(`pf-use-master-${mf}`).click();
  await expect(page.getByTestId(`pf-master-row-${mf}`).getByTestId("pf-master-promoted")).toBeVisible({
    timeout: 60_000,
  });
}
type Pkg = {
  references: { productionFrame?: { frameId: string; sourceSpatial?: { masterFrameId: string } } };
};
const pkg = async (page: Page, shotId: string): Promise<Pkg> => {
  const r = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
  expect(r.ok()).toBe(true);
  return (await r.json()) as Pkg;
};

/** A valid RGB PNG (header facts and bytes only). */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (b: Buffer) => {
    let c = 0xffffffff;
    for (const byte of b) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
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

let A: ShotRef;
let B: ShotRef;
let C: ShotRef;
let mfA = "";
let pfA: Pf;
let templateRigFp = "";
let template: TemplateRow;

test.beforeAll(async () => {
  const head = await readOnly<{ m: string }>("select max(name) m from prism_migrations");
  expect(head[0]!.m, "hosted DEV is at 0050").toBe("0050_shot_setup_templates.sql");
  await cleanup(); // a previous aborted run's fixtures (none expected)
  expect(
    await leftovers(),
    "the hosted demo has no 3D data, templates or Production Frames of its own",
  ).toEqual(NONE);
  originalShots = JSON.stringify(await shotRows());
});

test.afterAll(async () => {
  await cleanup();
  expect(await leftovers(), "nothing of this run is left").toEqual(NONE);
  expect(JSON.stringify(await shotRows()), "1A / 1B / 1C rows are unchanged").toBe(originalShots);
});

test("anonymous: the Shot Spatial Workspace redirects to login", async ({ page }) => {
  const s = (
    await readOnly<{ id: string }>(
      `select s.id from shots s join projects p on p.id = s.project_id where p.slug='ojousama' and s.shot_code='1A'`,
    )
  )[0]!;
  await page.goto(`${EP}/shots/${s.id}/spatial`);
  await expect(page).toHaveURL(/\/login\?next=/);
});

test("A — 1A builds one Shot-owned setup: set, camera, blocking, Shot Lighting Rig", async ({ page }) => {
  test.setTimeout(600_000);
  await signIn(page);
  A = await shotOf(page, "1A");
  B = await shotOf(page, "1B");
  C = await shotOf(page, "1C");
  await open(page, A);
  await page.getByTestId("load-test-set").click();
  await expect(page.getByTestId("set-status")).toContainText("Hotel Canopy", { timeout: 60_000 });
  await setInput(page, "camera-pos-x", "1");
  await page.getByTestId("save-set").click();
  await expect(page.getByTestId("set-status")).toContainText("3D Set created", { timeout: 60_000 });
  await expect(page.getByTestId("environment-status"), "no splat: no Environment panel").toHaveCount(0);
  await page.getByTestId("link-shot-camera").click();
  await expect(page.getByTestId("set-status")).toContainText("linked", { timeout: 60_000 });
  await page.getByTestId("blocking-character").selectOption({ label: "Yumeko" });
  await page.getByTestId("add-character-proxy").click();
  await setInput(page, "blocking-pos-x", "2");
  await page.getByTestId("save-blocking").click();
  await expect(page.getByTestId("blocking-status")).toContainText("Character blocking saved", {
    timeout: 60_000,
  });
  await saveLight(page, "200");
  expect(await lightingFp(page)).toMatch(HEX);
  expect(await rigFp(A.id)).toBe(await lightingFp(page));
});

test("B — 1A's Master Frame becomes its Production Frame with the exact source frozen", async ({ page }) => {
  test.setTimeout(600_000);
  await signIn(page);
  await open(page, A);
  mfA = await capture(page);
  const m = await masterFrame(mfA);
  expect(m.camera_fingerprint).toMatch(HEX);
  expect(m.lighting_fingerprint).toBe(await rigFp(A.id));
  for (const axis of ["scene", "camera", "blocking", "lighting"])
    await expect(page.getByTestId(`mf-axis-${mfA}-${axis}`)).toHaveAttribute("data-state", "fresh", {
      timeout: 60_000,
    });
  await promote(page, mfA);
  const pfs = await productionFrames(A.id);
  expect(pfs).toHaveLength(1);
  pfA = pfs[0]!;
  expectFrozenFrom(pfA, m);
  expect((await pkg(page, A.id)).references.productionFrame?.sourceSpatial?.masterFrameId).toBe(mfA);
});

test("C — 1B copies 1A's setup Shot-to-Shot: its own rows, attributed in copy history", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  await open(page, B);
  const source = page.getByTestId("copy-setup-source");
  await source.selectOption({
    label: (await source.locator("option", { hasText: "Shot 1A" }).textContent())!,
  });
  await expect(page.getByTestId("copy-setup-preview")).toBeVisible({ timeout: 60_000 });
  expect(await rigFp(B.id), "the review wrote nothing").toBeNull();
  await page.getByTestId("copy-setup-confirm").click();
  await page.waitForURL(/copiedFrom=/, { timeout: 60_000 });
  await expect(page.getByTestId("copy-setup-done")).toContainText("from Shot 1A");
  expect(await rigFp(B.id)).toBe(await rigFp(A.id));
  const own = await readOnly<{ n: number }>(
    `select (select count(*)::int from shot_camera_bookmarks where shot_id = $1) +
            (select count(*)::int from shot_light_rigs where shot_id = $1) +
            (select count(*)::int from shot_character_blocking where shot_id = $1) n`,
    [B.id],
  );
  expect(own[0]!.n).toBe(3);
  const copies = await readOnly<{ source_kind: string; source_shot_code: string | null }>(
    `select source_kind, source_shot_code from shot_setup_copies where shot_id = $1`,
    [B.id],
  );
  expect(copies).toEqual([{ source_kind: "shot", source_shot_code: "1A" }]);
});

test("D — 1A saves a named template; editing 1A later changes neither the template nor 1A's Production Frame", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signIn(page);
  await open(page, A);
  await page.getByTestId("template-name").fill(NAME);
  await page.getByTestId("template-save").click();
  await expect(templateRow(page)).toHaveCount(1, { timeout: 60_000 });
  template = (await templateDb())!;
  expect(template).toMatchObject({ revision: 1, source_shot_code: "1A" });
  expect(template.content_fingerprint).toMatch(HEX);
  templateRigFp = (await rigFp(A.id))!;

  await saveLight(page, "900"); // 1A moves on
  expect(await rigFp(A.id)).not.toBe(templateRigFp);
  const t = (await templateDb())!;
  expect(t.revision, "a template is a snapshot, not a live link").toBe(1);
  expect(t.content_fingerprint).toBe(template.content_fingerprint);
  const pfs = await productionFrames(A.id);
  expect(pfs, "promotion froze the lineage: no new frame, the old row unchanged").toEqual([pfA]);
  // the Master Frame now reads as stale on lighting, never silently rewritten
  await expect(page.getByTestId(`mf-axis-${mfA}-lighting`)).toHaveAttribute("data-state", "stale", {
    timeout: 60_000,
  });
});

test("E — 1B applies the template: a second attributed copy; 1B's own edits reach neither the template nor 1A", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signIn(page);
  await open(page, B);
  // 1B already holds exactly what the template snapshots (it copied 1A first), so the app offers no no-op copy
  // ("Already identical"). 1B makes its own lighting decision first; applying the template then replaces it.
  await saveLight(page, "50");
  expect(await rigFp(B.id)).not.toBe(templateRigFp);
  await page.getByTestId("copy-setup-source").selectOption({ label: `Template: ${NAME}` });
  await expect(page.getByTestId("copy-setup-preview")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("copy-setup-confirm")).toBeEnabled();
  await page.getByTestId("copy-setup-confirm").click();
  await page.waitForURL(/copiedTemplate=/, { timeout: 60_000 });
  await expect(page.getByTestId("copy-setup-done")).toContainText(
    `from ${NAME}; this Shot now owns its own copy`,
  );
  expect(await rigFp(B.id), "1B holds the template's values, not 1A's current ones").toBe(templateRigFp);
  const copies = await readOnly<{
    source_kind: string;
    template_name: string | null;
    template_revision: number | null;
  }>(
    `select source_kind, template_name, template_revision from shot_setup_copies where shot_id = $1 order by copied_at`,
    [B.id],
  );
  expect(copies).toEqual([
    { source_kind: "shot", template_name: null, template_revision: null },
    { source_kind: "template", template_name: NAME, template_revision: 1 },
  ]);
  await open(page, B);
  await expect(page.getByTestId("setup-copy-history-line").first()).toContainText(
    `template “${NAME}” (revision 1)`,
  );

  const aBefore = await shotSetup(A.id);
  await saveLight(page, "7");
  const t = (await templateDb())!;
  expect(t.revision).toBe(1);
  expect(t.content_fingerprint).toBe(template.content_fingerprint);
  expect(await shotSetup(A.id), "1A's rows are untouched").toBe(aBefore);
});

test("F — the template is deleted: 1B stays complete and its history keeps the name", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  const bBefore = await shotSetup(B.id);
  await open(page, A);
  await templateRow(page).getByTestId("template-delete").click();
  await expect(templateRow(page)).toHaveCount(0, { timeout: 60_000 });
  expect(await templateDb()).toBeNull();
  expect(await shotSetup(B.id), "no 1B row touched").toBe(bBefore);
  const kept = await readOnly<{ template_id: string | null; template_name: string }>(
    `select template_id, template_name from shot_setup_copies where shot_id = $1 and source_kind = 'template'`,
    [B.id],
  );
  expect(kept).toEqual([{ template_id: null, template_name: NAME }]);
  await open(page, B);
  await expect(page.getByTestId("setup-copy-history-line").first()).toContainText("template since deleted");
});

test("G — 1B captures and promotes its own Master Frame, lit by its own rig only", async ({ page }) => {
  test.setTimeout(600_000);
  await signIn(page);
  await open(page, B);
  const own = (await rigFp(B.id))!;
  const mfB = await capture(page);
  const m = await masterFrame(mfB);
  expect(m.lighting_fingerprint).toBe(own);
  expect(m.camera_fingerprint).toMatch(HEX);
  await promote(page, mfB);
  const pfs = await productionFrames(B.id);
  expect(pfs).toHaveLength(1);
  expectFrozenFrom(pfs[0]!, m);
  expect(await productionFrames(A.id), "1A's frame is unaffected").toEqual([pfA]);
});

test("H — 1C's set holds a Gaussian splat: viewable, control passes refused, a stale calibration refused before write", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await signIn(page);
  await page.goto(C.spatialUrl);
  await expect(page.getByTestId("new-set-state")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("load-test-set").click();
  await expect(page.getByTestId("set-status")).toContainText("Hotel Canopy", { timeout: 60_000 });
  await page.getByTestId("save-set").click();
  await expect(page.getByTestId("set-status")).toContainText("3D Set created", { timeout: 60_000 });
  await open(page, C);

  await page.getByTestId("import-splat-file").setInputFiles({
    name: `${PREFIX}-plane.splat`,
    mimeType: "application/octet-stream",
    buffer: Buffer.from(encodeSplatFile(syntheticPlane({ n: 24, size: 2 }))),
  });
  await page.getByTestId("import-splat").click();
  const splat = page.getByTestId("outliner-item").filter({ hasText: "gaussian splat" });
  await expect(splat).toHaveCount(1, { timeout: 120_000 });
  const env = page.getByTestId("environment-status");
  await expect(env).toHaveAttribute("data-status", "view_only");
  await expect(page.getByTestId("environment-op-control-passes")).toHaveAttribute(
    "data-state",
    "unavailable",
  );
  await expect(page.getByTestId("environment-op-framing")).toHaveAttribute("data-state", "limited");
  await expect(page.getByTestId("capture-spatial-passes")).toBeDisabled();

  await splat.click();
  await page.getByTestId("splat-metres-per-unit").fill("0.5");
  await page.getByTestId("splat-apply-scale").click();
  await expect(page.getByTestId("environment-op-framing")).toHaveAttribute("data-state", "available");
  await page.getByTestId("save-set").click();
  await expect(page.getByTestId("set-status")).toContainText(/Saved — revision/, { timeout: 60_000 });
  const revision = async () =>
    (
      await readOnly<{ revision: number; scene_fingerprint: string }>(
        `select d.revision, d.scene_fingerprint from location_scene_documents d join shots s on s.location_id = d.location_id
          where s.id = $1`,
        [C.id],
      )
    )[0]!;
  const saved = await revision();
  expect(
    (
      await readOnly<{ n: number }>(
        `select count(*)::int n from location_spatial_reconstructions where project_id in ${DEMO}`,
      )
    )[0]!.n,
  ).toBe(1);

  // scale one axis after calibrating: refused, and the hosted Set is unchanged
  const z = page.getByTestId("inspector-scale-z");
  await z.fill("0.8");
  await z.press("Enter");
  await expect(page.getByTestId("environment-issue")).toHaveAttribute("data-code", "SPLAT_CALIBRATION_STALE");
  await page.getByTestId("save-set").click();
  await expect(page.getByTestId("set-status")).toContainText("scaled after its calibration");
  expect(await revision(), "nothing was written").toEqual(saved);
  await page.getByTestId("splat-apply-scale").click();
  await expect(env).toHaveAttribute("data-status", "view_only");
});

test("I — image-first: 1C takes an uploaded Production Frame with no 3D step; a Shot with no Location is offered the same", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signIn(page);
  await page.goto(`${C.prepUrl}?section=production_frame`);
  const pf = page.getByTestId("production-frame-section");
  await pf.getByTestId("pf-upload-file").setInputFiles({
    name: `${PREFIX}-upload.png`,
    mimeType: "image/png",
    buffer: png(956, 400, [70, 120, 190]),
  });
  await pf.getByTestId("pf-upload-submit").click();
  await expect(pf.getByTestId("pf-selected")).toHaveAttribute("data-source", "upload", { timeout: 60_000 });
  await expect(pf.getByTestId("pf-selected")).toContainText("956×400");
  const src = (await pf.getByTestId("pf-preview").getAttribute("src"))!;
  expect(src).toMatch(/^\/api\/assets\/[0-9a-f-]{36}$/); // private route, never a Storage URL

  const noLocation = (
    await readOnly<{ id: string }>(
      `select s.id from shots s join projects p on p.id = s.project_id
        where p.slug = 'continuity-smoke-test' and s.location_id is null order by s.shot_code limit 1`,
    )
  )[0]!;
  const prep = `/projects/continuity-smoke-test/episodes/ep-1/shots/${noLocation.id}`;
  await page.goto(`${prep}/spatial`);
  await expect(page.getByTestId("workspace-no-location")).toContainText(
    "Assign a Location to use optional spatial tools.",
  );
  await expect(set(page)).toHaveCount(0);
  await page.goto(`${prep}?section=production_frame`);
  await expect(page.getByTestId("pf-upload-file")).toBeAttached();
});

test("J — final state: every Shot has a usable, selected Production Frame that its package names", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signIn(page);
  const expected: Array<[ShotRef, string]> = [
    [A, "previs_master"],
    [B, "previs_master"],
    [C, "upload"],
  ];
  for (const [shot, source] of expected) {
    await page.goto(`${shot.prepUrl}?section=production_frame`);
    await expect(page.getByTestId("pf-selected")).toHaveAttribute("data-source", source, { timeout: 60_000 });
    await expect(page.getByTestId("pf-preview")).toHaveJSProperty("complete", true);
    const selected = await readOnly<{ id: string }>(
      `select production_frame_id id from shot_production_frame_selections where shot_id = $1`,
      [shot.id],
    );
    expect(selected).toHaveLength(1);
    expect((await pkg(page, shot.id)).references.productionFrame?.frameId).toBe(selected[0]!.id);
  }
  // 1A's lineage is still the frame it froze, after everything else this story did
  expect(await productionFrames(A.id)).toEqual([pfA]);
});

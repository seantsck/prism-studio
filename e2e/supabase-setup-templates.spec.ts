import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { getPrismStudioDevCredentials } from "./dev-credentials";
import { assertProjectRef } from "../scripts/lib/safety.mjs";

/**
 * Phase 4D-B on the REAL stack: Supabase Auth + RLS, the hosted Prism Studio database at migration 0050 and PRIVATE
 * Storage, with the app running LOCALLY (no deploy) and no provider call (local WebGL rendering only).
 *
 * OWNER: Shot 1A builds a setup on Tokyo Night Streets' set and saves it as a named template; Shot 1B reviews and applies
 * it and owns its own copy (copy history records it); edits on either side never reach the other; a Shot on another
 * Location's set is refused. NON-OWNER (a real temporary Auth user, its own sessions only; skipped without
 * PRISM_STUDIO_NONOWNER_EMAIL / PRISM_STUDIO_NONOWNER_PASSWORD): while the owner's template and copy history EXIST, no
 * page, server action or Data API call reveals or changes them, and a real template id is answered exactly like a random
 * or malformed one. Then the OWNER deletes the template: 1B stays complete and captures a Master Frame from its own rows.
 *
 * Isolation: the hosted demo has no 3D data and no templates of its own (asserted), so every such row is this spec's.
 * Cleanup: this run's copy-history rows (append-only for API roles: removed as the database owner, as db:setup-templates
 * does), then scripts/previs-cleanup.mts (scenes, and with them bookmarks, rigs, blocking and templates by cascade;
 * Master Frames, render assets and their Storage objects). The afterAll asserts nothing is left and the Shots' own rows
 * are unchanged.
 */
const { email: EMAIL, password: PASSWORD } = getPrismStudioDevCredentials();
const NONOWNER_EMAIL = process.env.PRISM_STUDIO_NONOWNER_EMAIL?.trim() ?? "";
const NONOWNER_PASSWORD = process.env.PRISM_STUDIO_NONOWNER_PASSWORD ?? "";
const OWNER_TITLE = "お嬢様、僕と結婚してください。";
const EP = "/projects/ojousama/episodes/ep-1";
const RUN_START = new Date().toISOString();
const NAME = "4D-B Night key";
const HEX = /^[0-9a-f]{64}$/;
const PROJECT_GONE = "That project no longer exists.";
const TEMPLATE_OTHER_SET =
  "This template was saved on another 3D set. A setup can only be copied onto the set its positions belong to.";

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

async function cleanup() {
  // copy history is append-only for every API role; the database owner removes this run's rows (none existed before)
  await sql(`delete from shot_setup_copies where project_id in ${DEMO} and copied_at >= $1`, [RUN_START]);
  try {
    previsCleanup(); // scenes → bookmarks, rigs, blocking and templates by cascade; Master Frames + their Storage
  } catch {
    /* best effort; idempotent (checked again by the afterAll assertion) */
  }
}

/** The three Shots' own `shots` rows, content only (updated_at is trigger-managed). */
const shotRows = () =>
  readOnly(
    `select s.shot_code, s.location_id, s.spatial from shots s join projects p on p.id = s.project_id
      where p.slug = 'ojousama' and s.shot_code in ('1A', '1B', '1C') order by s.shot_code`,
  );
let originalShots = "";

async function leftovers() {
  return (
    await readOnly<Record<string, number>>(
      `select (select count(*)::int from location_scene_documents where project_id in ${DEMO}) scenes,
              (select count(*)::int from shot_setup_templates where project_id in ${DEMO}) templates,
              (select count(*)::int from shot_setup_copies where project_id in ${DEMO}) copies,
              (select count(*)::int from shot_camera_bookmarks where project_id in ${DEMO}) bookmarks,
              (select count(*)::int from shot_light_rigs where project_id in ${DEMO}) rigs,
              (select count(*)::int from shot_character_blocking where project_id in ${DEMO}) blocking,
              (select count(*)::int from scene_master_frames where project_id in ${DEMO}) frames`,
    )
  )[0]!;
}
const NONE = { scenes: 0, templates: 0, copies: 0, bookmarks: 0, rigs: 0, blocking: 0, frames: 0 };

async function signIn(page: Page, email = EMAIL, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
}

type ShotRef = { code: string; id: string; spatialUrl: string };
async function shotOf(page: Page, code: string): Promise<ShotRef> {
  await page.goto(`${EP}/shots`);
  const href = (await page.getByRole("link", { name: code, exact: true }).first().getAttribute("href"))!;
  const id = /\/shots\/([0-9a-f-]{36})/.exec(href)![1]!;
  return { code, id, spatialUrl: `${EP}/shots/${id}/spatial` };
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

type TemplateRow = {
  id: string;
  revision: number;
  content_fingerprint: string;
  source_shot_code: string | null;
  scene_document_id: string;
};
const templateDb = async () =>
  (
    await readOnly<TemplateRow>(
      `select id, revision, content_fingerprint, source_shot_code, scene_document_id
         from shot_setup_templates where project_id in ${DEMO} and name = $1`,
      [NAME],
    )
  )[0] ?? null;
/** a Shot's own setup rows, as one hash (the copied values live here and only here) */
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
const rigFp = async (shotId: string) =>
  (
    await readOnly<{ lighting_fingerprint: string }>(
      `select lighting_fingerprint from shot_light_rigs where shot_id = $1`,
      [shotId],
    )
  )[0]?.lighting_fingerprint ?? null;

/** the app's own server action, called exactly as the browser does (see supabase-nonowner-isolation.spec.ts) */
const ACTIONS = () =>
  JSON.parse(readFileSync(path.join(process.cwd(), ".next/server/server-reference-manifest.json"), "utf8"))
    .node as Record<string, { exportedName: string }>;
const actionId = (name: string) => Object.entries(ACTIONS()).find(([, e]) => e.exportedName === name)![0];
async function callAction(page: Page, pagePath: string, name: string, fields: Record<string, string>) {
  return page.evaluate(
    async ({ id, fields, url }) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(`_1_${k}`, v);
      fd.append("0", '["$K1"]');
      const r = await fetch(url, {
        method: "POST",
        headers: { "Next-Action": id, Accept: "text/x-component" },
        body: fd,
      });
      return { status: r.status, body: await r.text() };
    },
    { id: actionId(name), fields, url: pagePath },
  );
}
/** the action's own `error` text from the RSC body (the response carries no owner data on refusal) */
const errorOf = (body: string) => /"error":"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? null;

let A: ShotRef;
let B: ShotRef;
let C: ShotRef;
let template: TemplateRow;
let ownerFingerprint = "";

async function ownerState(): Promise<string> {
  const parts: unknown[] = [];
  for (const t of [
    "projects",
    "shots",
    "locations",
    "location_scene_documents",
    "shot_camera_bookmarks",
    "shot_character_blocking",
    "shot_light_rigs",
    "scene_master_frames",
    "shot_setup_templates",
    "shot_setup_copies",
  ]) {
    const col = t === "projects" ? "id" : "project_id";
    parts.push([t, await readOnly(`select * from public.${t} where ${col} in ${DEMO} order by 1`)]);
  }
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

test.beforeAll(async () => {
  const head = await readOnly<{ m: string }>("select max(name) m from prism_migrations");
  expect(head[0]!.m, "hosted DEV is at 0050").toBe("0050_shot_setup_templates.sql");
  await cleanup(); // a previous aborted run's fixtures (none expected)
  expect(await leftovers(), "the hosted demo has no 3D data or templates of its own").toEqual(NONE);
  originalShots = JSON.stringify(await shotRows());
});

test.afterAll(async () => {
  await cleanup();
  expect(await leftovers(), "nothing of this run is left").toEqual(NONE);
  expect(JSON.stringify(await shotRows()), "1A / 1B / 1C rows are unchanged").toBe(originalShots);
});

test("anonymous: the Shot Spatial Workspace (template library) redirects to login", async ({ page }) => {
  const s = (
    await readOnly<{ id: string }>(
      `select s.id from shots s join projects p on p.id = s.project_id where p.slug='ojousama' and s.shot_code='1B'`,
    )
  )[0]!;
  await page.goto(`${EP}/shots/${s.id}/spatial`);
  await expect(page).toHaveURL(/\/login\?next=/);
});

test("A — Shot 1A builds a setup (camera, blocking, lighting) on Tokyo Night Streets' set", async ({
  page,
}) => {
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
});

test("E — 1A saves its setup as a named template: a value snapshot, listed on the set", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  await open(page, A);
  await page.getByTestId("template-name").fill(NAME);
  for (const c of ["camera", "lighting", "blocking"])
    await expect(page.getByTestId(`template-include-${c}`)).toBeChecked();
  await page.getByTestId("template-save").click();
  await expect(templateRow(page)).toHaveCount(1, { timeout: 60_000 });
  await expect(templateRow(page)).toContainText("camera, lighting, blocking");
  await expect(templateRow(page)).toContainText("saved from Shot 1A");
  template = (await templateDb())!;
  expect(template.revision).toBe(1);
  expect(template.source_shot_code).toBe("1A");
  expect(template.content_fingerprint).toMatch(HEX);
  expect(await templateRow(page).getAttribute("data-content-fingerprint")).toBe(template.content_fingerprint);
  // listed again after a reload (hosted truth)
  await page.reload();
  await expect(templateRow(page)).toHaveCount(1, { timeout: 60_000 });
});

test("F — 1B reviews, applies, and owns its own copy; copy history records it", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  await open(page, B);
  const bBefore = await shotSetup(B.id);
  await page.getByTestId("copy-setup-source").selectOption({ label: `Template: ${NAME}` });
  await expect(page.getByTestId("copy-setup-preview")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("copy-setup-from")).toContainText(NAME);
  expect(await shotSetup(B.id), "the review wrote nothing").toBe(bBefore);
  await page.getByTestId("copy-setup-confirm").click();
  await page.waitForURL(/copiedTemplate=/, { timeout: 60_000 });
  await expect(page.getByTestId("copy-setup-done")).toContainText(
    `from ${NAME}; this Shot now owns its own copy`,
  );
  await open(page, B);
  await expect(page.getByTestId("bookmark-info")).toBeVisible();
  expect(await lightingFp(page)).toBe(await rigFp(A.id)); // A's values when the template was saved
  await expect(page.getByTestId("setup-copy-history-line").first()).toContainText(
    `copied from template “${NAME}” (revision 1)`,
  );
  // the copied values are 1B's OWN rows; the history row is attribution only
  const own = await readOnly<{ n: number }>(
    `select (select count(*)::int from shot_camera_bookmarks where shot_id = $1) +
            (select count(*)::int from shot_light_rigs where shot_id = $1) +
            (select count(*)::int from shot_character_blocking where shot_id = $1) n`,
    [B.id],
  );
  expect(own[0]!.n).toBe(3);
  const copies = await readOnly<{
    source_kind: string;
    template_id: string;
    template_name: string;
    template_revision: number;
    components: string[];
  }>(
    `select source_kind, template_id, template_name, template_revision, components from shot_setup_copies where shot_id = $1`,
    [B.id],
  );
  expect(copies).toHaveLength(1);
  expect(copies[0]).toMatchObject({
    source_kind: "template",
    template_id: template.id,
    template_name: NAME,
    template_revision: 1,
  });
});

test("G — editing 1B never changes the template", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  await open(page, B);
  await saveLight(page, "7");
  expect(await lightingFp(page)).not.toBe(await rigFp(A.id));
  const t = (await templateDb())!;
  expect(t.revision).toBe(template.revision);
  expect(t.content_fingerprint).toBe(template.content_fingerprint);
});

test("H — replacing the template's values never changes 1B", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  const bBefore = await shotSetup(B.id);
  await open(page, A);
  await saveLight(page, "900");
  await templateRow(page).getByTestId("template-replace").click();
  await expect
    .poll(async () => (await templateDb())?.content_fingerprint, { timeout: 60_000 })
    .not.toBe(template.content_fingerprint);
  template = (await templateDb())!;
  expect(template.revision).toBe(2);
  expect(await shotSetup(B.id), "1B's own rows are untouched").toBe(bBefore);
});

test("X — another Location's set: the template is not offered, and the server refuses it", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await signIn(page);
  const cBefore = await shotSetup(C.id);
  // 1C is on Black Luxury Sedan: give that Location its own set (acceptance-owned; removed by the cleanup)
  await page.goto(C.spatialUrl);
  await expect(page.getByTestId("new-set-state")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("load-test-set").click();
  await expect(page.getByTestId("set-status")).toContainText("Hotel Canopy", { timeout: 60_000 });
  await page.getByTestId("save-set").click();
  await expect(page.getByTestId("set-status")).toContainText("3D Set created", { timeout: 60_000 });
  await open(page, C);
  await expect(templateRow(page)).toHaveCount(0); // the library lists this set's templates only
  await expect(
    page.getByTestId("copy-setup-source").locator("option", { hasText: `Template: ${NAME}` }),
  ).toHaveCount(0);
  // the server's own answer for a crafted request with the real template id
  const base = { projectSlug: "ojousama", shotId: C.id, templateId: template.id };
  const preview = await callAction(page, C.spatialUrl, "previewTemplateSetupCopy", base);
  expect(errorOf(preview.body)).toBe(TEMPLATE_OTHER_SET);
  const copy = await callAction(page, C.spatialUrl, "copyTemplateSetup", {
    ...base,
    components: JSON.stringify(["camera", "lighting", "blocking"]),
    token: "0".repeat(64),
  });
  expect(errorOf(copy.body)).toBe(TEMPLATE_OTHER_SET);
  expect(await shotSetup(C.id), "1C's rows are untouched").toBe(cBefore);
  expect((await templateDb())!.revision).toBe(template.revision);
});

test.describe("real non-owner (temporary Auth user, its own sessions only)", () => {
  test.skip(!NONOWNER_EMAIL || !NONOWNER_PASSWORD, "no temporary non-owner credentials");

  test("N0 — the user is real, separate and owns nothing; the owner's template and history exist now", async () => {
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false } },
    );
    const { data, error } = await sb.auth.signInWithPassword({
      email: NONOWNER_EMAIL,
      password: NONOWNER_PASSWORD,
    });
    expect(error).toBeNull();
    expect(data.user!.id).not.toBe(process.env.PRISM_STUDIO_DEV_USER_ID);
    const owned = await readOnly<{ n: number }>(`select count(*)::int n from projects where user_id = $1`, [
      data.user!.id,
    ]);
    expect(owned[0]!.n).toBe(0);
    await sb.auth.signOut({ scope: "local" });
    const l = await leftovers();
    expect(l.templates).toBe(1);
    expect(l.copies).toBe(1);
    ownerFingerprint = await ownerState();
  });

  test("N1 — browser + server actions: nothing is shown, every template action is refused alike", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await signIn(page, NONOWNER_EMAIL, NONOWNER_PASSWORD);
    for (const u of ["/projects/ojousama", B.spatialUrl, A.spatialUrl, `${EP}/shots/${B.id}`]) {
      const res = await page.goto(u);
      const body = await page.locator("body").innerText();
      expect(body, `${u}: no owner project`).not.toContain(OWNER_TITLE);
      expect(body, `${u}: no template name`).not.toContain(NAME);
      expect(body, `${u}: no copy history`).not.toContain("copied from template");
      expect(await page.getByTestId("setup-templates").count(), `${u}: no template library`).toBe(0);
      expect(await page.getByTestId("setup-copy-history").count(), `${u}: no history`).toBe(0);
      expect(await page.getByTestId("virtual-set").count(), `${u}: no editor`).toBe(0);
      test.info().annotations.push({ type: "route", description: `${u} → ${res?.status()}` });
      expect([404, 200, 307]).toContain(res?.status() ?? 0); // 200 only as a not-found shell (checked above)
    }

    const p = B.spatialUrl;
    const rev = String(template.revision);
    const calls: Array<[string, Record<string, string>]> = [
      ["saveSetupTemplate", { shotId: A.id, name: "intruder", components: '["lighting"]' }],
      ["renameSetupTemplate", { templateId: template.id, name: "intruder", expectedRevision: rev }],
      [
        "replaceSetupTemplateContent",
        { templateId: template.id, shotId: A.id, expectedRevision: rev, components: '["lighting"]' },
      ],
      ["deleteSetupTemplate", { templateId: template.id, expectedRevision: rev }],
      ["previewTemplateSetupCopy", { shotId: B.id, templateId: template.id }],
      [
        "copyTemplateSetup",
        { shotId: B.id, templateId: template.id, components: '["lighting"]', token: "0".repeat(64) },
      ],
      ["previewShotSetupCopy", { sourceShotId: A.id, shotId: B.id }],
      [
        "copyShotSetup",
        { sourceShotId: A.id, shotId: B.id, components: '["lighting"]', token: "0".repeat(64) },
      ],
    ];
    for (const [name, fields] of calls) {
      const r = await callAction(page, p, name, { projectSlug: "ojousama", ...fields });
      test
        .info()
        .annotations.push({ type: "action", description: `${name} → ${r.status} ${errorOf(r.body)}` });
      expect(r.body, `${name} must not succeed`).not.toMatch(/"ok":\s*true/);
      expect(errorOf(r.body), `${name} refused at authorization`).toBe(PROJECT_GONE);
      expect(r.body, `${name} reveals nothing`).not.toContain(NAME);
    }
    // a REAL owner template id is answered exactly like a random and a malformed id
    const answers = [];
    for (const templateId of [template.id, "00000000-0000-4000-8000-0000000000aa", "not-a-uuid"]) {
      const r = await callAction(page, p, "previewTemplateSetupCopy", {
        projectSlug: "ojousama",
        shotId: B.id,
        templateId,
      });
      answers.push([r.status, errorOf(r.body)]);
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[1]).toEqual(answers[2]);
    await page.context().clearCookies();
  });

  test("N2 — Data API with the user's own JWT: templates and history invisible and unwritable", async () => {
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false } },
    );
    const { error } = await sb.auth.signInWithPassword({
      email: NONOWNER_EMAIL,
      password: NONOWNER_PASSWORD,
    });
    expect(error).toBeNull();
    const projectId = (await readOnly<{ id: string }>(`select id from projects where slug = 'ojousama'`))[0]!
      .id;
    const facts: Record<string, unknown> = {};
    for (const [label, q] of [
      ["templates by project", sb.from("shot_setup_templates").select("*").eq("project_id", projectId)],
      ["template by id", sb.from("shot_setup_templates").select("*").eq("id", template.id)],
      ["templates all", sb.from("shot_setup_templates").select("id")],
      ["copies by project", sb.from("shot_setup_copies").select("*").eq("project_id", projectId)],
      ["copies by shot", sb.from("shot_setup_copies").select("*").eq("shot_id", B.id)],
      ["copies all", sb.from("shot_setup_copies").select("id")],
    ] as const) {
      const r = await q;
      facts[label] = r.error ? `error ${r.error.code}` : r.data!.length;
      if (!r.error) expect(r.data, `${label} must be invisible`).toHaveLength(0);
    }
    const insT = await sb
      .from("shot_setup_templates")
      .insert({
        project_id: projectId,
        location_id: (
          await readOnly<{ l: string }>(`select location_id l from shots where id = $1`, [A.id])
        )[0]!.l,
        scene_document_id: template.scene_document_id,
        schema_version: "prism.setup-template.v1",
        name: "intruder",
        content_fingerprint: "0".repeat(64),
        blocking_json: [{}],
      })
      .select("id");
    expect(insT.error, "insert a template into the owner's Project").not.toBeNull();
    const updT = await sb
      .from("shot_setup_templates")
      .update({ name: "intruder" })
      .eq("id", template.id)
      .select("id");
    expect(updT.data ?? []).toHaveLength(0);
    const delT = await sb.from("shot_setup_templates").delete().eq("id", template.id).select("id");
    expect(delT.data ?? []).toHaveLength(0);
    const insC = await sb
      .from("shot_setup_copies")
      .insert({
        project_id: projectId,
        shot_id: B.id,
        location_id: "00000000-0000-4000-8000-000000000003",
        scene_document_id: template.scene_document_id,
        source_kind: "shot",
        source_shot_code: "1A",
        components: ["camera"],
        plan_token: "0".repeat(64),
      })
      .select("id");
    expect(insC.error, "insert history on the owner's Shot").not.toBeNull();
    const updC = await sb
      .from("shot_setup_copies")
      .update({ template_name: "x" })
      .eq("shot_id", B.id)
      .select("id");
    expect(updC.data ?? []).toHaveLength(0);
    const delC = await sb.from("shot_setup_copies").delete().eq("shot_id", B.id).select("id");
    expect(delC.data ?? []).toHaveLength(0);
    // the owner Shot's own rows through 4D tables' neighbours: still unwritable
    const updRig = await sb.from("shot_light_rigs").update({ revision: 99 }).eq("shot_id", B.id).select("id");
    expect(updRig.data ?? []).toHaveLength(0);
    facts.writes = {
      insertTemplate: insT.error?.code,
      updateTemplate: updT.data?.length ?? updT.error?.code,
      deleteTemplate: delT.data?.length ?? delT.error?.code,
      insertCopy: insC.error?.code,
      updateCopy: updC.data?.length ?? updC.error?.code,
      deleteCopy: delC.data?.length ?? delC.error?.code,
      updateRig: updRig.data?.length ?? updRig.error?.code,
    };
    test.info().annotations.push({ type: "data-api", description: JSON.stringify(facts) });
    const out = await sb.auth.signOut({ scope: "global" }); // every session of the temporary user
    expect(out.error).toBeNull();
  });

  test("N3 — the owner's Project is byte-for-byte unchanged", async () => {
    expect(await ownerState()).toBe(ownerFingerprint);
  });
});

test("I — the owner deletes the template: 1B stays complete; history keeps the name", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  const bBefore = await shotSetup(B.id);
  await open(page, A);
  await templateRow(page).getByTestId("template-delete").click();
  await expect(templateRow(page)).toHaveCount(0, { timeout: 60_000 });
  expect(await templateDb()).toBeNull();
  expect(await shotSetup(B.id), "no 1B row touched").toBe(bBefore);
  const copy = await readOnly<{
    template_id: string | null;
    template_name: string;
    template_revision: number;
  }>(`select template_id, template_name, template_revision from shot_setup_copies where shot_id = $1`, [
    B.id,
  ]);
  expect(copy).toEqual([{ template_id: null, template_name: NAME, template_revision: 1 }]);
  await open(page, B);
  await expect(page.getByTestId("bookmark-info")).toBeVisible();
  await expect(page.getByTestId("setup-copy-history-line").first()).toContainText("template since deleted");
});

test("J — after the template is gone, 1B captures a Master Frame from its own rows only", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await signIn(page);
  await open(page, B);
  const own = await rigFp(B.id);
  expect(own).toBe(await lightingFp(page));
  await page.getByTestId("capture-master-frame").click();
  await expect(page.getByTestId("set-status")).toContainText("Master frame saved", { timeout: 120_000 });
  const mf = await readOnly<{ lighting_fingerprint: string; camera_fingerprint: string; shot_id: string }>(
    `select lighting_fingerprint, camera_fingerprint, shot_id from scene_master_frames
      where shot_id = $1 and created_at >= $2`,
    [B.id, RUN_START],
  );
  expect(mf).toHaveLength(1);
  expect(mf[0]!.lighting_fingerprint).toBe(own); // lit by 1B's own rig
  expect(mf[0]!.camera_fingerprint).toMatch(HEX);
});

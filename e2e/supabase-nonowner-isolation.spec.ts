import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { SHOT_LIGHTING_SCHEMA, newShotLight } from "../src/domain/previs/lighting";
import { assertProjectRef } from "../scripts/lib/safety.mjs";

/**
 * Phase 4C-B: a REAL authenticated non-owner (a temporary Supabase Auth user created by the owner) against the hosted
 * Prism Studio project at 0049. Through real sessions only (the browser cookie session, the app's own server actions
 * and the Supabase Data API with the user's JWT) the user must not discover, read or change the owner's project, Shots,
 * Assets, package, spatial state, Master Frames or Production Frames. The owner's state is fingerprinted with
 * READ-ONLY SQL before and after; no privileged write is made. Skips unless PRISM_STUDIO_NONOWNER_EMAIL /
 * PRISM_STUDIO_NONOWNER_PASSWORD are set (values are never logged).
 */
const EMAIL = process.env.PRISM_STUDIO_NONOWNER_EMAIL?.trim() ?? "";
const PASSWORD = process.env.PRISM_STUDIO_NONOWNER_PASSWORD ?? "";
const OWNER_TITLE = "お嬢様、僕と結婚してください。";
test.describe.configure({ mode: "serial" });
test.skip(!EMAIL || !PASSWORD, "no temporary non-owner credentials");

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

type Known = {
  projectId: string;
  ep: string;
  shotId: string;
  locationId: string;
  assetId: string;
  episodeId: string;
};
let known: Known;
let before = "";

/** everything the non-owner could try to change, as one hash (row contents, not just counts) */
async function ownerState(projectId: string): Promise<string> {
  const parts: unknown[] = [];
  for (const t of [
    "projects",
    "shots",
    "locations",
    "assets",
    "location_scene_documents",
    "shot_camera_bookmarks",
    "shot_camera_paths",
    "shot_character_blocking",
    "shot_light_rigs",
    "scene_master_frames",
    "shot_production_frames",
    "shot_production_frame_selections",
  ]) {
    const col = t === "projects" ? "id" : "project_id";
    parts.push([t, await readOnly(`select * from public.${t} where ${col} = $1 order by 1`, [projectId])]);
  }
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** the app's own server action, called exactly as the browser does (Next-Action + an encoded FormData argument) */
const ACTIONS = JSON.parse(
  readFileSync(path.join(process.cwd(), ".next/server/server-reference-manifest.json"), "utf8"),
).node as Record<string, { exportedName: string }>;
const actionId = (name: string) => Object.entries(ACTIONS).find(([, e]) => e.exportedName === name)![0];
// Sent from INSIDE the page with the browser's own fetch + FormData, encoded as React's encodeReply does for one
// FormData argument (fields `_1_<name>`, then the root "0" = ["$K1"]). A positive control with the OWNER's session
// proved this encoding reaches each action's own validation after the project loads.
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

test.beforeAll(async () => {
  const k = (
    await readOnly<Known>(
      `select p.id "projectId", e.slug ep, e.id "episodeId", s.id "shotId", s.location_id "locationId",
              (select a.id from assets a where a.project_id = p.id and a.object_path is not null order by a.created_at limit 1) "assetId"
         from projects p join shots s on s.project_id = p.id join episodes e on e.id = s.episode_id
        where p.slug = 'ojousama' and s.shot_code = '1A'`,
    )
  )[0]!;
  known = k;
  before = await ownerState(k.projectId);
});

test("the temporary user is a real, separate Auth user that owns nothing", async () => {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: { persistSession: false },
    },
  );
  const { data, error } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  expect(error).toBeNull();
  const id = data.user!.id;
  expect(id).not.toBe(process.env.PRISM_STUDIO_DEV_USER_ID);
  const owned = await readOnly<{ n: number }>(`select count(*)::int n from projects where user_id = $1`, [
    id,
  ]);
  expect(owned[0]!.n).toBe(0);
  await sb.auth.signOut({ scope: "local" });
});

test("browser session: no project discovery, and no owner page renders owner data", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });

  // home / project list
  await page.goto("/");
  await expect(page.locator("body")).not.toContainText(OWNER_TITLE);
  expect(await page.locator('a[href^="/projects/ojousama"]').count()).toBe(0);

  const { ep, shotId, locationId } = known;
  const urls = [
    "/projects/ojousama",
    `/projects/ojousama/episodes/${ep}`,
    `/projects/ojousama/episodes/${ep}/shots/${shotId}`,
    `/projects/ojousama/episodes/${ep}/shots/${shotId}?section=production_frame`,
    `/projects/ojousama/episodes/${ep}/shots/${shotId}/spatial`,
    `/projects/ojousama/locations/${locationId}/3d?shot=${shotId}`,
    `/projects/ojousama/locations`,
  ];
  for (const u of urls) {
    const res = await page.goto(u);
    const status = res?.status() ?? 0;
    const body = await page.locator("body").innerText();
    expect(body, `${u} must not show the owner's project`).not.toContain(OWNER_TITLE);
    expect(body, `${u} must not show the owner's Location`).not.toContain("Tokyo Night Streets");
    expect(await page.getByTestId("virtual-set").count(), `${u} must not mount the 3D editor`).toBe(0);
    expect(await page.getByTestId("production-frame-section").count()).toBe(0);
    expect(await page.getByTestId("workspace-no-location").count()).toBe(0);
    test.info().annotations.push({ type: "route", description: `${u} → ${status}` });
    expect(status === 404 || status === 200 || status === 307).toBe(true); // 200 only as a not-found shell (checked above)
  }

  // protected API reads with the real cookie session
  const pkg = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
  expect(pkg.ok(), "package").toBe(false);
  const asset = await page.request.get(`/api/assets/${known.assetId}`);
  expect(asset.ok(), "owner asset").toBe(false);
  test
    .info()
    .annotations.push({ type: "api", description: `package ${pkg.status()} · asset ${asset.status()}` });

  // writes through the app's own server actions (the non-owner's cookies; ids are the owner's)
  const prep = `/projects/ojousama/episodes/${ep}/shots/${shotId}`;
  const loc3d = `/projects/ojousama/locations/${locationId}/3d?shot=${shotId}`;
  const base = { projectSlug: "ojousama", shotId };
  const calls: Array<[string, string, Record<string, string>]> = [
    [
      prep,
      "saveShotSection",
      {
        ...base,
        episodeId: known.episodeId,
        section: "set",
        "spatial.locationId": "",
        "spatial.setZone": "non-owner was here",
      },
    ],
    [
      loc3d,
      "saveLocationScene",
      { projectSlug: "ojousama", locationId, expectedRevision: "", sceneJson: '{"objects":[]}' },
    ],
    [loc3d, "linkShotCamera", { ...base, locationId }],
    [
      loc3d,
      "saveShotLighting",
      {
        ...base,
        locationId,
        expectedRevision: "",
        // a well-formed draft: this action validates its input BEFORE it loads the project
        rigJson: JSON.stringify({
          schema: SHOT_LIGHTING_SCHEMA,
          base: { mode: "replace" },
          lights: [newShotLight("point", "key")],
        }),
      },
    ],
    [
      loc3d,
      "saveShotBlocking",
      {
        ...base,
        locationId,
        // well-formed (non-empty save list): validated before the project loads
        blockingJson: JSON.stringify({
          save: [{ characterId: "00000000-0000-4000-8000-000000000000", expectedRevision: null, entry: {} }],
        }),
      },
    ],
    [
      prep,
      "promoteMasterFrame",
      { ...base, masterFrameId: "00000000-0000-4000-8000-000000000001", confirmDigest: "" },
    ],
    [
      prep,
      "selectProductionFrame",
      { ...base, productionFrameId: "00000000-0000-4000-8000-000000000002", expectedSelectedId: "" },
    ],
  ];
  for (const [p, name, fields] of calls) {
    const r = await callAction(page, p, name, fields);
    const summary = r.body.replace(/\s+/g, " ").slice(0, 160);
    test.info().annotations.push({ type: "action", description: `${name} → ${r.status} ${summary}` });
    expect(r.body, `${name} must not succeed`).not.toMatch(/"ok":\s*true/);
    // refused by AUTHORIZATION: the owner's project cannot be loaded through this user's session
    expect(r.body, `${name} must be refused because the project is not visible`).toContain(
      "That project no longer exists.",
    );
  }
  await page.context().clearCookies();
});

test("Supabase Data API with the user's own JWT: owner rows are invisible and unwritable", async () => {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: { persistSession: false },
    },
  );
  const { error } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  expect(error).toBeNull();
  const { projectId, shotId, locationId } = known;
  const reads: Record<string, number | string> = {};
  for (const [t, col, v] of [
    ["projects", "id", projectId],
    ["shots", "id", shotId],
    ["assets", "project_id", projectId],
    ["locations", "id", locationId],
    ["location_scene_documents", "project_id", projectId],
    ["shot_camera_bookmarks", "project_id", projectId],
    ["shot_light_rigs", "project_id", projectId],
    ["scene_master_frames", "project_id", projectId],
    ["shot_production_frames", "project_id", projectId],
    ["shot_production_frame_selections", "project_id", projectId],
  ] as const) {
    const r = await sb.from(t).select("*").eq(col, v);
    reads[t] = r.error ? `error ${r.error.code}` : r.data!.length;
    if (!r.error) expect(r.data, `${t} must be invisible`).toHaveLength(0);
  }
  test.info().annotations.push({ type: "data-api reads", description: JSON.stringify(reads) });

  const upd = await sb.from("shots").update({ shot_code: "XX" }).eq("id", shotId).select("id");
  expect(upd.data ?? []).toHaveLength(0);
  const del = await sb.from("shots").delete().eq("id", shotId).select("id");
  expect(del.data ?? []).toHaveLength(0);
  const ins = await sb
    .from("shot_production_frame_selections")
    .insert({
      project_id: projectId,
      shot_id: shotId,
      production_frame_id: "00000000-0000-4000-8000-000000000002",
    })
    .select("shot_id");
  expect(ins.error, "inserting a selection on the owner's Shot must be refused").not.toBeNull();
  const mf = await sb
    .from("scene_master_frames")
    .update({ camera_fingerprint: null })
    .eq("project_id", projectId)
    .select("id");
  expect(mf.data ?? []).toHaveLength(0);
  test.info().annotations.push({
    type: "data-api writes",
    description: `update shots ${upd.data?.length ?? upd.error?.code} · delete shots ${del.data?.length ?? del.error?.code} · insert selection ${ins.error?.code} · update master frames ${mf.data?.length ?? mf.error?.code}`,
  });
  // sign the temporary user out everywhere (its browser session included)
  const out = await sb.auth.signOut({ scope: "global" });
  expect(out.error).toBeNull();
});

test("the owner's project is byte-for-byte unchanged", async () => {
  expect(await ownerState(known.projectId)).toBe(before);
});

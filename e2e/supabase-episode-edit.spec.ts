import { randomUUID, createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";
import { MOCK_VIDEO_WEBM_BASE64 } from "../src/generation/providers/mock-video-fixture";
import { makeWav } from "../src/lib/__tests__/audio-fixtures";
import { getPrismStudioDevCredentials } from "./dev-credentials";

/**
 * Phase 2I.1F: the Episode Edit on the REAL stack (Supabase Auth + RLS, the hosted Prism Studio database, PRIVATE
 * Storage, the production build). No generation provider of any kind runs (REAL PROVIDER CALLS 0, PAID CALLS 0).
 *
 * A DISPOSABLE project (purpose 'test', owned by the dev user) is built directly in Postgres with real media in private
 * Storage, uploaded as the signed-in owner under the project's own prefix:
 *   Scene 1: A  two succeeded Shot-output generations (#1, #2 approved), each a real 5 s WebM (the repository's
 *               deterministic mock fixture)
 *            B  an approved Storyboard frame with a real PNG
 *   Scene 2: C  nothing (an empty slot)
 *            D  one dialogue line: take 1 selected with a real WAV, take 2 without audio
 * The browser then runs: proposal → a stale proposal refused → Create edit → real still / video / audio delivered
 * through the private route → pin #1 → Use replacement → trim → reorder → take pin → Silence → re-pin → remove / add →
 * a two-page revision conflict → playback (seek / play / pause / restart on the real <video>) → ownership refusals →
 * sign out / in. Every revision step is read back from Postgres. Finally EVERYTHING is removed (project cascade +
 * Storage objects) and the hosted counts must equal the pre-test baseline exactly.
 */

const { email: EMAIL, password: PASSWORD } = getPrismStudioDevCredentials();
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const DEV_ID = process.env.PRISM_STUDIO_DEV_USER_ID ?? "";
const P = randomUUID();
const SLUG = `e2e-2i-${Date.now()}`;
const EDIT = `/projects/${SLUG}/episodes/ep-1/edit`;
const id = () => randomUUID();
const E = id(),
  S1 = id(),
  S2 = id(),
  A = id(),
  B = id(),
  C = id(),
  D = id(),
  L = id(),
  T1 = id(),
  T2 = id(),
  FB = id(),
  A1 = id(),
  A2 = id(),
  VID1 = id(),
  VID2 = id(),
  IMG = id(),
  AUD = id();
const LINE = "The edit holds its breath.";

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

async function db<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  if (!DB_URL.includes("lyqdxiyjperhniwhzsvg")) throw new Error("not the dedicated Prism Studio database");
  const c = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Counts of everything this test could leave behind, plus the migration ledger. */
const COUNTS = `select
  (select count(*) from projects)::int projects, (select count(*) from episodes)::int episodes,
  (select count(*) from scenes)::int scenes, (select count(*) from shots)::int shots,
  (select count(*) from dialogue_lines)::int dialogue_lines, (select count(*) from performance_takes)::int takes,
  (select count(*) from assets)::int assets, (select count(*) from storyboard_frames)::int storyboard_frames,
  (select count(*) from generation_attempts)::int attempts, (select count(*) from generation_outputs)::int outputs,
  (select count(*) from shot_production_frames)::int production_frames,
  (select count(*) from episode_edits)::int episode_edits, (select count(*) from episode_edit_items)::int edit_items,
  (select count(*) from episode_edit_audio_placements)::int edit_placements,
  (select count(*) from generation_costs)::int cost_rows,
  (select count(*) from storage.objects where bucket_id = 'prism-assets')::int storage_objects,
  (select count(*) from public.prism_migrations)::int migrations, (select max(name) from public.prism_migrations) head`;
const counts = () => db(async (c) => (await c.query(COUNTS)).rows[0] as Record<string, number | string>);

const revisionInDb = () =>
  db(async (c) => {
    const r = (await c.query("select revision from episode_edits where project_id = $1", [P])).rows[0];
    return r ? Number(r.revision) : null;
  });
const itemsInDb = () =>
  db(
    async (c) =>
      (
        await c.query(
          `select i.position, s.shot_code, i.visual_kind, i.asset_id, i.source_in_ms, i.source_out_ms, i.duration_ms,
                  (select count(*)::int from episode_edit_audio_placements p where p.item_id = i.id) placements,
                  (select string_agg(p.take_id::text, ',') from episode_edit_audio_placements p where p.item_id = i.id) takes
             from episode_edit_items i join shots s on s.id = i.shot_id where i.project_id = $1 order by i.position`,
          [P],
        )
      ).rows as Array<Record<string, unknown>>,
  );

let baseline: Record<string, number | string> | null = null;
let storage: SupabaseClient | null = null;
const objectPaths: string[] = [];
let cleaned = false;

async function signedInStorage(): Promise<SupabaseClient> {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const { error } = await client.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (error) throw new Error(`storage sign-in failed: ${error.message}`);
  return client;
}

async function upload(assetId: string, name: string, bytes: Uint8Array, mime: string): Promise<string> {
  const path = `${P}/${assetId}/${name}`;
  const { error } = await storage!.storage
    .from("prism-assets")
    .upload(path, bytes, { contentType: mime, upsert: false });
  if (error) throw new Error(`upload failed: ${error.message}`);
  objectPaths.push(path);
  return path;
}

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (storage && objectPaths.length) await storage.storage.from("prism-assets").remove(objectPaths);
  await db((c) =>
    c.query("delete from projects where id = $1 and user_id = $2 and purpose = 'test'", [P, DEV_ID]),
  );
}

async function signIn(page: Page, next = EDIT) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
}

const item = (page: Page, code: string) =>
  page.locator(`[data-testid="edit-item"][data-shot-code="${code}"]`);
const expectRevision = (page: Page, n: number) =>
  expect(page.getByTestId("edit-revision")).toHaveText(`Revision ${n}`, { timeout: 30_000 });
async function openEditor(page: Page, code: string) {
  const editor = item(page, code).getByTestId("item-editor");
  if (!(await editor.evaluate((d) => (d as HTMLDetailsElement).open)))
    await editor.locator("summary").click();
  return editor;
}
/** One explicit change in the UI, then: the page AND Postgres show exactly the next revision. */
async function change(page: Page, from: number, act: () => Promise<void>) {
  await act();
  await expectRevision(page, from + 1);
  expect(await revisionInDb()).toBe(from + 1);
  return from + 1;
}
const player = (page: Page) => page.getByTestId("edit-player");
const seekTo = (page: Page, ms: number) =>
  page.getByTestId("player-seek").evaluate((el, v) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, Math.round(ms));

test.beforeAll(async () => {
  test.skip(!DB_URL || !DEV_ID, "hosted credentials missing");
  baseline = await counts();
  expect(baseline.head).toBe("0043_episode_edits.sql");
  storage = await signedInStorage();

  const video = Buffer.from(MOCK_VIDEO_WEBM_BASE64, "base64");
  const still = png(320, 180, [40, 90, 160]);
  const audio = makeWav({ seconds: 2, frequency: 440 });
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  await db(async (c) => {
    await c.query(
      "insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,'E2E 2I Episode Edit','test')",
      [P, DEV_ID, SLUG],
    );
    await c.query("insert into project_bibles (project_id) values ($1)", [P]);
    await c.query(
      "insert into episodes (id, project_id, number, slug, title) values ($1,$2,1,'ep-1','E2E Edit')",
      [E, P],
    );
    await c.query(
      `insert into scenes (id, project_id, episode_id, scene_number, slugline, int_ext, "order")
       values ($1,$2,$3,'1','INT. CUTTING ROOM','INT',0), ($4,$2,$3,'2','EXT. ROOF','EXT',1)`,
      [S1, P, E, S2],
    );
    for (const [shotId, scene, code, order, ms] of [
      [A, S1, "1A", 0, 4000],
      [B, S1, "1B", 1, 2000],
      [C, S2, "2A", 0, 1500],
      [D, S2, "2B", 1, 3000],
    ] as const)
      await c.query(
        `insert into shots (id, project_id, episode_id, scene_id, shot_code, title, "order", target_duration_ms, duration_mode)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'manual')`,
        [shotId, P, E, scene, code, `Shot ${code}`, order, ms],
      );
  });
  // real media, uploaded as the signed-in owner to the project's own private prefix
  const media: Array<
    [string, string, Buffer | Uint8Array, string, string, number | null, number | null, number | null]
  > = [
    [VID1, "clip1.webm", video, "video/webm", "video", 5000, 192, 108],
    [VID2, "clip2.webm", video, "video/webm", "video", 5000, 192, 108],
    [IMG, "board.png", still, "image/png", "image", null, 320, 180],
    [AUD, "take1.wav", audio, "audio/wav", "audio", 2000, null, null],
  ];
  for (const [assetId, name, bytes, mime, type, durationMs, w, h] of media) {
    const path = await upload(assetId, name, bytes, mime);
    await db((c) =>
      c.query(
        `insert into assets (id, project_id, name, type, purpose, source, storage_provider, bucket, object_path, mime,
           checksum, byte_size, duration_ms, width, height, original_filename, metadata)
         values ($1,$2,$3,$4,$5,$6,'supabase','prism-assets',$7,$8,$9,$10,$11,$12,$13,$3,'{}'::jsonb)`,
        [
          assetId,
          P,
          name,
          type,
          type === "video" ? "generation_output" : type === "image" ? "storyboard" : "performance_audio",
          type === "video" ? "provider_output" : type === "image" ? "upload" : "recording",
          path,
          mime,
          sha(bytes),
          bytes.length,
          durationMs,
          w,
          h,
        ],
      ),
    );
  }
  await db(async (c) => {
    await c.query(
      "insert into storyboard_frames (id, project_id, shot_id, asset_id, version, source, approved) values ($1,$2,$3,$4,1,'upload',true)",
      [FB, P, B, IMG],
    );
    await c.query(
      "insert into dialogue_lines (id, project_id, episode_id, scene_id, speaker_label, original_text) values ($1,$2,$3,$4,'NARRATOR',$5)",
      [L, P, E, S2, LINE],
    );
    await c.query("insert into shot_dialogue_lines (shot_id, dialogue_line_id, position) values ($1,$2,0)", [
      D,
      L,
    ]);
    await c.query(
      `insert into performance_takes (id, project_id, dialogue_line_id, source_type, audio_asset_id, duration_ms, take_number, selected)
       values ($1,$2,$3,'human_recording',$4,2000,1,true), ($5,$2,$3,'temp_voice',null,1500,2,false)`,
      [T1, P, L, AUD, T2],
    );
    for (const [attemptId, n, asset, approved] of [
      [A1, 1, VID1, false],
      [A2, 2, VID2, true],
    ] as const) {
      await c.query(
        `insert into generation_attempts (id, project_id, shot_id, attempt_number, provider, model, modality, package_snapshot,
           approved, status, review_status, request, reviewed_at)
         values ($1,$2,$3,$4,'mock','mock-video-1','video','{}'::jsonb,$5::boolean,'succeeded',
           case when $5::boolean then 'approved' else 'unreviewed' end,'{"purpose":"shot_output"}'::jsonb,
           case when $5::boolean then now() end)`,
        [attemptId, P, A, n, approved],
      );
      await c.query(
        "insert into generation_outputs (project_id, attempt_id, asset_id, role, position) values ($1,$2,$3,'primary',0)",
        [P, attemptId, asset],
      );
    }
  });
});

test.afterAll(async () => {
  // safety net only: the last test performs and verifies the cleanup
  await cleanup().catch(() => undefined);
});

test("signed in: the test Episode's Edit tab shows the proposal; a stale proposal is refused; Create edit persists it", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  await expect(page.getByTestId("episode-edit-proposal")).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit", exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="edit-item"]')).toHaveCount(4);
  await expect(item(page, "1A").getByTestId("item-kind")).toHaveText("Generated clip");
  await expect(item(page, "1B").getByTestId("item-kind")).toHaveText("Placeholder: Storyboard still");
  await expect(item(page, "2A").getByTestId("item-kind")).toHaveText("No picture yet");
  await expect(item(page, "2B").getByTestId("item-audio")).toContainText(LINE);
  expect(await revisionInDb()).toBeNull();

  // a material input changes after the page was rendered: the take selection
  await db(async (c) => {
    await c.query("update performance_takes set selected = false where id = $1", [T1]);
    await c.query("update performance_takes set selected = true where id = $1", [T2]);
  });
  await page.getByTestId("create-episode-edit").click();
  await expect(page.getByText(/The proposed assembly changed since this page was loaded/)).toBeVisible();
  expect(await revisionInDb()).toBeNull();
  await db(async (c) => {
    await c.query("update performance_takes set selected = false where id = $1", [T2]);
    await c.query("update performance_takes set selected = true where id = $1", [T1]);
  });

  await page.reload();
  await page.getByTestId("create-episode-edit").click();
  await expect(page.getByTestId("episode-edit-persisted")).toBeVisible({ timeout: 30_000 });
  await expectRevision(page, 0);
  expect(await revisionInDb()).toBe(0);
  const rows = await itemsInDb();
  expect(rows.map((r) => [r.shot_code, r.visual_kind])).toEqual([
    ["1A", "video"],
    ["1B", "storyboard_frame"],
    ["2A", "none"],
    ["2B", "none"],
  ]);
  expect(rows[0]).toMatchObject({ asset_id: VID2, source_in_ms: 0, source_out_ms: 4000 }); // the approved clip
  expect(rows[3]).toMatchObject({ placements: 1, takes: T1 });
});

test("the saved edit reloads unchanged; real still, video and audio come through the private route", async ({
  page,
}) => {
  await signIn(page);
  await expectRevision(page, 0);
  // still: the Storyboard frame's real PNG
  const img = item(page, "1B").locator("img").first();
  await expect.poll(() => img.evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBe(320);
  // video: the pinned clip's real WebM: the element loads its metadata (decoded by the browser)
  const video = item(page, "1A").locator("video").first();
  expect(await video.getAttribute("src")).toBe(`/api/assets/${VID2}`);
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
  expect(await video.evaluate((v) => Math.round((v as HTMLVideoElement).duration))).toBe(5);
  // audio: the pinned take's real WAV through the same route, loaded by a browser audio element
  const audioHref = await item(page, "2B").getByRole("link", { name: "audio" }).getAttribute("href");
  expect(audioHref).toBe(`/api/assets/${AUD}`);
  const res = await page.request.get(audioHref!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/audio\/(wav|x-wav|wave)/);
  const audioDuration = await page.evaluate(
    (src) =>
      new Promise<number>((resolve, reject) => {
        const a = new Audio(src);
        a.addEventListener("loadedmetadata", () => resolve(a.duration));
        a.addEventListener("error", () => reject(new Error("audio failed to load")));
      }),
    audioHref!,
  );
  expect(Math.round(audioDuration)).toBe(2);
});

test("explicit editing on the hosted edit: every change is exactly one revision in Postgres and survives a reload", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signIn(page);
  let rev = 0;
  rev = await change(page, rev, async () => {
    const editor = await openEditor(page, "1A");
    await editor.getByTestId("source-option").filter({ hasText: "Generation #1" }).locator("input").check();
    await editor.getByTestId("pin-source").click();
  });
  expect((await itemsInDb())[0]).toMatchObject({ asset_id: VID1, source_in_ms: 0, source_out_ms: 5000 });
  await expect(item(page, "1A").getByTestId("item-badges")).toContainText("Replacement available");

  rev = await change(page, rev, async () => {
    const editor = await openEditor(page, "1A");
    await editor.getByTestId("use-replacement").click();
  });
  expect((await itemsInDb())[0]).toMatchObject({ asset_id: VID2 });

  rev = await change(page, rev, async () => {
    const editor = await openEditor(page, "1A");
    await editor.getByTestId("trim-in").fill("0.5");
    await editor.getByTestId("trim-out").fill("3");
    await editor.getByTestId("apply-trim").click();
  });
  expect((await itemsInDb())[0]).toMatchObject({ source_in_ms: 500, source_out_ms: 3000 });
  await expect(item(page, "1A").getByTestId("item-timing")).toContainText("Duration 2.5s");

  rev = await change(page, rev, () => item(page, "2A").getByTestId("move-up").click());
  expect((await itemsInDb()).map((r) => r.shot_code)).toEqual(["1A", "2A", "1B", "2B"]);
  await page.reload();
  await expectRevision(page, rev);
  expect(
    await page
      .locator('[data-testid="edit-item"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-shot-code"))),
  ).toEqual(["1A", "2A", "1B", "2B"]);

  rev = await change(page, rev, async () => {
    const line = (await openEditor(page, "2B")).getByTestId("line-editor").first();
    await line.getByTestId("take-option").filter({ hasText: "Take 2" }).locator("input").check();
    await line.getByTestId("pin-take").click();
  });
  expect((await itemsInDb())[3]).toMatchObject({ takes: T2 });

  rev = await change(page, rev, async () =>
    (await openEditor(page, "2B")).getByTestId("silence-item").click(),
  );
  expect((await itemsInDb())[3]).toMatchObject({ placements: 0 });
  await expect(item(page, "2B").getByTestId("item-silence")).toBeVisible();

  rev = await change(page, rev, async () =>
    (await openEditor(page, "2B")).getByTestId("repin-selected").click(),
  );
  expect((await itemsInDb())[3]).toMatchObject({ placements: 1, takes: T1 });

  page.once("dialog", (d) => void d.accept());
  rev = await change(page, rev, () => item(page, "2A").getByTestId("remove-item").click());
  expect((await itemsInDb()).map((r) => r.shot_code)).toEqual(["1A", "1B", "2B"]);
  rev = await change(page, rev, async () => {
    const addable = page.locator('[data-testid="addable-shot"][data-shot-code="2A"]');
    await addable.getByTestId("add-position").selectOption("1");
    await addable.getByTestId("add-shot").click();
  });
  expect((await itemsInDb()).map((r) => r.shot_code)).toEqual(["1A", "2A", "1B", "2B"]);
  expect(rev).toBe(9);
});

test("a hosted revision conflict: the stale page is refused, the winner stays exactly as stored", async ({
  browser,
}: {
  browser: Browser;
}) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await signIn(a);
  await b.goto(EDIT);
  await expectRevision(a, 9);
  await expectRevision(b, 9);
  await b.locator('[data-testid="edit-item"][data-shot-code="2B"]').getByTestId("move-up").click();
  await expectRevision(b, 10);
  const winner = await itemsInDb();
  const editor = await openEditor(a, "2A");
  await editor.getByTestId("hold-duration").fill("4");
  await editor.getByTestId("apply-hold").click();
  await expect(
    a.getByText("This edit changed before your update was saved. Review the latest version and try again."),
  ).toBeVisible();
  expect(await revisionInDb()).toBe(10);
  expect(await itemsInDb()).toEqual(winner);
  await ctx.close();
});

test("playback of the hosted edit: the real <video> plays the pinned clip from its trim; seek / play / pause / restart; no write", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  await expectRevision(page, 10);
  // interactive only once hydrated: the server render has no controller (data-item-id "")
  await expect(player(page)).not.toHaveAttribute("data-item-id", "");
  const rows = await page.locator('[data-testid="edit-item"]').evaluateAll((els) =>
    els.map((e) => ({
      code: e.getAttribute("data-shot-code"),
      start: Number(e.getAttribute("data-start-ms")),
    })),
  );
  const a = rows.find((r) => r.code === "1A")!;
  await seekTo(page, a.start + 100);
  await expect(player(page)).toHaveAttribute("data-kind", "video");
  await expect(player(page)).toHaveAttribute("data-video-url", `/api/assets/${VID2}`);
  await expect(player(page)).toHaveAttribute("data-video-src-ms", "600");
  const video = page.getByTestId("player-video");
  expect(await video.getAttribute("src")).toBe(`/api/assets/${VID2}`);
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
  // the browser accepted the seek to the persisted source position (0.5 s trim + 0.1 s into the item)
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime), { timeout: 15_000 })
    .toBeCloseTo(0.6, 0);

  const d = rows.find((r) => r.code === "2B")!;
  await seekTo(page, d.start + 50);
  await expect(player(page)).toHaveAttribute("data-placements", new RegExp(`:${L}@`));

  await page.getByTestId("player-restart").click();
  await expect(player(page)).toHaveAttribute("data-time-ms", "0");
  await page.getByTestId("player-play").click();
  await expect(player(page)).toHaveAttribute("data-playing", "true");
  await expect.poll(async () => Number(await player(page).getAttribute("data-time-ms"))).toBeGreaterThan(300);
  await page.getByTestId("player-play").click();
  await expect(player(page)).toHaveAttribute("data-playing", "false");
  const frozen = await player(page).getAttribute("data-time-ms");
  await page.waitForTimeout(600); // the clock is paused: nothing moves
  expect(await player(page).getAttribute("data-time-ms")).toBe(frozen);
  await page.getByTestId("player-restart").click();
  await expect(player(page)).toHaveAttribute("data-time-ms", "0");
  expect(await revisionInDb()).toBe(10);
});

test("ownership through the application: signed out sees nothing; unknown projects and Assets are not found", async ({
  browser,
  page,
}) => {
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  const asset = await anonPage.request.get(`/api/assets/${VID2}`, { maxRedirects: 0 });
  expect(asset.status()).toBe(401);
  await anonPage.goto(EDIT);
  await expect(anonPage).toHaveURL(/\/login/);
  await anon.close();

  await signIn(page);
  expect((await page.request.get(`/api/assets/${randomUUID()}`, { maxRedirects: 0 })).status()).toBe(404);
  const own = await page.request.get(`/api/assets/${VID2}`, { maxRedirects: 0 });
  expect([200, 307]).toContain(own.status()); // the owner gets the bytes (307 → short-lived signed URL)
  const missing = await page.goto(`/projects/e2e-2i-not-mine-${Date.now()}/episodes/ep-1/edit`);
  expect(missing?.status()).toBe(404);
});

test("sign out and back in: the same persisted edit", async ({ page }) => {
  await signIn(page);
  await expectRevision(page, 10);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await signIn(page);
  await expectRevision(page, 10);
  expect(
    await page
      .locator('[data-testid="edit-item"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-shot-code"))),
  ).toEqual((await itemsInDb()).map((r) => r.shot_code));
});

test("cleanup: every row and private object of the test project is gone; hosted counts equal the baseline", async () => {
  await cleanup();
  const after = await counts();
  expect(after).toEqual(baseline);
  if (storage) {
    const { data } = await storage.storage.from("prism-assets").list(P);
    expect(data ?? []).toEqual([]);
  }
});

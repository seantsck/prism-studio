import { execFileSync } from "node:child_process";
import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { getPrismStudioDevCredentials } from "./dev-credentials";

/**
 * Phase 2H Image-to-Video on the REAL stack: Supabase Auth + RLS, the hosted Prism Studio database, PRIVATE Storage and
 * the real generation worker. MockProvider ONLY: REAL RUNWAY / OPENAI / GEMINI CALLS 0, PAID CALLS 0. No 3D, no GPU.
 *
 *   Shot 2C: no Production Frame → Animate blocked → upload a Production Frame (private Storage) → a different manual
 *   start-frame override blocks (removed again) → one FREE mock animation candidate → the real worker → video output →
 *   its FROZEN request (read back from Postgres) is image-to-video starting from exactly the frozen frame → ⭐ Best does
 *   not approve the output → the Sequence Board shows the derived animation state.
 *
 * Everything it creates (mock attempts / set, the uploaded frame, its selection and private object, the temporary
 * override row) is removed afterwards and the Shot is checked to be exactly as it was.
 */
const { email: EMAIL, password: PASSWORD } = getPrismStudioDevCredentials();
const EP = "/projects/ojousama/episodes/ep-1";
const PREFIX = `e2e-2h-${Date.now()}`;

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

const tsx = (script: string, args: string[]) =>
  execFileSync("npx", ["tsx", "--env-file=.env.local", script, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRISM_STUDIO_PERSISTENCE: "supabase",
      PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
      NODE_ENV: "test",
      ...(process.env.PRISM_STUDIO_E2E_REAL_WORKER === "1"
        ? {}
        : { PRISM_STUDIO_WORKER_DEV_STORAGE: "1", PRISM_STUDIO_WORKER_DEV_ASSUME_ROLE: "1" }),
    },
    encoding: "utf8",
    timeout: 240_000,
    shell: process.platform === "win32",
  });

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

interface ShotState {
  shot: Record<string, unknown>;
  references: Array<Record<string, unknown>>;
  frames: string[];
  selection: string | null;
  mockAttempts: number;
  realAttempts: number;
}

/** What this test could touch on Shot 2C, read back exactly (the whole Shot row, its reference rows, frames). */
const readState = (shotId: string) =>
  db(async (c): Promise<ShotState> => {
    const shot = (
      await c.query("select *, updated_at::text as updated_at from shots where id = $1", [shotId])
    ).rows[0] as Record<string, unknown>;
    const references = (
      await c.query(
        "select asset_id, role, position from shot_reference_assets where shot_id = $1 order by role, position",
        [shotId],
      )
    ).rows;
    const frames = (
      await c.query("select id from shot_production_frames where shot_id = $1 order by id", [shotId])
    ).rows.map((r) => String(r.id));
    const selection =
      (
        await c.query("select production_frame_id from shot_production_frame_selections where shot_id = $1", [
          shotId,
        ])
      ).rows[0]?.production_frame_id ?? null;
    const counts = (
      await c.query(
        `select count(*) filter (where provider = 'mock')::int as mock, count(*) filter (where provider <> 'mock')::int as real
           from generation_attempts where shot_id = $1`,
        [shotId],
      )
    ).rows[0] as { mock: number; real: number };
    return {
      shot,
      references,
      frames,
      selection: selection ? String(selection) : null,
      mockAttempts: counts.mock,
      realAttempts: counts.real,
    };
  });

const scopedCleanup = () => {
  for (const [script, args] of [
    ["scripts/generation-cleanup.mts", ["--yes"]],
    ["scripts/previs-cleanup.mts", ["--yes", `--e2e-assets-prefix=${PREFIX}`]],
  ] as const) {
    try {
      tsx(script, [...args]);
    } catch {
      /* best effort; idempotent */
    }
  }
};

let shotId = "";
let original: ShotState | null = null;
let overrideAssetId: string | null = null;

test.beforeAll(async () => {
  await db(async (c) => {
    shotId = String(
      (
        await c.query(
          `select s.id from shots s join projects p on p.id = s.project_id where p.slug = 'ojousama' and s.shot_code = '2C'`,
        )
      ).rows[0].id,
    );
  });
  if (!shotId) return;
  original = await readState(shotId);
});

const removeOverride = () =>
  db(async (c) => {
    if (overrideAssetId)
      await c.query(
        "delete from shot_reference_assets where shot_id = $1 and asset_id = $2 and role = 'start_frame'",
        [shotId, overrideAssetId],
      );
  });

test.afterAll(async () => {
  if (!original) return;
  await removeOverride();
  // mock attempts, their set and outputs; then this test's own upload, its frame, selection and private object
  scopedCleanup();
  const after = await readState(shotId);
  // Shot 2C is exactly as it was: the whole row, its reference rows, its frames and selection, no attempt left
  expect(after).toEqual(original);
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("お嬢様、僕と結婚してください。").first()).toBeVisible({ timeout: 30_000 });
}

const panel = (page: Page) => page.getByTestId("animate-panel");

test("hosted: PF required → upload → override blocks → mock animation via the real worker starts from exactly the frame", async ({
  page,
}) => {
  test.skip(!original, "SUPABASE_DB_URL for the Prism Studio project is not configured");
  test.setTimeout(600_000);
  expect(original!.selection, "2C must start without a selected Production Frame").toBeNull();
  expect(original!.references.filter((r) => r.role === "start_frame")).toEqual([]);
  expect(original!.mockAttempts).toBe(0);
  scopedCleanup();

  await signIn(page);
  await page.goto(`${EP}/shots`);
  const href = await page.getByRole("link", { name: "2C", exact: true }).first().getAttribute("href");
  const shotUrl = new URL(href!, "http://x").pathname;

  // ── no Production Frame: blocked ──
  await page.goto(`${shotUrl}?section=animate`);
  await expect(panel(page)).toHaveAttribute("data-ready", "0");
  await expect(panel(page).locator('[data-code="no_production_frame"]')).toHaveText(
    "Choose a Production Frame before animating this Shot.",
  );

  // ── upload a production-shaped frame (private Storage) ──
  await page.goto(`${shotUrl}?section=production_frame`);
  const pf = page.getByTestId("production-frame-section");
  await pf.getByTestId("pf-upload-file").setInputFiles({
    name: `${PREFIX}-frame.png`,
    mimeType: "image/png",
    buffer: png(956, 400, [60, 120, 180]),
  });
  await pf.getByTestId("pf-upload-submit").click();
  await expect(pf.getByTestId("pf-selected")).toHaveAttribute("data-freshness", "fresh", { timeout: 60_000 });
  const version = await pf.getByTestId("pf-selected").getAttribute("data-version");

  // ── a DIFFERENT manual start-frame override blocks (never used, never ignored); removed again ──
  overrideAssetId = await db(async (c) => {
    const a = (
      await c.query(
        `select f.asset_id from storyboard_frames f where f.shot_id = $1 and f.asset_id is not null limit 1`,
        [shotId],
      )
    ).rows[0]?.asset_id;
    if (!a) return null;
    await c.query(
      "insert into shot_reference_assets (shot_id, asset_id, role, position) values ($1, $2, 'start_frame', 0)",
      [shotId, a],
    );
    return String(a);
  });
  if (overrideAssetId) {
    await page.goto(`${shotUrl}?section=animate`);
    await expect(panel(page).locator('[data-code="start_override_conflict"]')).toContainText(
      "manual start-frame override that differs from the canonical Production Frame",
    );
    await removeOverride();
    overrideAssetId = null;
  }

  // ── compare + one FREE mock animation candidate; the real worker process runs it ──
  await page.goto(`${shotUrl}?section=animate`);
  await expect(panel(page)).toHaveAttribute("data-ready", "1");
  await expect(panel(page).getByTestId("animate-pf-version")).toHaveText(`v${version}`);
  const row = panel(page).locator('[data-testid="model-row"][data-model="mock-video-1"]');
  await expect(row.getByTestId("model-first-frame")).toHaveText("YES");
  await expect(row.getByTestId("model-cost")).toHaveText("free");
  await expect(
    panel(page)
      .locator('[data-testid="model-row"][data-model="mock-video-t2v"]')
      .getByTestId("model-eligibility"),
  ).toContainText("Incompatible");
  await row.getByTestId("model-pick").check();
  await panel(page).getByTestId("ack-all").check();
  await panel(page).getByTestId("create-candidate-set").click();
  await page.waitForURL(/\/candidates\/[0-9a-f-]{36}/, { timeout: 90_000 });
  const setUrl = new URL(page.url()).pathname;
  const out = tsx("scripts/generation-worker.mts", ["--until-idle"]);
  expect(out).toContain("lyqdxiyjperhniwhzsvg");
  expect(out).not.toMatch(/service|password|postgres:\/\//i);
  await page.goto(setUrl);
  const card = page.locator('[data-testid="candidate-card"][data-model="mock-video-1"]');
  await expect(card).toHaveAttribute("data-status", "succeeded", { timeout: 60_000 });
  await expect(page.getByTestId("animation-source")).toHaveAttribute("data-version", version!);
  await expect(card.getByTestId("candidate-animation")).toHaveAttribute("data-first-frame", "match");
  await expect(card.getByTestId("candidate-animation")).toHaveAttribute("data-freshness", "fresh");
  await expect(card.getByTestId("candidate-video")).toHaveCount(1);

  // ── the FROZEN request and package, read back from Postgres ──
  const frozen = await db(async (c) => {
    const a = (
      await c.query(
        `select ga.id, ga.provider, ga.request, ga.package_snapshot, ga.approved, ga.request_modality
           from generation_attempts ga where ga.shot_id = $1 order by ga.created_at desc limit 1`,
        [shotId],
      )
    ).rows[0];
    const set = (
      await c.query(
        `select s.recommendation from generation_candidate_sets s
           join generation_candidate_members m on m.candidate_set_id = s.id where m.attempt_id = $1`,
        [a.id],
      )
    ).rows[0];
    return { ...a, set } as {
      id: string;
      provider: string;
      approved: boolean;
      request_modality: string;
      request: {
        purpose: string;
        modality: string;
        startFrameAssetId: string;
        references: Array<{ role: string; assetId: string }>;
      };
      package_snapshot: {
        version: number;
        references: { productionFrame: { frameId: string; assetId: string } };
      };
      set: { recommendation: { generationPurpose: string; animationSource: { frameId: string } } };
    };
  });
  expect(frozen!.provider).toBe("mock");
  expect(frozen!.request.purpose).toBe("animate_production_frame");
  expect(frozen!.request.modality).toBe("image_to_video");
  expect(frozen!.request_modality).toBe("image_to_video");
  expect(frozen!.package_snapshot.version).toBe(5);
  expect(frozen!.request.startFrameAssetId).toBe(frozen!.package_snapshot.references.productionFrame.assetId);
  expect(frozen!.request.references.some((r) => r.role === "production_frame")).toBe(false);
  expect(frozen!.set.recommendation.generationPurpose).toBe("animate_production_frame");
  expect(frozen!.set.recommendation.animationSource.frameId).toBe(
    frozen!.package_snapshot.references.productionFrame.frameId,
  );

  // ── ⭐ Best: the experiment's preference, NOT the Shot's approved output ──
  await card.getByTestId("review-best").click();
  await expect(card).toHaveAttribute("data-preferred", "1", { timeout: 30_000 });
  const approved = await db(
    async (c) =>
      (await c.query("select approved from generation_attempts where id = $1", [frozen!.id])).rows[0]
        ?.approved as boolean,
  );
  expect(approved).toBe(false);

  // ── the Sequence Board derives the animation state; the visual stays the canonical still ──
  await page.goto(`${EP}/sequence`);
  const seq = page.locator('[data-testid="sequence-card"][data-shot-code="2C"]');
  await expect(seq.getByTestId("sequence-animation")).toHaveAttribute("data-state", "candidates");
  await expect(seq.getByTestId("sequence-animate-link")).toBeVisible();
  await expect(seq.getByTestId("sequence-visual")).toHaveAttribute("data-kind", "production_frame");
  await expect(seq.locator("video")).toHaveCount(0);
});

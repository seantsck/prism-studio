import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { getPrismStudioDevCredentials } from "./dev-credentials";

/**
 * Phase 2F M2B on the REAL stack (no provider call): real Supabase Auth + RLS, shot character blocking persisted
 * in Postgres, the proxies in a locally rendered master frame and previs (private Storage) with blocking
 * provenance, stale detection, and the blocking frozen by value in the GenerationPackage. Removes everything it
 * creates.
 */
const { email: EMAIL, password: PASSWORD } = getPrismStudioDevCredentials();
const EP = "/projects/ojousama/episodes/ep-1";

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

const tsx = (args: string[]) =>
  execFileSync("npx", ["tsx", "--env-file=.env.local", "scripts/previs-cleanup.mts", ...args], {
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

const json = <T>(args: string[]): T => {
  const out = tsx(args);
  return JSON.parse(out.slice(out.indexOf("["))) as T;
};

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("お嬢様、僕と結婚してください。").first()).toBeVisible({ timeout: 30_000 });
}

const setInput = async (page: Page, testId: string, value: string) => {
  const input = page.getByTestId(testId);
  await input.fill(value);
  await input.press("Enter");
};

test.describe("shot character blocking (signed in, Postgres + private Storage)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => {
    try {
      tsx(["--yes"]);
    } catch {
      /* best effort; idempotent */
    }
  });
  test.afterAll(() => {
    try {
      tsx(["--yes"]);
    } catch {
      /* best effort; idempotent */
    }
  });

  test("blocking → Postgres → reload → master frame + previs provenance → stale → package", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(900_000);
    const origin = new URL(baseURL!).origin;
    const foreign: string[] = [];
    page.on("request", (r) => {
      const u = r.url();
      if (u.startsWith("data:") || u.startsWith("blob:")) return;
      const o = new URL(u).origin;
      if (o !== origin && !/\.supabase\.co$/.test(new URL(u).hostname)) foreign.push(u);
    });
    await signIn(page);

    await page.goto(`${EP}/shots`);
    await page.getByRole("link", { name: "3A", exact: true }).click();
    await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
    const shotUrl = page.url().split("?")[0]!;
    const shotId = /\/shots\/([0-9a-f-]{36})/.exec(shotUrl)![1]!;
    await page.goto(`${shotUrl}?section=set`);
    await page.getByTestId("open-in-3d-set").click();
    await page.waitForURL(/\/locations\/[0-9a-f-]{36}\/3d\?shot=/);
    const setUrl = page.url();
    const set = page.getByTestId("virtual-set");
    await expect(set).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    const blocking = page.getByTestId("character-blocking");
    await expect(blocking).toHaveAttribute("data-loaded", "true", { timeout: 30_000 });
    await page.getByTestId("load-test-set").click();
    await expect(set).toHaveAttribute("data-object-count", "7");

    // ── author: Yumeko near the doorway (body angled, head turned), Sean near the vehicle (hands on hips) ──
    const add = async (name: string) => {
      await page.getByTestId("blocking-character").selectOption({ label: name });
      await page.getByTestId("add-character-proxy").click();
      await expect(page.getByTestId("blocking-figure").filter({ hasText: name })).toHaveCount(1);
    };
    await add("Yumeko");
    await setInput(page, "blocking-pos-x", "-0.8");
    await setInput(page, "blocking-pos-z", "-4.6");
    await setInput(page, "blocking-yaw", "30");
    await setInput(page, "head-yaw", "20");
    await add("Sean");
    await setInput(page, "blocking-pos-x", "3");
    await setInput(page, "blocking-pos-z", "-1.4");
    await setInput(page, "blocking-yaw", "-130");
    await page.getByTestId("preset-hands_on_hips").click();
    await page.getByTestId("save-blocking").click();
    await expect(page.getByTestId("blocking-status")).toContainText(
      "Character blocking saved (2 characters)",
      {
        timeout: 90_000,
      },
    );

    // ── Postgres: one row per character, versions, no URL, anchored to the saved set ──
    type Row = {
      shot_id: string;
      character_id: string;
      schema_version: string;
      rig_version: string;
      revision: number;
      root_scale: number;
      root_position: { x: number; y: number; z: number };
      pose_json: { schema: string; rig: string; joints: Record<string, unknown> };
      pose_fingerprint: string;
      blocking_fingerprint: string;
      scene_fingerprint: string;
      live_scene_fingerprint: string;
      visible: boolean;
    };
    const rows = json<Row[]>(["--report-blocking"]).filter((r) => r.shot_id === shotId);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.schema_version).toBe("prism.shot-blocking.v1");
      expect(r.rig_version).toBe("prism.humanoid-rig.v1");
      expect(r.pose_json.schema).toBe("prism.pose.v1");
      expect(r.pose_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(r.blocking_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(r.scene_fingerprint).toBe(r.live_scene_fingerprint); // authored against the live (saved) set
      expect(JSON.stringify(r)).not.toMatch(/https?:|blob:|X-Amz|token=/i);
    }
    const sean = rows.find((r) => Object.keys(r.pose_json.joints).includes("leftLowerArm"))!;
    expect(sean.root_scale).toBeCloseTo(1, 4);
    // the proxies are not part of the Location's set
    await expect(set).toHaveAttribute("data-dirty", "false");

    // ── reload from Postgres ──
    await page.goto(setUrl);
    await expect(set).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(blocking).toHaveAttribute("data-loaded", "true", { timeout: 30_000 });
    await expect(page.getByTestId("blocking-figure")).toHaveCount(2);
    await page.getByTestId("blocking-figure").filter({ hasText: "Yumeko" }).click();
    expect(Number(await page.getByTestId("blocking-pos-x").inputValue())).toBeCloseTo(-0.8, 2);
    expect(Number(await page.getByTestId("blocking-yaw").inputValue())).toBeCloseTo(30, 1);
    expect(Number(await page.getByTestId("head-yaw").inputValue())).toBeCloseTo(20, 0);
    const layerFp = (await blocking.getAttribute("data-saved-fingerprint"))!;
    expect(layerFp).toMatch(/^[0-9a-f]{64}$/);

    // ── master frame shows the proxies; provenance names the blocking ──
    await page.getByTestId("link-shot-camera").click();
    await expect(page.getByTestId("set-status")).toContainText(/Production camera linked/, {
      timeout: 60_000,
    });
    await page.getByTestId("capture-master-frame").click();
    await expect(page.getByTestId("master-frame")).toHaveCount(1, { timeout: 120_000 });
    type Frame = {
      blocking_fingerprint: string | null;
      blocking_json: Array<{
        characterId: string;
        blockingId: string;
        revision: number;
        fingerprint: string;
      }> | null;
      bucket_public: boolean;
    };
    const frames = json<Frame[]>(["--report"]);
    expect(frames[0]!.blocking_fingerprint).toBe(layerFp);
    expect(frames[0]!.blocking_json).toHaveLength(2);
    expect(frames[0]!.bucket_public).toBe(false);
    expect(JSON.stringify(frames[0]!.blocking_json)).not.toMatch(/https?:|blob:|joints|quaternion/i);

    // ── local previs (silent: the audio mux has its own spec) ──
    await page.getByTestId("load-sample-path").click();
    await expect(page.getByTestId("kf-marker")).toHaveCount(3);
    await page.getByTestId("save-path").click();
    await expect(page.getByTestId("path-status")).toContainText("Camera path saved", { timeout: 60_000 });
    const audioToggle = page.getByTestId("include-audio");
    if (await audioToggle.isEnabled()) await audioToggle.uncheck();
    await page.getByTestId("render-previs").click();
    await expect(page.getByTestId("path-status")).toContainText(/Previs saved privately/, {
      timeout: 600_000,
    });
    await expect(page.getByTestId("previs-current")).toBeVisible();
    type Clip = {
      blocking_fingerprint: string | null;
      blocking_json: unknown[] | null;
      has_audio: boolean;
      bucket_public: boolean;
      provenance: { blocking?: { fingerprint: string } } | null;
    };
    const clips = json<Clip[]>(["--report-clips"]);
    expect(clips[0]!.blocking_fingerprint).toBe(layerFp);
    expect(clips[0]!.blocking_json).toHaveLength(2);
    expect(clips[0]!.provenance?.blocking?.fingerprint).toBe(layerFp);
    expect(clips[0]!.bucket_public).toBe(false);

    // ── package: blocking frozen by value; the previs that showed it is referenced ──
    type Pkg = {
      provenance: { fingerprint: string };
      spatialReference?: {
        shotBlocking?: {
          layerFingerprint: string | null;
          figures: Array<{ summary: string; fingerprint: string }>;
        };
        cameraMotion?: { previsAssetId: string | null };
      };
    };
    const get = async () => {
      const r = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
      expect(r.ok()).toBe(true);
      return (await r.json()) as Pkg;
    };
    const a = await get();
    const aText = JSON.stringify(a);
    expect(a.spatialReference!.shotBlocking!.layerFingerprint).toBe(layerFp);
    expect(a.spatialReference!.shotBlocking!.figures).toHaveLength(2);
    expect(a.spatialReference!.shotBlocking!.figures.map((f) => f.summary).join(" ")).toMatch(
      /Yumeko: standing/,
    );
    expect(a.spatialReference!.cameraMotion!.previsAssetId).toBeTruthy();

    // ── a pose change stales the frame and the previs; the old package is a value ──
    await page.getByTestId("blocking-figure").filter({ hasText: "Yumeko" }).click();
    await page.getByTestId("preset-walk_a").click();
    await page.getByTestId("save-blocking").click();
    await expect(page.getByTestId("blocking-status")).toContainText("saved", { timeout: 90_000 });
    await expect(page.getByTestId("previs-stale")).toContainText("STALE BLOCKING");
    await expect(page.getByTestId("master-frame-stale")).toHaveCount(1);
    const b = await get();
    expect(b.provenance.fingerprint).not.toBe(a.provenance.fingerprint);
    expect(b.spatialReference!.cameraMotion!.previsAssetId).toBeNull();
    expect(JSON.stringify(a)).toBe(aText);

    // ── re-anchor after a set change keeps root and pose ──
    await page.getByTestId("add-box").click();
    await page.getByTestId("save-set").click();
    await expect(page.getByTestId("set-status")).toContainText(/Saved — revision/, { timeout: 60_000 });
    await expect(page.getByTestId("blocking-stale")).toContainText("STALE BLOCKING");
    const layerNow = await blocking.getAttribute("data-saved-fingerprint");
    await page.getByTestId("reanchor-blocking").click();
    await expect(page.getByTestId("blocking-status")).toContainText("re-anchored", { timeout: 60_000 });
    await expect(page.getByTestId("blocking-stale")).toHaveCount(0);
    expect(await blocking.getAttribute("data-saved-fingerprint")).toBe(layerNow);
    const after = json<Row[]>(["--report-blocking"]).filter((r) => r.shot_id === shotId);
    expect(after.every((r) => r.scene_fingerprint === r.live_scene_fingerprint)).toBe(true);

    expect(foreign, "no request left the Prism origin or Supabase").toEqual([]);
  });
});

import { execFileSync } from "node:child_process";
import { expect, request as pwRequest, test, type Page } from "@playwright/test";
import { getPrismStudioDevCredentials } from "./dev-credentials";

/**
 * Phase 2F M2C on the REAL stack (no provider call): real Supabase Auth + RLS, spatial control-pass bundles
 * persisted in Postgres, the depth / object-id / Character-mask rasters in the PRIVATE bucket as typed machine data,
 * anonymous access refused, stale detection, and the current bundle frozen by value in the GenerationPackage.
 * Removes everything it creates.
 */
const { email: EMAIL, password: PASSWORD } = getPrismStudioDevCredentials();
const EP = "/projects/ojousama/episodes/ep-1";
const W = 1912;
const H = 800;

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

type Asset = {
  type: string;
  purpose: string;
  source?: string;
  mime: string;
  byte_size: number;
  bucket?: string;
  object_path: string;
  bucket_public?: boolean;
};
type Row = {
  id: string;
  shot_id: string;
  scene_fingerprint: string;
  live_scene_fingerprint: string;
  blocking_fingerprint: string | null;
  camera_source: string;
  camera_path_fingerprint: string | null;
  time_ms: number | null;
  bundle_fingerprint: string;
  width: number;
  height: number;
  depth_encoding: string;
  depth_metadata_json: { units: string; backgroundValue: number; near: number; far: number };
  object_id_encoding: string;
  object_manifest_json: { objects: Array<{ category: string; visiblePixelCount?: number }> };
  character_masks_json: { masks: Record<string, { objectIndex: number; assetId: string }> };
  depth_asset: Asset;
  object_id_asset: Asset;
  mask_assets: Asset[];
};

test.describe("spatial control passes (signed in, Postgres + private Storage)", () => {
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

  test("capture → Postgres + private Storage → anonymous refused → reload → stale → package", async ({
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
    const ready = async () => {
      await expect(set).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
      await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
        timeout: 30_000,
      });
      await expect(page.getByTestId("spatial-passes")).toHaveAttribute("data-loaded", "true", {
        timeout: 30_000,
      });
    };
    await ready();
    await page.getByTestId("load-test-set").click();
    await expect(set).toHaveAttribute("data-object-count", "7");

    // ── author the Shot: both Characters blocked, a saved camera path ──
    const add = async (name: string) => {
      await page.getByTestId("blocking-character").selectOption({ label: name });
      await page.getByTestId("add-character-proxy").click();
      await expect(page.getByTestId("blocking-figure").filter({ hasText: name })).toHaveCount(1);
    };
    await add("Yumeko");
    await setInput(page, "blocking-pos-x", "-0.8");
    await setInput(page, "blocking-pos-z", "-4.6");
    await setInput(page, "blocking-yaw", "30");
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
    await page.getByTestId("load-sample-path").click();
    await expect(page.getByTestId("kf-marker")).toHaveCount(3);
    await page.getByTestId("save-path").click();
    await expect(page.getByTestId("path-status")).toContainText("Camera path saved", { timeout: 60_000 });
    const layerFp = (await page.getByTestId("character-blocking").getAttribute("data-saved-fingerprint"))!;

    // ── capture at the playhead (end of the path) ──
    await page.getByTestId("to-end").click();
    const durationMs = Number(await page.getByTestId("timeline-track").getAttribute("data-duration-ms"));
    await expect(page.getByTestId("spatial-source")).toHaveText(
      `Camera Path · ${(durationMs / 1000).toFixed(3)} s`,
    );
    await page.getByTestId("capture-spatial-passes").click();
    await expect(page.getByTestId("spatial-status")).toContainText(/Control passes saved privately/, {
      timeout: 240_000,
    });
    await expect(page.getByTestId("spatial-bundle")).toHaveCount(1);
    await expect(page.getByTestId("spatial-bundle")).toHaveAttribute("data-state", "current");

    // ── Postgres: one immutable bundle, typed private assets, no URL anywhere ──
    const rows = json<Row[]>(["--report-passes"]).filter((r) => r.shot_id === shotId);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.camera_source).toBe("camera_path");
    expect(r.time_ms).toBe(durationMs);
    expect(r.camera_path_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(r.bundle_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(r.scene_fingerprint).toBe(r.live_scene_fingerprint); // rendered from the live (saved) set
    expect(r.blocking_fingerprint).toBe(layerFp);
    expect([r.width, r.height]).toEqual([W, H]);
    expect(r.depth_encoding).toBe("prism.depth-f32.v1");
    expect(r.object_id_encoding).toBe("prism.object-id-u32.v1");
    expect(r.depth_metadata_json).toMatchObject({
      units: "metres",
      backgroundValue: 0,
      near: 0.05,
      far: 2000,
    });
    expect(r.object_manifest_json.objects.filter((o) => o.category === "character_proxy")).toHaveLength(2);
    expect(r.object_manifest_json.objects.filter((o) => o.category === "set_object").length).toBeGreaterThan(
      0,
    );
    expect(Object.keys(r.character_masks_json.masks)).toHaveLength(2);
    expect(JSON.stringify(r)).not.toMatch(/https?:|blob:|X-Amz|token=|signature=/i);
    // machine data is a typed `data` asset, never an image
    expect(r.depth_asset).toMatchObject({
      type: "data",
      purpose: "spatial_control",
      source: "3d_render",
      mime: "application/x-prism-depth-f32",
      byte_size: W * H * 4,
      bucket: "prism-assets",
      bucket_public: false,
    });
    expect(r.object_id_asset).toMatchObject({
      type: "data",
      mime: "application/x-prism-object-id-u32",
      byte_size: W * H * 4,
    });
    expect(r.mask_assets).toHaveLength(2);
    for (const m of r.mask_assets)
      expect(m).toMatchObject({
        type: "data",
        purpose: "spatial_control",
        mime: "application/x-prism-character-mask-u8",
        byte_size: W * H,
      });

    // ── private storage: not publicly readable, anonymous access refused, the owner reads the exact bytes ──
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (supabaseUrl) {
      const pub = await page.request.get(
        `${supabaseUrl}/storage/v1/object/public/prism-assets/${r.depth_asset.object_path}`,
      );
      expect(pub.ok()).toBe(false);
    }
    const href = (await page.getByTestId("spatial-depth-asset").getAttribute("href"))!;
    const anon = await pwRequest.newContext({ baseURL: baseURL! });
    const anonRes = await anon.get(href, { maxRedirects: 0 });
    expect([401, 403, 404]).toContain(anonRes.status());
    await anon.dispose();
    const owned = await page.request.get(href);
    expect(owned.status()).toBe(200);
    expect(owned.headers()["content-type"] ?? "").toContain("application/x-prism-depth-f32");
    expect((await owned.body()).length).toBe(W * H * 4);

    // ── reload from Postgres; previews decode from the private store ──
    await page.goto(setUrl);
    await ready();
    const bundle = page.getByTestId("spatial-bundle");
    await expect(bundle).toHaveCount(1);
    await expect(bundle).toHaveAttribute("data-state", "current");
    await bundle.getByTestId("spatial-show-previews").click();
    await expect(page.getByTestId("spatial-depth-preview")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("spatial-mask-preview")).toHaveCount(2);

    // ── the package freezes the current bundle by value ──
    type Pkg = {
      provenance: { fingerprint: string };
      assets: Record<string, { type: string; mime: string | null }>;
      spatialReference?: {
        controlPasses?: {
          bundleFingerprint: string;
          depth: { assetId: string };
          characterMasks: unknown[];
        };
      };
    };
    const get = async () => {
      const res = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
      expect(res.ok()).toBe(true);
      return (await res.json()) as Pkg;
    };
    const a = await get();
    const aText = JSON.stringify(a);
    const cp = a.spatialReference!.controlPasses!;
    expect(cp.bundleFingerprint).toBe(r.bundle_fingerprint);
    expect(cp.characterMasks).toHaveLength(2);
    expect(a.assets[cp.depth.assetId]).toMatchObject({ type: "data", mime: "application/x-prism-depth-f32" });

    // ── a blocking change stales it; the old bundle is retained; the old package is a value ──
    await page.getByTestId("blocking-figure").filter({ hasText: "Yumeko" }).click();
    await page.getByTestId("preset-walk_a").click();
    await page.getByTestId("save-blocking").click();
    await expect(page.getByTestId("blocking-status")).toContainText("saved", { timeout: 90_000 });
    await expect(bundle).toHaveAttribute("data-state", "stale");
    await expect(page.getByTestId("spatial-bundle-stale")).toContainText("STALE BLOCKING");
    const b = await get();
    expect(b.spatialReference!.controlPasses).toBeUndefined();
    expect(JSON.stringify(a)).toBe(aText);
    expect(json<Row[]>(["--report-passes"]).filter((x) => x.shot_id === shotId)).toHaveLength(1); // retained

    // ── capture again: a second, different bundle; the package follows it ──
    await page.getByTestId("capture-spatial-passes").click();
    await expect(page.getByTestId("spatial-status")).toContainText(/Control passes saved privately/, {
      timeout: 240_000,
    });
    await expect(page.getByTestId("spatial-bundle")).toHaveCount(2);
    const after = json<Row[]>(["--report-passes"]).filter((x) => x.shot_id === shotId);
    expect(after).toHaveLength(2);
    expect(new Set(after.map((x) => x.bundle_fingerprint)).size).toBe(2);
    const c = await get();
    expect(c.spatialReference!.controlPasses!.bundleFingerprint).not.toBe(cp.bundleFingerprint);
    expect(c.provenance.fingerprint).not.toBe(a.provenance.fingerprint);

    expect(foreign, "no request left the Prism origin or Supabase").toEqual([]);
  });
});

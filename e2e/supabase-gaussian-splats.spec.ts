import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, request as pwRequest, test, type Page } from "@playwright/test";
import { encodeSplatFile, syntheticPlane } from "../src/lib/splat/synthetic";
import { getPrismStudioDevCredentials } from "./dev-credentials";

/**
 * Phase 2F M2D.1 on the REAL stack (no provider call): real Supabase Auth + RLS, a Gaussian-splat Location environment
 * persisted as an immutable reconstruction record in Postgres, its bytes in the PRIVATE bucket as a typed 3D Asset,
 * anonymous access refused, reload from Postgres + Storage, and the environment frozen by value in the
 * GenerationPackage. Removes everything it creates. (Cross-project and stranger access to the table is proved with
 * real RLS identities in `npm run db:reconstructions`.)
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

type Recon = {
  id: string;
  location_id: string;
  method: string;
  result_kind: string;
  result_asset_id: string;
  result_checksum: string;
  result_format: string;
  gaussian_count: number;
  source_assets_json: unknown[];
  calibration_json: { units: string; scaleMethod: string; metresPerSourceUnit: number | null };
  reconstruction_fingerprint: string;
  result_asset: {
    type: string;
    purpose: string;
    source: string;
    mime: string;
    byte_size: number;
    bucket: string;
    object_path: string;
    checksum: string;
    bucket_public: boolean;
  };
};

test.describe("gaussian splat environment (signed in, Postgres + private Storage)", () => {
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

  test("import → Postgres record + private Storage → anonymous refused → reload → package", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(600_000);
    const origin = new URL(baseURL!).origin;
    const foreign: string[] = [];
    page.on("request", (r) => {
      const u = r.url();
      if (u.startsWith("data:") || u.startsWith("blob:")) return;
      if (new URL(u).origin !== origin && !/\.supabase\.co$/.test(new URL(u).hostname)) foreign.push(u);
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
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              (
                window as unknown as { __prismSet: { splat: { sceneLoaded(): boolean } } }
              ).__prismSet.splat.sceneLoaded(),
            ),
          { timeout: 60_000 },
        )
        .toBe(true);
    };
    await ready();
    await page.getByTestId("load-test-set").click();

    // ── import a synthetic splat through the real UI and server action ──
    const file = Buffer.from(encodeSplatFile(syntheticPlane({ n: 24, size: 2, cy: 1 })));
    await page.getByTestId("import-splat-file").setInputFiles({
      name: "canopy.splat",
      mimeType: "application/octet-stream",
      buffer: file,
    });
    await page.getByTestId("import-splat").click();
    const item = page.getByTestId("outliner-item").filter({ hasText: "gaussian splat" });
    await expect(item).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId("splat-gaussians")).toHaveText("576");

    // metric scale only by explicit entry
    await page.getByTestId("splat-metres-per-unit").fill("0.5");
    await page.getByTestId("splat-apply-scale").click();
    await expect(page.getByTestId("splat-scale-status")).toContainText("manual");
    await page.getByTestId("save-set").click();
    await expect(page.getByTestId("set-status")).toContainText(/Saved — revision/, { timeout: 90_000 });

    // ── Postgres: one immutable record, a typed private 3D Asset, no URL anywhere ──
    const rows = json<Recon[]>(["--report-reconstructions"]);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r).toMatchObject({
      method: "imported",
      result_kind: "gaussian_splat",
      result_format: "splat",
      gaussian_count: 576,
      source_assets_json: [],
    });
    expect(r.calibration_json).toMatchObject({
      units: "unknown",
      scaleMethod: "unknown",
      metresPerSourceUnit: null,
    });
    expect(r.reconstruction_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(r.result_asset).toMatchObject({
      type: "3d",
      purpose: "spatial_reconstruction",
      source: "import",
      mime: "application/x-gaussian-splat",
      byte_size: file.length,
      bucket: "prism-assets",
      bucket_public: false,
    });
    expect(r.result_checksum).toBe(createHash("sha256").update(file).digest("hex"));
    expect(r.result_asset.checksum).toBe(r.result_checksum);
    expect(JSON.stringify(r)).not.toMatch(/https?:|blob:|X-Amz|token=|signature=/i);

    // ── private storage: not public, anonymous refused, the owner reads the exact bytes ──
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (supabaseUrl) {
      const pub = await page.request.get(
        `${supabaseUrl}/storage/v1/object/public/prism-assets/${r.result_asset.object_path}`,
      );
      expect(pub.ok()).toBe(false);
    }
    const assetUrl = `/api/assets/${r.result_asset_id}`;
    const anon = await pwRequest.newContext({ baseURL: baseURL! });
    const anonRes = await anon.get(assetUrl, { maxRedirects: 0 });
    expect([401, 403, 404]).toContain(anonRes.status());
    await anon.dispose();
    const owned = await page.request.get(assetUrl);
    expect(owned.status()).toBe(200);
    expect(
      createHash("sha256")
        .update(await owned.body())
        .digest("hex"),
    ).toBe(r.result_checksum);

    // ── reload from Postgres + Storage: the splat returns with its transform and calibration ──
    await page.goto(setUrl);
    await ready();
    await expect(item).toHaveCount(1, { timeout: 120_000 });
    await item.click();
    await expect(page.getByTestId("splat-scale-status")).toContainText("manual — 1 source unit = 0.5 m");
    await expect(page.getByTestId("splat-provenance")).toContainText("imported");
    await expect(page.getByTestId("splat-failure")).toHaveCount(0);

    // ── the package freezes the environment by value; the Asset is described, never linked ──
    await page.getByTestId("link-shot-camera").click();
    await expect(page.getByTestId("set-status")).toContainText(/Production camera linked/, {
      timeout: 90_000,
    });
    const res = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
    expect(res.ok()).toBe(true);
    const pkg = (await res.json()) as {
      assets: Record<string, { mime: string | null }>;
      spatialReference?: {
        spatialEnvironment?: {
          reconstructionId: string;
          reconstructionFingerprint: string;
          assetId: string;
          calibration: { scaleMethod: string; metresPerSourceUnit: number | null };
        };
      };
    };
    const env = pkg.spatialReference!.spatialEnvironment!;
    expect(env.reconstructionId).toBe(r.id);
    expect(env.reconstructionFingerprint).toBe(r.reconstruction_fingerprint);
    expect(env.assetId).toBe(r.result_asset_id);
    expect(env.calibration).toMatchObject({ scaleMethod: "manual", metresPerSourceUnit: 0.5 });
    expect(pkg.assets[env.assetId]!.mime).toBe("application/x-gaussian-splat");
    expect(JSON.stringify(pkg.spatialReference)).not.toMatch(/https?:|blob:|X-Amz|token=|signature=/i);

    expect(foreign, "no request left the Prism origin or Supabase").toEqual([]);
  });
});

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, request as pwRequest, test, type Page } from "@playwright/test";
import { getPrismStudioDevCredentials } from "./dev-credentials";

/**
 * Phase 2F M2D.2 on the REAL stack WITHOUT any external provider: real Supabase Auth + RLS, reconstruction jobs and
 * their events in Postgres, the free mock provider (World Labs unconfigured, paid generation off), the result
 * downloaded, validated and stored in the PRIVATE bucket, an immutable generated reconstruction linked to its job,
 * anonymous access refused. Removes everything it creates.
 */
const { email: EMAIL, password: PASSWORD } = getPrismStudioDevCredentials();
const EP = "/projects/ojousama/episodes/ep-1";
const PREFIX = `e2e-recon-${Date.now()}`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

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

type JobRow = {
  id: string;
  status: string;
  attempt: number;
  provider: string;
  provider_operation_id: string | null;
  provider_inputs_json: Array<{ providerAssetId: string }> | null;
  source_assets_json: Array<{ ordinal: number; assetId: string; checksum: string | null }>;
  result_reconstruction_id: string | null;
  events: number;
  reconstruction: {
    method: string;
    job_id: string;
    provider: string;
    provider_operation_id: string;
    result_asset_id: string;
    source_assets_json: Array<{ assetId: string }>;
    calibration_json: { units: string; scaleMethod: string };
    asset: {
      type: string;
      purpose: string;
      source: string;
      mime: string;
      bucket: string;
      object_path: string;
      checksum: string;
      bucket_public: boolean;
    };
  } | null;
};

test.describe("reconstruction jobs (signed in, Postgres + private Storage, no provider call)", () => {
  test.describe.configure({ mode: "serial" });
  const cleanup = () => {
    try {
      tsx(["--yes", `--e2e-assets-prefix=${PREFIX}`]);
    } catch {
      /* best effort; idempotent */
    }
  };
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("mock job → Postgres job + events → validated private result → generated reconstruction → anonymous refused", async ({
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

    const names = [`${PREFIX}-a.png`, `${PREFIX}-b.png`];
    for (const name of names) {
      await page.goto("/projects/ojousama/assets");
      await page.locator("input[type=file]").setInputFiles({ name, mimeType: "image/png", buffer: PNG });
      await page.locator("select[name=purpose]").first().selectOption("location_ref");
      await page.getByRole("button", { name: "Upload asset" }).click();
      await expect(page.getByText(name).first()).toBeVisible({ timeout: 60_000 });
    }

    await page.goto(`${EP}/shots`);
    await page.getByRole("link", { name: "3A", exact: true }).click();
    await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
    await page.goto(`${page.url().split("?")[0]}?section=set`);
    await page.getByTestId("open-in-3d-set").click();
    await page.waitForURL(/\/locations\/[0-9a-f-]{36}\/3d\?shot=/);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(page.getByTestId("reconstruction-jobs")).toHaveAttribute("data-loaded", "true", {
      timeout: 60_000,
    });

    // World Labs is honestly not configured here; the free mock is the only runnable provider
    await page.getByTestId("recon-provider").selectOption("worldlabs_marble");
    await expect(page.getByTestId("recon-provider-status")).toHaveAttribute("data-state", "not_configured");
    await page.getByTestId("recon-provider").selectOption("mock_reconstruction");
    for (const n of [...names].reverse())
      await page.getByTestId("recon-add-source").filter({ hasText: n }).click();
    await page.getByTestId("recon-option-scenario").selectOption("success");
    await page.getByTestId("recon-generate").click();
    const jobButton = page.getByTestId("recon-job").first();
    await expect(jobButton).toHaveAttribute("data-status", "succeeded", { timeout: 180_000 });
    const jobId = (await jobButton.getAttribute("data-job-id"))!;

    // ── Postgres: the job, its events, its generated reconstruction, the private result ──
    const rows = json<JobRow[]>(["--report-jobs"]).filter((r) => r.id === jobId);
    expect(rows).toHaveLength(1);
    const j = rows[0]!;
    expect(j).toMatchObject({ status: "succeeded", attempt: 1, provider: "mock_reconstruction" });
    expect(j.provider_operation_id).toMatch(/^mockop_success_/);
    expect(j.events).toBeGreaterThanOrEqual(6);
    // the user's order (b first) is the stored order
    const sourceIds = j.source_assets_json.map((s) => s.assetId);
    expect(j.source_assets_json.map((s) => s.ordinal)).toEqual([0, 1]);
    const r = j.reconstruction!;
    expect(r).toMatchObject({
      method: "generated",
      job_id: jobId,
      provider: "mock_reconstruction",
      provider_operation_id: j.provider_operation_id,
    });
    expect(r.source_assets_json.map((s) => s.assetId)).toEqual(sourceIds);
    expect(r.calibration_json).toMatchObject({ units: "unknown", scaleMethod: "unknown" });
    expect(r.asset).toMatchObject({
      type: "3d",
      purpose: "spatial_reconstruction",
      source: "provider_output",
      mime: "application/x-spz",
      bucket: "prism-assets",
      bucket_public: false,
    });
    expect(JSON.stringify(j)).not.toMatch(/https?:|X-Amz|X-Goog|token=|signature=/i);

    // ── private storage: not public, anonymous refused, the owner reads exactly the validated bytes ──
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (supabaseUrl) {
      const pub = await page.request.get(
        `${supabaseUrl}/storage/v1/object/public/prism-assets/${r.asset.object_path}`,
      );
      expect(pub.ok()).toBe(false);
    }
    const assetUrl = `/api/assets/${r.result_asset_id}`;
    const anon = await pwRequest.newContext({ baseURL: baseURL! });
    expect([401, 403, 404]).toContain((await anon.get(assetUrl, { maxRedirects: 0 })).status());
    await anon.dispose();
    const owned = await page.request.get(assetUrl);
    expect(owned.status()).toBe(200);
    expect(
      createHash("sha256")
        .update(await owned.body())
        .digest("hex"),
    ).toBe(r.asset.checksum);

    // ── the Set was not touched by the job ──
    await expect(page.getByTestId("outliner-item").filter({ hasText: "gaussian splat" })).toHaveCount(0);

    expect(foreign, "no request left the Prism origin or Supabase").toEqual([]);
  });
});

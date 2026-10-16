import { execFileSync } from "node:child_process";
import { expect, request as pwRequest, test, type Page } from "@playwright/test";
import { getPrismStudioDevCredentials } from "./dev-credentials";

/**
 * Phase 2F M2A on the REAL stack (no provider call): real Supabase Auth + RLS, the camera path persisted in
 * Postgres, a locally rendered + encoded previs stored in the PRIVATE bucket with provenance, stale detection and
 * the frozen cameraMotion in the GenerationPackage. Removes everything it creates.
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

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("お嬢様、僕と結婚してください。").first()).toBeVisible({ timeout: 30_000 });
}

test.describe("camera motion + local previs (signed in, Postgres + private Storage)", () => {
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

  test("path → save → reload → previs render → private asset → stale → package", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(420_000);
    const origin = new URL(baseURL!).origin;
    const foreign: string[] = [];
    page.on("request", (r) => {
      const u = r.url();
      if (u.startsWith("data:") || u.startsWith("blob:")) return;
      const o = new URL(u).origin;
      // the signed-in app talks to its own origin; Supabase Auth is the only other host the app itself uses
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

    // set, then the Hotel Canopy sample camera path (35 → 50 → 70 mm), saved to Postgres
    await page.getByTestId("load-test-set").click();
    await expect(set).toHaveAttribute("data-object-count", "7");
    await page.getByTestId("load-sample-path").click();
    await expect(page.getByTestId("kf-marker")).toHaveCount(3);
    await page.getByTestId("save-path").click();
    await expect(page.getByTestId("path-status")).toContainText("Camera path saved — revision 1", {
      timeout: 60_000,
    });
    const sceneFp = (await set.getAttribute("data-saved-fingerprint"))!;
    expect(sceneFp).toMatch(/^[0-9a-f]{64}$/);

    // reload from Postgres: keyframes and lens come back
    await page.goto(setUrl);
    await expect(set).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(page.getByTestId("kf-marker")).toHaveCount(3);
    await page.getByTestId("kf-marker").nth(1).click();
    await expect(page.getByTestId("kf-focal")).toHaveValue("50");
    await expect(page.getByTestId("path-state")).toContainText("Saved revision 1");

    // local previs: rendered and encoded in the browser, stored in the private bucket
    await page.getByTestId("render-previs").click();
    await expect(page.getByTestId("path-status")).toContainText(/Previs saved privately \(956×400/, {
      timeout: 300_000,
    });
    const src = (await page.getByTestId("previs-video").getAttribute("src"))!;
    expect(src).toMatch(/^\/api\/assets\/[0-9a-f-]{36}$/); // an application route, never a storage URL
    const anon = await pwRequest.newContext({ baseURL: origin });
    const anonRes = await anon.get(src, { maxRedirects: 0 });
    expect([401, 403, 404]).toContain(anonRes.status());
    await anon.dispose();
    const authed = await page.request.get(src);
    expect(authed.status()).toBe(200);
    expect(authed.headers()["content-type"]).toMatch(/video\/(mp4|webm)/);

    const clips = JSON.parse(tsx(["--report-clips"]).trim().split("\n").pop()!) as Array<
      Record<string, unknown>
    >;
    const c = clips[0]!;
    expect(c.source).toBe("local_previs");
    expect(c.asset_source).toBe("local_previs");
    expect(c.asset_type).toBe("video");
    expect(c.render_width).toBe(956);
    expect(c.render_height).toBe(400);
    expect(c.duration_ms).toBe(4000);
    expect(Number(c.frame_rate)).toBe(24);
    expect(["mp4", "webm"]).toContain(c.container);
    expect(c.scene_fingerprint).toBe(sceneFp);
    expect(c.path_revision).toBe(1);
    expect(c.has_audio).toBe(false);
    expect(c.bucket_public).toBe(false);
    const prov = c.provenance as Record<string, unknown>;
    expect(prov.source).toBe("local_previs");
    expect(prov.cameraPathFingerprint).toBe(c.path_fingerprint);
    expect(prov.sceneFingerprint).toBe(sceneFp);
    expect(prov.container).toBe(c.container);
    expect(prov.renderedAt).toBeTruthy();
    expect(JSON.stringify(prov)).not.toMatch(/https?:|blob:|token=/i);

    // package freezes the motion and the previs asset; a later edit leaves the old package untouched
    const get = async () => {
      const r = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
      expect(r.ok()).toBe(true);
      return (await r.json()) as {
        provenance: { fingerprint: string };
        spatialReference?: {
          cameraMotion?: {
            cameraPathRevision: number;
            cameraPathFingerprint: string;
            keyframes: Array<{ focalLengthMm: number }>;
            previsAssetId: string | null;
          };
        };
      };
    };
    const a = await get();
    const aText = JSON.stringify(a);
    expect(a.spatialReference?.cameraMotion?.cameraPathRevision).toBe(1);
    expect(a.spatialReference?.cameraMotion?.keyframes).toHaveLength(3);
    expect(a.spatialReference?.cameraMotion?.previsAssetId).toBe(c.asset_id);

    await page.getByTestId("kf-marker").nth(2).click();
    await page.getByTestId("kf-focal").fill("85");
    await page.getByTestId("kf-focal").press("Enter");
    await page.getByTestId("save-path").click();
    await expect(page.getByTestId("path-status")).toContainText("Camera path saved — revision 2", {
      timeout: 60_000,
    });
    await expect(page.getByTestId("previs-stale")).toBeVisible();
    const b = await get();
    expect(b.spatialReference?.cameraMotion?.cameraPathRevision).toBe(2);
    expect(b.spatialReference?.cameraMotion?.cameraPathFingerprint).not.toBe(
      a.spatialReference?.cameraMotion?.cameraPathFingerprint,
    );
    expect(b.spatialReference?.cameraMotion?.previsAssetId).toBeNull();
    expect(b.provenance.fingerprint).not.toBe(a.provenance.fingerprint);
    expect(JSON.stringify(a)).toBe(aText);

    // the shot page shows the previs as stale
    await page.goto(`${shotUrl}?section=set`);
    await expect(page.getByTestId("shot-previs")).toBeVisible();
    await expect(page.getByTestId("shot-previs-stale")).toBeVisible();
    expect(foreign, "no request leaves the app origin / Supabase").toEqual([]);
  });
});

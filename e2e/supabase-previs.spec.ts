import { execFileSync } from "node:child_process";
import { expect, request as pwRequest, test, type Page } from "@playwright/test";
import { getPrismStudioDevCredentials } from "./dev-credentials";

/**
 * Phase 2F M1 on the REAL stack (no provider call): real Supabase Auth + RLS, the 3D set persisted in Postgres,
 * the master frame stored in the PRIVATE bucket with provenance, adoption, and the GenerationPackage snapshot.
 * Removes the scene documents, bookmarks, master frames and render assets it creates.
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

test.describe("3D production set (signed in, Postgres + private Storage)", () => {
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

  test("author the Hotel Canopy set → save → reload → link → master frame → adopt → package", async ({
    page,
  }) => {
    test.setTimeout(300_000);
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

    // the synthetic acceptance set (neutral procedural objects only), plus one user-added primitive
    await page.getByTestId("load-test-set").click();
    await expect(set).toHaveAttribute("data-object-count", "7");
    await page.getByTestId("add-box").click();
    await expect(set).toHaveAttribute("data-object-count", "8");
    await page.getByTestId("inspector-pos-x").fill("2.5");
    await page.getByTestId("inspector-pos-x").press("Enter");

    await page.getByTestId("save-set").click();
    await expect(page.getByTestId("set-status")).toContainText("Saved — revision 1");
    const fingerprint = (await set.getAttribute("data-saved-fingerprint"))!;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);

    // reload from Postgres
    await page.goto(setUrl);
    await expect(set).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(set).toHaveAttribute("data-object-count", "8");
    await expect(set).toHaveAttribute("data-saved-fingerprint", fingerprint);
    await expect(page.getByTestId("camera-name")).toHaveText("CAM-A");
    await expect(page.getByTestId("camera-focal")).toHaveValue("35");

    // shot link, then the shot page shows it
    await page.getByTestId("link-shot-camera").click();
    await expect(page.getByTestId("set-status")).toContainText("Production camera linked");
    await page.goto(`${shotUrl}?section=set`);
    await expect(page.getByTestId("shot-camera-link")).toContainText("CAM-A");

    // master frame: rendered locally, stored privately
    await page.goto(setUrl);
    await expect(set).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await page.getByTestId("capture-master-frame").click();
    await expect(page.getByTestId("set-status")).toContainText("Master frame saved privately (1912×800)");
    const src = (await page.getByTestId("master-frame-image").first().getAttribute("src"))!;
    expect(src).toMatch(/^\/api\/assets\/[0-9a-f-]{36}$/); // an application route, never a storage URL

    // private: an unauthenticated client cannot read it; the signed-in one can
    const anon = await pwRequest.newContext({ baseURL: new URL(page.url()).origin });
    const anonRes = await anon.get(src, { maxRedirects: 0 });
    expect([401, 403, 404]).toContain(anonRes.status());
    await anon.dispose();
    const authed = await page.request.get(src);
    expect(authed.status()).toBe(200);
    expect(authed.headers()["content-type"]).toContain("image/png");

    // not adopted until the user says so; then adopted
    await expect(page.getByTestId("master-frame-adopted")).toHaveCount(0);
    await page.getByTestId("adopt-master-frame").first().click();
    await expect(page.getByTestId("master-frame-adopted")).toBeVisible();

    // package: spatial snapshot frozen with the adopted master frame
    const res = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
    expect(res.ok()).toBe(true);
    const pkg = (await res.json()) as {
      spatialReference?: {
        schemaVersion: number;
        sceneRevision: number;
        sceneFingerprint: string;
        masterFrameAssetId: string | null;
        cameraBookmark: { label: string; value: { productionAspectRatio: string } } | null;
        characterBlocking: unknown[];
      };
    };
    expect(pkg.spatialReference?.schemaVersion).toBe(1);
    expect(pkg.spatialReference?.sceneRevision).toBe(1);
    expect(pkg.spatialReference?.sceneFingerprint).toBe(fingerprint);
    expect(pkg.spatialReference?.masterFrameAssetId).toBeTruthy();
    expect(pkg.spatialReference?.cameraBookmark?.label).toBe("CAM-A");
    expect(pkg.spatialReference?.cameraBookmark?.value.productionAspectRatio).toBe("2.39:1");

    // provenance as stored in Postgres / Storage
    const rows = JSON.parse(tsx(["--report"]).trim().split("\n").pop()!) as Array<Record<string, unknown>>;
    const f = rows[0]!;
    expect(f.source).toBe("scene_render");
    expect(f.asset_source).toBe("3d_render");
    expect(f.scene_revision).toBe(1);
    expect(f.scene_fingerprint).toBe(fingerprint);
    expect(f.render_width).toBe(1912);
    expect(f.render_height).toBe(800);
    expect(f.production_aspect_ratio).toBe("2.39:1");
    expect(f.mime).toBe("image/png");
    expect(f.asset_width).toBe(1912);
    expect(f.bucket_public).toBe(false);
    expect(f.adopted).toBe(true);
    expect(f.camera_bookmark_id).toBeTruthy();
    const prov = f.provenance as Record<string, unknown>;
    expect(prov.source).toBe("scene_render");
    expect(prov.sceneFingerprint).toBe(fingerprint);
    expect(prov.capturedAt).toBeTruthy();
    expect(JSON.stringify(prov)).not.toMatch(/https?:|blob:|token=/i);
  });
});

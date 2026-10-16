import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

/** 16-bit mono PCM WAV tone synthesised here (no audio fixture is committed). */
function wav(freq: number, ms: number): Buffer {
  const rate = 48_000;
  const n = Math.round((ms / 1000) * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++)
    data.writeInt16LE(Math.round(0.6 * 32767 * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

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

  let setUrlShared = "";
  let shotIdShared = "";

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
    setUrlShared = setUrl;
    shotIdShared = shotId;
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
    // (this first previs is the silent camera test; audio is covered by the next test)
    await page.getByTestId("include-audio").uncheck();
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

  test("previs WITH performance audio: private asset, audio-mix provenance, history kept, anon refused", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(420_000);
    test.skip(!setUrlShared, "needs the first test");
    const origin = new URL(baseURL!).origin;
    await signIn(page);
    // the dev project's seeded take audio has no stored file: serve synthesised tones to the app's own asset fetch
    const served: string[] = [];
    await page.route(/\/api\/assets\/[0-9a-f-]{36}$/, async (route) => {
      if (route.request().resourceType() !== "fetch") return route.fallback();
      const id = route.request().url().split("/").pop()!;
      served.push(id);
      const freq = 300 + (createHash("sha1").update(id).digest()[0]! % 5) * 110;
      await route.fulfill({ status: 200, contentType: "audio/wav", body: wav(freq, 6000) });
    });
    await page.goto(setUrlShared);
    const set = page.getByTestId("virtual-set");
    await expect(set).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    const support = await page.evaluate(async () => {
      const ok = async (codec: string) => {
        try {
          return Boolean(
            (
              await AudioEncoder.isConfigSupported({
                codec,
                numberOfChannels: 2,
                sampleRate: 48000,
                bitrate: 128000,
              })
            ).supported,
          );
        } catch {
          return false;
        }
      };
      return (await ok("mp4a.40.2")) || (await ok("opus"));
    });
    test.skip(!support, "no browser audio encoder in this Chromium");

    await expect(page.getByTestId("include-audio")).toBeChecked();
    await page.getByTestId("render-previs").click();
    await expect(page.getByTestId("path-status")).toContainText("with performance audio", {
      timeout: 300_000,
    });
    expect(served.length).toBeGreaterThan(0);

    const clips = JSON.parse(tsx(["--report-clips"]).trim().split("\n").pop()!) as Array<
      Record<string, unknown>
    >;
    expect(clips.length).toBeGreaterThanOrEqual(2); // the silent one is retained
    const c = clips[0]!; // newest first
    expect(c.has_audio).toBe(true);
    expect(c.audio_asset_id).toBeNull(); // a mix is not one source asset
    expect(c.audio_mix_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const mix = c.audio_mix_json as {
      schema: string;
      sampleRate: number;
      channels: number;
      codec: string;
      mixFingerprint: string;
      cues: Array<{ assetId: string; timelineStartMs: number; sourceStartMs: number; durationMs: number }>;
    };
    expect(mix.schema).toBe("prism.previs-audio-mix.v1");
    expect(mix.sampleRate).toBe(48000);
    expect(mix.channels).toBe(2);
    expect(["aac", "opus"]).toContain(mix.codec);
    expect(mix.mixFingerprint).toBe(c.audio_mix_fingerprint);
    expect(mix.cues.length).toBeGreaterThan(0);
    expect(mix.cues[0]!.timelineStartMs).toBeGreaterThanOrEqual(0);
    expect(mix.cues[0]!.sourceStartMs).toBe(0);
    expect(JSON.stringify(mix)).not.toMatch(/https?:|blob:|token=|X-Amz|\/object\/sign\//i);
    const prov = c.provenance as Record<string, unknown> & { audio?: Record<string, unknown> };
    expect(prov.hasAudio).toBe(true);
    expect(prov.audio?.mixFingerprint).toBe(c.audio_mix_fingerprint);
    expect(prov.audio?.cueCount).toBe(mix.cues.length);
    expect(JSON.stringify(prov)).not.toMatch(/https?:|blob:|token=/i);
    expect(c.bucket_public).toBe(false);
    const older = clips.find((x) => x.has_audio === false);
    expect(older, "the earlier silent previs is retained").toBeTruthy();

    // private: unauthenticated reads are refused; the signed-in app can read it
    const src = (await page.getByTestId("previs-video").getAttribute("src"))!;
    const anon = await pwRequest.newContext({ baseURL: origin });
    expect([401, 403, 404]).toContain((await anon.get(src, { maxRedirects: 0 })).status());
    await anon.dispose();
    expect((await page.request.get(src)).status()).toBe(200);

    // the package references the audio previs and says it has audio
    const r = await page.request.get(`/api/projects/ojousama/shots/${shotIdShared}/package`);
    const pkg = (await r.json()) as {
      spatialReference?: {
        cameraMotion?: {
          previs?: { assetId: string; hasAudio: boolean; audioMixFingerprint: string | null };
        };
      };
    };
    expect(pkg.spatialReference?.cameraMotion?.previs).toMatchObject({
      assetId: c.asset_id,
      hasAudio: true,
      audioMixFingerprint: c.audio_mix_fingerprint,
    });
  });
});

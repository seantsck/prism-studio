import { describe, expect, it } from "vitest";
import { redactText, redactUrl } from "@/lib/auth/redact";
import { readGenerationConfig } from "../config";
import { SinkConfigError, createOutputSink, isServerSecretKey } from "../sink";

const URL = "https://lyqdxiyjperhniwhzsvg.supabase.co";
const jwt = (role: string) =>
  `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.sig12345`;

describe("worker Storage credential (fails closed)", () => {
  const base = {
    NEXT_PUBLIC_SUPABASE_URL: URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abcdefgh1234",
  };

  it("recognises server secret keys and rejects publishable/anon keys", () => {
    expect(isServerSecretKey("sb_secret_abcdefghijkl")).toBe(true);
    expect(isServerSecretKey(jwt("service_role"))).toBe(true);
    expect(isServerSecretKey(jwt("anon"))).toBe(false);
    expect(isServerSecretKey("sb_publishable_abcdefgh1234")).toBe(false);
    expect(isServerSecretKey("nonsense")).toBe(false);
  });

  it("refuses to start with no credential, even in production", async () => {
    await expect(createOutputSink({ ...base, NODE_ENV: "production" }, "supabase")).rejects.toBeInstanceOf(
      SinkConfigError,
    );
  });

  it("refuses a publishable key supplied as the worker secret", async () => {
    await expect(
      createOutputSink(
        { ...base, PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY: "sb_publishable_abcdefgh1234" },
        "supabase",
      ),
    ).rejects.toBeInstanceOf(SinkConfigError);
  });

  it("accepts the preferred secret key and the legacy service key", async () => {
    const a = await createOutputSink(
      { ...base, PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY: "sb_secret_abcdefghijkl" },
      "supabase",
    );
    const b = await createOutputSink(
      { ...base, PRISM_STUDIO_WORKER_SERVICE_KEY: jwt("service_role") },
      "supabase",
    );
    expect([a.name, b.name]).toEqual(["supabase", "supabase"]);
  });

  it("test-user storage needs an explicit opt-in and is never available in production", async () => {
    const creds = { ...base, PRISM_STUDIO_TEST_EMAIL: "a@b.c", PRISM_STUDIO_TEST_PASSWORD: "pw-pw-pw-pw" };
    await expect(createOutputSink(creds, "supabase")).rejects.toBeInstanceOf(SinkConfigError);
    await expect(
      createOutputSink(
        { ...creds, NODE_ENV: "production", PRISM_STUDIO_WORKER_DEV_STORAGE: "1" },
        "supabase",
      ),
    ).rejects.toBeInstanceOf(SinkConfigError);
  });

  it("refuses another Supabase project", async () => {
    await expect(
      createOutputSink(
        {
          ...base,
          NEXT_PUBLIC_SUPABASE_URL: "https://other.supabase.co",
          PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY: "sb_secret_abcdefghijkl",
        },
        "supabase",
      ),
    ).rejects.toBeInstanceOf(SinkConfigError);
  });
});

describe("paid-generation gate configuration", () => {
  it("defaults to disabled with no ceiling", () => {
    const c = readGenerationConfig({ NODE_ENV: "test" });
    expect(c.paid).toEqual({ enabled: false, maxUsd: null });
  });
  it("having a provider key does not enable spending", () => {
    const c = readGenerationConfig({ NODE_ENV: "test", RUNWAYML_API_SECRET: "key_x" });
    expect(c.paid.enabled).toBe(false);
  });
  it("parses the switch and a positive ceiling; garbage means no ceiling", () => {
    expect(
      readGenerationConfig({
        PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
        PRISM_STUDIO_MAX_GENERATION_USD: "1.5",
      }).paid,
    ).toEqual({
      enabled: true,
      maxUsd: 1.5,
    });
    expect(readGenerationConfig({ PRISM_STUDIO_MAX_GENERATION_USD: "-3" }).paid.maxUsd).toBeNull();
    expect(readGenerationConfig({ PRISM_STUDIO_MAX_GENERATION_USD: "abc" }).paid.maxUsd).toBeNull();
  });
});

describe("secret redaction covers worker/provider secrets and signed URLs", () => {
  it("masks literal worker secrets from the environment", () => {
    const old = { ...process.env };
    process.env.RUNWAYML_API_SECRET = "key_live_0123456789abcdef";
    process.env.PRISM_STUDIO_WORKER_DB_URL =
      "postgresql://prism_generation_worker.ref:SuperSecretPw99@host:5432/postgres";
    try {
      const text = redactText(
        "boom key_live_0123456789abcdef and SuperSecretPw99 and postgresql://u:SuperSecretPw99@h/db",
      );
      expect(text).not.toContain("key_live_0123456789abcdef");
      expect(text).not.toContain("SuperSecretPw99");
    } finally {
      process.env = old;
    }
  });
  it("masks signature-bearing query values of signed media URLs", () => {
    const out = redactUrl(
      "https://cdn.example.com/v.mp4?X-Amz-Signature=abc123&X-Amz-Credential=cred&Expires=1&token=t",
    );
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("cred");
    expect(out).toContain("Expires=1");
  });
});

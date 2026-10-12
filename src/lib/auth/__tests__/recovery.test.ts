import { describe, expect, it, vi } from "vitest";
import { isPublicPath } from "../public-paths";
import { parseAuthErrorReason, reasonForCallbackError, updatePasswordMessage } from "../auth-errors";
import { validateNewPassword, isPlausibleEmail } from "../password-policy";
import {
  PASSWORD_UPDATED_LOGIN_PATH,
  requestPasswordReset,
  resolveAuthCallback,
  updatePasswordWithSession,
  type CallbackClient,
  type ResetClient,
  type UpdateClient,
} from "../recovery";
import { LOCAL_SITE_URL, normalizeSiteUrl, recoveryRedirectUrl, resolveSiteUrl } from "../site-url";

// Safe fake values only. Never real tokens.
const FAKE_CODE = "fake-code-123";
const FAKE_JWT = "eyJfakeheader0000.eyJfakepayload0000.fakesignature";
const FAKE_PASSWORD = "correct horse battery staple";

describe("site url", () => {
  it("defaults to Prism Studio's local origin (not Prism Engine on :3000)", () => {
    expect(resolveSiteUrl({ NODE_ENV: "development" })).toBe("http://localhost:3100");
    expect(LOCAL_SITE_URL).not.toContain("3000");
  });

  it("prefers explicit configuration and normalises it to a bare origin", () => {
    expect(
      resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "https://studio.prismsuite.io/", NODE_ENV: "production" }),
    ).toBe("https://studio.prismsuite.io");
    expect(normalizeSiteUrl("http://localhost:3100/some/path?x=1#h")).toBe("http://localhost:3100");
  });

  it("uses the deployment URL only for production builds, and refuses to guess otherwise", () => {
    expect(resolveSiteUrl({ VERCEL_URL: "studio-abc.vercel.app", NODE_ENV: "production" })).toBe(
      "https://studio-abc.vercel.app",
    );
    expect(resolveSiteUrl({ VERCEL_URL: "studio-abc.vercel.app", NODE_ENV: "development" })).toBe(
      LOCAL_SITE_URL,
    );
    expect(() => resolveSiteUrl({ NODE_ENV: "production" })).toThrow();
  });

  it("rejects unsafe schemes, remote http and credentials", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "ftp://studio.example",
      "http://studio.example",
    ]) {
      expect(() => normalizeSiteUrl(bad)).toThrow();
    }
    expect(() => normalizeSiteUrl("https://user:pw@studio.example")).toThrow();
    expect(() => resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "not a url" })).toThrow();
  });

  it("builds the recovery redirect on this app's origin with the update-password target", () => {
    expect(recoveryRedirectUrl("http://localhost:3100")).toBe(
      "http://localhost:3100/auth/callback?next=/update-password",
    );
    expect(recoveryRedirectUrl("https://studio.prismsuite.io")).toBe(
      "https://studio.prismsuite.io/auth/callback?next=/update-password",
    );
  });
});

describe("requestPasswordReset (forgot password)", () => {
  const client = (error: unknown = null) => {
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ error });
    return { resetPasswordForEmail, client: { auth: { resetPasswordForEmail } } as ResetClient };
  };

  it("asks Supabase for a link that returns to Prism Studio, not Prism Engine", async () => {
    const { client: c, resetPasswordForEmail } = client();
    const res = await requestPasswordReset(c, " owner@example.com ", "http://localhost:3100");
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/If an account exists/);
    expect(resetPasswordForEmail).toHaveBeenCalledWith("owner@example.com", {
      redirectTo: "http://localhost:3100/auth/callback?next=/update-password",
    });
    expect(resetPasswordForEmail.mock.calls[0]![1].redirectTo).not.toContain(":3000");
  });

  it("rejects malformed email locally, before any network call", async () => {
    for (const bad of ["", "nope", "a@b", "a b@c.de", "@example.com", "x@@example.com"]) {
      const { client: c, resetPasswordForEmail } = client();
      const res = await requestPasswordReset(c, bad, "http://localhost:3100");
      expect(res.ok).toBe(false);
      expect(resetPasswordForEmail).not.toHaveBeenCalled();
    }
    expect(isPlausibleEmail("owner+studio@example.com")).toBe(true);
  });

  it("says the same thing whether or not the account exists", async () => {
    const known = await requestPasswordReset(client().client, "known@example.com", "http://localhost:3100");
    const unknown = await requestPasswordReset(client().client, "ghost@example.com", "http://localhost:3100");
    expect(known).toEqual(unknown);
  });

  it("maps rate limits, network failures and unexpected errors to fixed messages", async () => {
    const leak = `boom ${FAKE_JWT} postgres://u:secretpw@db.example/x`;
    const rate = await requestPasswordReset(
      client({ status: 429, code: "over_email_send_rate_limit", message: leak }).client,
      "a@example.com",
      "http://localhost:3100",
    );
    expect(rate.message).toMatch(/Too many/);
    const net = await requestPasswordReset(
      client({ name: "AuthRetryableFetchError", status: 0, message: leak }).client,
      "a@example.com",
      "http://localhost:3100",
    );
    expect(net.message).toMatch(/reach the server/);
    const other = await requestPasswordReset(
      client({ status: 500, code: "unexpected_failure", message: leak }).client,
      "a@example.com",
      "http://localhost:3100",
    );
    const thrown = await requestPasswordReset(
      { auth: { resetPasswordForEmail: vi.fn().mockRejectedValue(new Error(leak)) } },
      "a@example.com",
      "http://localhost:3100",
    );
    for (const r of [rate, net, other, thrown]) {
      expect(r.ok).toBe(false);
      expect(r.message).not.toContain(FAKE_JWT);
      expect(r.message).not.toContain("secretpw");
      expect(r.message).not.toContain("boom");
    }
  });
});

describe("resolveAuthCallback (PKCE)", () => {
  const client = (error: unknown = null) => {
    const exchangeCodeForSession = vi.fn().mockResolvedValue({ error });
    return { exchangeCodeForSession, client: { auth: { exchangeCodeForSession } } as CallbackClient };
  };
  const params = (qs: string) => new URLSearchParams(qs);

  it("exchanges the code and continues to the validated next path", async () => {
    const { client: c, exchangeCodeForSession } = client();
    const res = await resolveAuthCallback(params(`code=${FAKE_CODE}&next=/update-password`), c);
    expect(exchangeCodeForSession).toHaveBeenCalledWith(FAKE_CODE);
    expect(res.path).toBe("/update-password");
  });

  it("rejects external and protocol-relative next targets", async () => {
    for (const next of ["https://evil.example", "//evil.example", "javascript:alert(1)", "/\\evil.example"]) {
      const res = await resolveAuthCallback(
        params(`code=${FAKE_CODE}&next=${encodeURIComponent(next)}`),
        client().client,
      );
      expect(res.path).toBe("/");
    }
  });

  it("a missing or absurd code fails safely without calling Supabase", async () => {
    const { client: c, exchangeCodeForSession } = client();
    expect((await resolveAuthCallback(params("next=/update-password"), c)).path).toBe(
      "/auth/error?reason=failed",
    );
    expect((await resolveAuthCallback(params("code="), c)).path).toBe("/auth/error?reason=failed");
    expect((await resolveAuthCallback(params(`code=${"x".repeat(600)}`), c)).path).toBe(
      "/auth/error?reason=failed",
    );
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("an invalid / used / expired code gives a friendly error page, with nothing echoed", async () => {
    const cases: [string, string][] = [
      ["flow_state_not_found", "used"],
      ["flow_state_expired", "expired"],
      ["otp_expired", "expired"],
      ["bad_code_verifier", "session"],
      ["something_else", "failed"],
    ];
    for (const [code, reason] of cases) {
      const res = await resolveAuthCallback(
        params(`code=${FAKE_CODE}&next=/update-password`),
        client({ code, message: `raw ${FAKE_CODE} ${FAKE_JWT}` }).client,
      );
      expect(res.path).toBe(`/auth/error?reason=${reason}`);
      expect(res.path).not.toContain(FAKE_CODE);
      expect(res.path).not.toContain(FAKE_JWT);
    }
  });

  it("treats Supabase's own error redirect parameters as link problems", async () => {
    const res = await resolveAuthCallback(
      params("error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid"),
      client().client,
    );
    expect(res.path).toBe("/auth/error?reason=expired");
  });

  it("an exchange that throws never surfaces the exception", async () => {
    const c: CallbackClient = {
      auth: { exchangeCodeForSession: vi.fn().mockRejectedValue(new Error(FAKE_JWT)) },
    };
    const res = await resolveAuthCallback(params(`code=${FAKE_CODE}`), c);
    expect(res.path).toBe("/auth/error?reason=failed");
  });
});

describe("password policy", () => {
  it("rejects short and mismatched passwords, accepts long passphrases", () => {
    expect(validateNewPassword("short", "short").password).toBeDefined();
    expect(validateNewPassword(FAKE_PASSWORD, "different").confirm).toBeDefined();
    expect(validateNewPassword(FAKE_PASSWORD, FAKE_PASSWORD)).toEqual({});
    expect(validateNewPassword("a".repeat(73), "a".repeat(73)).password).toBeDefined();
    expect(validateNewPassword("a".repeat(72), "a".repeat(72))).toEqual({});
  });
});

describe("updatePasswordWithSession", () => {
  const client = (opts: { user?: boolean; updateError?: unknown; globalFails?: boolean } = {}) => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: opts.user === false ? null : { id: "u1" } } });
    const updateUser = vi.fn().mockResolvedValue({ error: opts.updateError ?? null });
    const signOut = vi
      .fn()
      .mockImplementation(async (o?: { scope?: string }) =>
        opts.globalFails && o?.scope === "global" ? { error: { code: "x" } } : { error: null },
      );
    return {
      getUser,
      updateUser,
      signOut,
      client: { auth: { getUser, updateUser, signOut } } as UpdateClient,
    };
  };

  it("rejects a mismatch or weak password before any Supabase call", async () => {
    for (const [pw, confirm] of [
      [FAKE_PASSWORD, "nope"],
      ["short", "short"],
    ] as const) {
      const c = client();
      const out = await updatePasswordWithSession(c.client, pw, confirm);
      expect(out.status).toBe("invalid");
      expect(c.getUser).not.toHaveBeenCalled();
      expect(c.updateUser).not.toHaveBeenCalled();
    }
  });

  it("without a recovery/auth session the password is never changed", async () => {
    const c = client({ user: false });
    const out = await updatePasswordWithSession(c.client, FAKE_PASSWORD, FAKE_PASSWORD);
    expect(out.status).toBe("no_session");
    expect(c.updateUser).not.toHaveBeenCalled();
  });

  it("updates the password, then ends the recovery session globally", async () => {
    const c = client();
    const out = await updatePasswordWithSession(c.client, FAKE_PASSWORD, FAKE_PASSWORD);
    expect(out).toEqual({ status: "updated" });
    expect(c.updateUser).toHaveBeenCalledWith({ password: FAKE_PASSWORD });
    expect(c.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(PASSWORD_UPDATED_LOGIN_PATH).toBe("/login?passwordUpdated=1");
    expect(PASSWORD_UPDATED_LOGIN_PATH).not.toContain(FAKE_PASSWORD);
  });

  it("still drops this browser's session when global sign-out fails", async () => {
    const c = client({ globalFails: true });
    await updatePasswordWithSession(c.client, FAKE_PASSWORD, FAKE_PASSWORD);
    expect(c.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("maps Supabase failures to fixed messages that never contain the password or raw text", async () => {
    for (const updateError of [
      { code: "same_password", message: `same ${FAKE_PASSWORD}` },
      { code: "weak_password", message: `weak ${FAKE_PASSWORD}` },
      { code: "unexpected", message: `${FAKE_JWT} ${FAKE_PASSWORD}` },
    ]) {
      const out = await updatePasswordWithSession(
        client({ updateError }).client,
        FAKE_PASSWORD,
        FAKE_PASSWORD,
      );
      const text = JSON.stringify(out);
      expect(out.status).toBe("error");
      expect(text).not.toContain(FAKE_PASSWORD);
      expect(text).not.toContain(FAKE_JWT);
    }
    const noSession = await updatePasswordWithSession(
      client({ updateError: { code: "session_not_found" } }).client,
      FAKE_PASSWORD,
      FAKE_PASSWORD,
    );
    expect(noSession.status).toBe("no_session");
    expect(updatePasswordMessage({ code: "weak_password" })).toMatch(/too easy to guess/);
  });
});

describe("error reasons and public routes", () => {
  it("only whitelisted reasons are accepted for the error page", () => {
    expect(parseAuthErrorReason("expired")).toBe("expired");
    expect(parseAuthErrorReason("<script>alert(1)</script>")).toBe("failed");
    expect(parseAuthErrorReason(FAKE_JWT)).toBe("failed");
    expect(reasonForCallbackError(undefined)).toBe("failed");
  });

  it("auth-flow pages are public; the app itself is not", () => {
    for (const p of ["/forgot-password", "/update-password", "/auth/callback", "/auth/error"]) {
      expect(isPublicPath(p)).toBe(true);
    }
    for (const p of ["/", "/projects/ojousama", "/api/assets/x", "/auth/callback/x", "/auth"]) {
      expect(isPublicPath(p)).toBe(false);
    }
  });
});

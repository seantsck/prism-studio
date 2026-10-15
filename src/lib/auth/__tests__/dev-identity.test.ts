import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPrismStudioDevCredentials } from "../../../../e2e/dev-credentials";
import { redactText } from "../redact";

const EMAIL = "PRISM_STUDIO_DEV_USER_EMAIL";
const PASSWORD = "PRISM_STUDIO_DEV_USER_PASSWORD";
// built from parts so this file does not itself contain the retired names
const RETIRED = ["PRISM_STUDIO_TEST_", "PRISM_STUDIO_DEV_EMAIL", "PRISM_STUDIO_DEV_PASSWORD"];

afterEach(() => vi.unstubAllEnvs());

describe("one local dev identity", () => {
  it("returns the email and password of the dev user", () => {
    vi.stubEnv(EMAIL, " dev@example.test ");
    vi.stubEnv(PASSWORD, "correct-horse-battery");
    expect(getPrismStudioDevCredentials()).toEqual({
      email: "dev@example.test",
      password: "correct-horse-battery",
    });
  });

  it("requires PRISM_STUDIO_DEV_USER_EMAIL and names only the variable in the error", () => {
    vi.stubEnv(EMAIL, "");
    vi.stubEnv(PASSWORD, "correct-horse-battery");
    expect(() => getPrismStudioDevCredentials()).toThrow(EMAIL);
    try {
      getPrismStudioDevCredentials();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("correct-horse-battery");
    }
  });

  it("requires PRISM_STUDIO_DEV_USER_PASSWORD", () => {
    vi.stubEnv(EMAIL, "dev@example.test");
    vi.stubEnv(PASSWORD, "   ");
    expect(() => getPrismStudioDevCredentials()).toThrow(PASSWORD);
  });

  it("does not fall back to any retired TEST_/DEV_EMAIL/DEV_PASSWORD variable", () => {
    vi.stubEnv(EMAIL, "");
    vi.stubEnv(PASSWORD, "");
    vi.stubEnv(`${RETIRED[0]}EMAIL`, "other@example.test");
    vi.stubEnv(`${RETIRED[0]}PASSWORD`, "other-password-1");
    vi.stubEnv(RETIRED[1]!, "legacy@example.test");
    vi.stubEnv(RETIRED[2]!, "legacy-password-1");
    expect(() => getPrismStudioDevCredentials()).toThrow(/Missing required environment variable/);
  });

  it("no tracked file still names the retired credential variables", () => {
    const pattern = RETIRED.join("|");
    let hits = "";
    try {
      hits = execFileSync(
        "git",
        ["grep", "-lE", pattern, "--", ".", ":!src/lib/auth/__tests__/dev-identity.test.ts"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );
    } catch {
      hits = ""; // git grep exits 1 on no match
    }
    expect(hits.trim()).toBe("");
  });

  it("redacts the dev user's password from anything that gets printed", () => {
    vi.stubEnv(PASSWORD, "s3cret-dev-pass-value");
    const out = redactText("sign-in failed for s3cret-dev-pass-value (retry)");
    expect(out).not.toContain("s3cret-dev-pass-value");
  });
});

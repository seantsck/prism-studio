import { describe, expect, it } from "vitest";
import { describeError, redactText, redactUrl } from "../redact";
import { safeInternalPath } from "../safe-redirect";

describe("safeInternalPath", () => {
  it("accepts same-site paths unchanged", () => {
    for (const ok of [
      "/projects",
      "/update-password",
      "/projects/123",
      "/projects/ojousama/perform?take=2#t",
      "/a/b%20c",
    ]) {
      expect(safeInternalPath(ok, "/fallback")).toBe(ok);
    }
  });

  it("rejects absolute, protocol-relative, scheme and backslash redirects", () => {
    const bad = [
      "https://evil.example",
      "http://evil.example/x",
      "//evil.example",
      "///evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "\\/evil.example",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "evil.example",
      "",
      "projects",
      "/ /evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      " //evil.example",
    ];
    for (const value of bad) expect(safeInternalPath(value, "/fallback")).toBe("/fallback");
  });

  it("rejects encoded bypasses, including double encoding and malformed escapes", () => {
    const bad = [
      "/%2Fevil.example",
      "/%2f%2fevil.example",
      "/%5Cevil.example",
      "/%255Cevil.example",
      "/%252F%252Fevil.example",
      "%2F%2Fevil.example",
      "/%0d%0aSet-Cookie:x=1",
      "/%E0%A4%A",
      "/%00",
    ];
    for (const value of bad) expect(safeInternalPath(value, "/fallback")).toBe("/fallback");
  });

  it("rejects non-strings and oversized values", () => {
    expect(safeInternalPath(undefined, "/f")).toBe("/f");
    expect(safeInternalPath(null, "/f")).toBe("/f");
    expect(safeInternalPath(["/a"], "/f")).toBe("/f");
    expect(safeInternalPath(`/${"a".repeat(3000)}`, "/f")).toBe("/f");
  });
});

describe("redaction", () => {
  const FAKE_JWT = "eyJfakeheader0000.eyJfakepayload0000.fakesignature";

  it("redactUrl drops the fragment and masks sensitive query values", () => {
    const url =
      "http://localhost:3100/auth/callback?code=abc123&next=/update-password&token_hash=th&access_token=at#access_token=at2&refresh_token=rt&type=recovery";
    const out = redactUrl(url);
    expect(out).toBe(
      "http://localhost:3100/auth/callback?code=[redacted]&next=/update-password&token_hash=[redacted]&access_token=[redacted]",
    );
    for (const secret of ["abc123", "at2", "rt", "recovery"]) expect(out).not.toContain(secret);
  });

  it("redactUrl leaves harmless URLs alone and tolerates garbage", () => {
    expect(redactUrl("/projects/x?tab=2")).toBe("/projects/x?tab=2");
    expect(() => redactUrl("::not a url::#frag")).not.toThrow();
    expect(redactUrl("::not a url::#frag")).toBe("::not a url::");
  });

  it("redactText masks tokens, passwords, headers and connection strings", () => {
    const text = [
      `failed: access_token=sekret-at refresh_token: sekret-rt`,
      `Authorization: Bearer sekret-bearer-1234`,
      `Cookie: sb-ref-auth-token=sekret-cookie; other=1`,
      `Set-Cookie: sb-ref-auth-token=sekret-set; Path=/`,
      `{"password":"sekret-pw","code":"sekret-code"}`,
      `postgres://postgres.ref:sekret-dbpw@aws-0.pooler.supabase.com:5432/postgres`,
      `jwt ${FAKE_JWT}`,
      `http://localhost:3100/#access_token=sekret-frag&type=recovery`,
    ].join("\n");
    const out = redactText(text);
    for (const s of [
      "sekret-at",
      "sekret-rt",
      "sekret-bearer",
      "sekret-cookie",
      "sekret-set",
      "sekret-pw",
      "sekret-code",
      "sekret-dbpw",
      FAKE_JWT,
      "sekret-frag",
    ]) {
      expect(out).not.toContain(s);
    }
    expect(out).toContain("[redacted]");
  });

  it("describeError never leaks via error messages", () => {
    const err = new Error(`bad ${FAKE_JWT} password=hunter2hunter2`);
    const out = describeError(err);
    expect(out).not.toContain(FAKE_JWT);
    expect(out).not.toContain("hunter2");
    expect(describeError("plain")).toBe("plain");
  });
});

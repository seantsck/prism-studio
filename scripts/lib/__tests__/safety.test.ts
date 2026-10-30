import { describe, expect, it } from "vitest";
import { assertProjectRef, disposableLocalTarget, printBanner, redact, safeTarget } from "../safety.mjs";

const env = {
  SUPABASE_DB_URL:
    "postgresql://postgres.lyqdxiyjperhniwhzsvg:s3cr3tPassw0rd@aws-0-x.pooler.supabase.com:5432/postgres",
};

describe("script safety", () => {
  it("redacts the password inside connection strings and bare occurrences", () => {
    const out = redact(`connect failed for ${env.SUPABASE_DB_URL}; password s3cr3tPassw0rd rejected`, env);
    expect(out).not.toContain("s3cr3tPassw0rd");
    expect(out).toContain("postgres.lyqdxiyjperhniwhzsvg:***@");
  });

  it("redacts auth tokens, cookies and fragments", () => {
    const out = redact(
      "Cookie: sb-x=abc123; refresh_token=rt-value http://h/#access_token=at-value&type=recovery",
      {},
    );
    for (const s of ["abc123", "rt-value", "at-value"]) expect(out).not.toContain(s);
  });

  it("redacts JWT-shaped and sb_ keys", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    expect(redact(`token ${jwt}`, {})).toBe("token ***jwt***");
    expect(redact("key sb_secret_abcdefghijkl", {})).toBe("key ***key***");
  });

  it("target description never includes user or password", () => {
    expect(safeTarget(env.SUPABASE_DB_URL)).toBe("aws-0-x.pooler.supabase.com:5432/postgres");
  });

  it("refuses connection strings for another project", () => {
    expect(() => assertProjectRef("postgresql://u:p@db.otherref.supabase.co/postgres")).toThrow(/refusing/);
    expect(() => assertProjectRef(undefined)).toThrow(/not set/);
    expect(() => assertProjectRef(env.SUPABASE_DB_URL)).not.toThrow();
  });

  it("a disposable local database only with the explicit opt-in, a loopback host and a prism_disposable name", () => {
    const local = "postgresql://postgres:pw@127.0.0.1:55432/prism_disposable_3a4c";
    const on = { PRISM_STUDIO_DISPOSABLE_DB: "1" };
    expect(disposableLocalTarget(local, on)).toBe(true);
    expect(() => assertProjectRef(local, "SUPABASE_DB_URL", on)).not.toThrow();
    // without the opt-in, a local URL is refused like any other
    expect(disposableLocalTarget(local, {})).toBe(false);
    expect(() => assertProjectRef(local, "SUPABASE_DB_URL", {})).toThrow(/refusing/);
    // a remote host or another database name never qualifies, even with the opt-in
    for (const url of [
      "postgresql://u:p@db.otherref.supabase.co:5432/prism_disposable",
      "postgresql://u:p@10.0.0.5:5432/prism_disposable",
      "postgresql://u:p@127.0.0.1:55432/postgres",
      "postgresql://u:p@localhost.evil.example:5432/prism_disposable",
    ]) {
      expect(disposableLocalTarget(url, on), url).toBe(false);
      expect(() => assertProjectRef(url, "SUPABASE_DB_URL", on), url).toThrow(/refusing/);
    }
    const lines: string[] = [];
    printBanner({ mode: "validate", url: local, log: (l) => lines.push(l), env: on });
    expect(lines.join(" ")).toContain("DISPOSABLE LOCAL DATABASE");
    expect(lines.join(" ")).not.toContain("pw");
  });

  it("banner prints project, host, mode and owner but no secrets", () => {
    const lines: string[] = [];
    printBanner({ mode: "seed", url: env.SUPABASE_DB_URL, devOwner: "7b5fdc2d", log: (l) => lines.push(l) });
    const text = lines.join("\n");
    expect(text).toContain("lyqdxiyjperhniwhzsvg");
    expect(text).toContain("Mode:                    seed");
    expect(text).toContain("Dev owner:               7b5fdc2d");
    expect(text).not.toContain("s3cr3tPassw0rd");
  });
});

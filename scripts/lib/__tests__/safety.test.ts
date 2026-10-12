import { describe, expect, it } from "vitest";
import { assertProjectRef, printBanner, redact, safeTarget } from "../safety.mjs";

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

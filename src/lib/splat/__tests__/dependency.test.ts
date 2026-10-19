import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };

describe("Gaussian-splat runtime dependency metadata", () => {
  it("pins Spark and fflate to exact versions (no floating range)", () => {
    expect(pkg.dependencies["@sparkjsdev/spark"]).toBe("0.1.10");
    expect(pkg.dependencies["fflate"]).toBe("0.8.3");
  });

  it("the installed packages carry the MIT licence recorded in the notices", () => {
    const spark = JSON.parse(read("node_modules/@sparkjsdev/spark/package.json")) as {
      version: string;
      license: string;
    };
    const fflate = JSON.parse(read("node_modules/fflate/package.json")) as {
      version: string;
      license: string;
    };
    expect(spark).toMatchObject({ version: "0.1.10", license: "MIT" });
    expect(fflate).toMatchObject({ version: "0.8.3", license: "MIT" });
    expect(read("node_modules/@sparkjsdev/spark/LICENSE")).toMatch(/The MIT License/);
    const notices = read("THIRD_PARTY_NOTICES.md");
    expect(notices).toMatch(/@sparkjsdev\/spark/);
    expect(notices).toMatch(/0\.1\.10/);
    expect(notices).toMatch(/World Labs/);
  });

  it("peers: Spark 0.1.10 needs no three.js beyond the one Prism pins", () => {
    const spark = JSON.parse(read("node_modules/@sparkjsdev/spark/package.json")) as {
      peerDependencies?: Record<string, string>;
    };
    expect(spark.peerDependencies?.three).toBeUndefined();
  });

  it("the Spark bundle has no network URL on an executable path", () => {
    const bundle = read("node_modules/@sparkjsdev/spark/dist/spark.module.js");
    // only reference links inside source comments may appear
    const urls = [...bundle.matchAll(/https?:\/\/[A-Za-z0-9./_-]+/g)].map((m) => m[0]);
    for (const url of urls) expect(url).toMatch(/wikipedia\.org|russellcottrell\.com/);
    expect(bundle).not.toMatch(/\bfetch\(\s*["'`]https?:/);
  });

  it("no splat asset, demo scene or binary fixture is tracked by git", () => {
    const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
    expect(files.filter((f) => /\.(splat|spz|ply|ksplat|sog)$/i.test(f))).toEqual([]);
  });
});

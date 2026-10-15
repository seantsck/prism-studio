import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { redactText } from "@/lib/auth/redact";
import { analyzerStatuses, createAnalysisProviders, readAnalysisConfig } from "../analysis/registry";
import { FakeOpenAITransport, openaiAnswerAll } from "../providers/openai/fake-transport";
import { ctx, makeInput, mediaFor } from "../analysis/__tests__/fixtures";

const KEY = "sk-proj-TESTKEYDONOTUSE1234567890abcdefABCDEF";
const env = {
  PRISM_STUDIO_CONTINUITY_ANALYZERS: "mock,openai",
  OPENAI_API_KEY: KEY,
  PRISM_STUDIO_ALLOW_PAID_ANALYSIS: "false",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|mjs)$/.test(f) && !p.includes("__tests__")) out.push(p);
  }
  return out;
}

describe("OpenAI credential handling", () => {
  it("is never referenced by browser-reachable code (routes, components, client modules)", () => {
    const offenders = [...walk("src/app"), ...walk("src/components")].filter((p) =>
      /OPENAI_API_KEY|from "openai"|import\("openai"\)/.test(readFileSync(p, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("is never exposed through a NEXT_PUBLIC_ variable name; .env.example commits no value", () => {
    for (const p of [...walk("src"), ...walk("scripts")]) {
      expect(/NEXT_PUBLIC_[A-Z_]*OPENAI/.test(readFileSync(p, "utf8")), p).toBe(false);
    }
    const example = readFileSync(".env.example", "utf8");
    expect(example).toMatch(/^OPENAI_API_KEY=\s*$/m);
    expect(example).not.toMatch(/NEXT_PUBLIC_[A-Z_]*OPENAI/);
  });

  it("the SDK is imported only by its transport module (lazily loaded), never by the planner/analyzer/domain", () => {
    const importers = walk("src")
      .filter((p) => /from "openai"|from "openai\/|import\("openai"\)/.test(readFileSync(p, "utf8")))
      .map((p) => p.replace(/\\/g, "/"));
    expect(importers).toEqual(["src/continuity/providers/openai/sdk-transport.ts"]);
  });

  it("is redacted from log text, both by literal env value and by key shape", () => {
    const before = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = KEY;
    try {
      expect(redactText(`request failed key=${KEY} end`)).not.toContain(KEY);
    } finally {
      if (before === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = before;
    }
    // shape-based: even when the variable is not in the environment of the logging process
    const other = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    expect(redactText(`401 Incorrect API key provided: ${other}`)).not.toContain(other);
  });

  it("UI-facing analyzer states never include key material", () => {
    const blob = JSON.stringify(analyzerStatuses(env));
    expect(blob).not.toContain(KEY);
    expect(blob).toMatch(/"id":"openai"[^}]*"state":"configured"/);
    expect(JSON.stringify(readAnalysisConfig(env).paid)).not.toContain(KEY);
  });

  it("is absent from everything an analysis persists or sends onward (snapshot, outcome, requests)", async () => {
    const transport = new FakeOpenAITransport(openaiAnswerAll("pass"));
    const providers = createAnalysisProviders(env, { openaiTransport: transport });
    const openai = providers.get("openai")!;
    const input = makeInput({}, openai.plannerView());
    const b = input.plan.batches[0]!;
    const out = await openai.analyzeBatch({ batch: b, input, media: mediaFor(input), ctx: ctx() });
    const blob = JSON.stringify([input, out, transport.requests, openai.estimate(input, new Date())]);
    expect(blob).not.toContain(KEY);
    // frozen history holds ids/checksums/roles only: no URL and no inline image bytes
    expect(JSON.stringify([input, out])).not.toMatch(/https?:\/\/|data:image|base64,/i);
  });

  it("the worker role is unchanged: no new DB role or migration was introduced for OpenAI", () => {
    const migrations = readdirSync("supabase/migrations");
    expect(migrations.filter((m) => /openai/i.test(m))).toEqual([]);
    // the OpenAI phase ended at 0025; later migrations belong to other phases (2E: candidate sets, reviews)
    const sql = migrations.filter((m) => m.endsWith(".sql")).sort();
    expect(sql).toContain("0025_continuity_analysis_retry_state.sql");
    for (const m of sql.filter((x) => x > "0025")) {
      expect(readFileSync(`supabase/migrations/${m}`, "utf8")).not.toMatch(
        /creates+role|alters+role|openai/i,
      );
    }
  });
});

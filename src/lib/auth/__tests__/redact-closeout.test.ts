import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redactText } from "../redact";

/**
 * Phase 5B closeout: the secrets added by Phase 5B (provider keys of OpenAI Image / Story and Photoroom, the Story and
 * render worker logins and the render worker's Storage key) are masked by VALUE in logs and errors, even when a value
 * matches no secret pattern; and the render worker never borrows another worker's Storage key.
 */
const NAMES = [
  "PRISM_STUDIO_PROVIDER_OPENAI_IMAGE_API_KEY",
  "PRISM_STUDIO_PROVIDER_OPENAI_STORY_API_KEY",
  "PRISM_STUDIO_PROVIDER_PHOTOROOM_API_KEY",
  "PRISM_STUDIO_STORY_DB_PASSWORD",
  "PRISM_STUDIO_RENDER_DB_PASSWORD",
  "PRISM_STUDIO_RENDER_WORKER_SUPABASE_SECRET_KEY",
];
const ROOT = path.resolve(__dirname, "../../../..");

describe("5B closeout redaction and render-worker key boundary", () => {
  afterEach(() => {
    for (const n of NAMES) delete process.env[n];
  });

  it.each(NAMES)("%s is masked by value (web redactor)", (name) => {
    const value = `plainvalue${name.length}xyzzyQ7`; // matches no generic secret pattern
    process.env[name] = value;
    expect(redactText(`provider said: bad key ${value}`)).not.toContain(value);
  });

  it("the scripts' redactor lists the same names", () => {
    const safety = readFileSync(path.join(ROOT, "scripts/lib/safety.mjs"), "utf8");
    for (const n of [...NAMES, "PRISM_STUDIO_STORY_WORKER_DB_URL", "PRISM_STUDIO_RENDER_WORKER_DB_URL"])
      expect(safety).toContain(`"${n}"`);
  });

  it("the render worker gives its Storage sink ONLY its own key (never the generation worker's legacy key)", () => {
    const src = readFileSync(path.join(ROOT, "scripts/render-worker.mts"), "utf8");
    expect(src).not.toContain("PRISM_STUDIO_WORKER_SERVICE_KEY");
    expect(src).not.toMatch(/createOutputSink\(\s*\{\s*\.\.\.env/);
    expect(src).toContain(
      "PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY: env.PRISM_STUDIO_RENDER_WORKER_SUPABASE_SECRET_KEY",
    );
    expect(src).toContain("installRedactingHandlers()");
    expect(src).toContain("assertProjectRef");
    expect(src).toMatch(/current_user/);
  });
});

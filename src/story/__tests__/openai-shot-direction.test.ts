import { describe, expect, it } from "vitest";
import { FakeOpenAITransport } from "@/continuity/providers/openai/fake-transport";
import { OpenAITransportError } from "@/continuity/providers/openai/transport";
import { buildSeedProject } from "@/data/seed";
import {
  SHOT_DIRECTION_JSON_SCHEMA,
  shotSnapshot,
  validateShotDirection,
} from "@/domain/story/shot-direction";
import { fakeDirection } from "../providers/fake-director";
import { OPENAI_STORY_SECRET_ENV, OpenAIStoryProvider } from "../providers/openai";
import { SHOT_DIRECTOR_INSTRUCTIONS } from "../shot-director-prompt";

/** Phase 5B-S5: the OpenAI `directShot` operation on the FAKE transport. Zero network calls. */
const data = buildSeedProject();
const snap = shotSnapshot(data, data.shots.find((s) => s.shotCode === "3A")!.id)!;
const GOOD = fakeDirection(snap.context, "");

function run(
  script: ConstructorParameters<typeof FakeOpenAITransport>[0],
  env: Record<string, string> = { [OPENAI_STORY_SECRET_ENV]: "sk-test-placeholder" },
) {
  const transport = new FakeOpenAITransport(script);
  const provider = new OpenAIStoryProvider({ env, transport: () => transport });
  return {
    transport,
    result: provider.directShot({
      model: provider.models()[0]!,
      context: snap.context,
      instruction: "make Yumeko feel isolated",
      maxOutputTokens: 2500,
      validate: (raw) => validateShotDirection(raw, snap.context),
    }),
  };
}

describe("OpenAI storyboard direction (fake transport)", () => {
  it("one call: static director/DP instructions, the strict direction schema, textual context + the creator's note", async () => {
    const r = run([{ kind: "json", body: GOOD, usage: { inputTokens: 2200, outputTokens: 1100 } }]);
    expect(await r.result).toMatchObject({
      ok: true,
      providerCalls: 1,
      direction: { storyboardDescription: GOOD.storyboardDescription },
    });
    const req = r.transport.raw[0]!;
    expect(req.instructions).toBe(SHOT_DIRECTOR_INSTRUCTIONS);
    expect(req.instructions).toMatch(/HARD spatial constraint/);
    expect(req.jsonSchema).toBe(SHOT_DIRECTION_JSON_SCHEMA);
    expect(req.schemaName).toBe("shot_direction");
    expect(req.maxOutputTokens).toBe(2500);
    const input = r.transport.requests[0]!.textParts.join("\n");
    expect(input).toContain("<<<CREATOR NOTE>>>\nmake Yumeko feel isolated");
    expect(input).toContain('"look": "Episode 1 — Formal Black"');
  });

  it("malformed output: one correction turn then a clean failure; timeouts never re-sent; no key, no call", async () => {
    const broken = run([
      { kind: "text", text: "{oops" },
      { kind: "json", body: { ...GOOD, blocking: [] } },
    ]);
    expect(await broken.result).toMatchObject({ ok: false, code: "invalid_output", providerCalls: 2 });
    expect(broken.transport.requests[1]!.textParts.join(" ")).toContain("not valid storyboard direction");
    const timeout = run([{ kind: "error", error: new OpenAITransportError("timeout", null, "timed out") }]);
    expect(await timeout.result).toMatchObject({
      ok: false,
      code: "ambiguous",
      retryable: false,
      providerCalls: 1,
    });
    const none = run([{ kind: "json", body: GOOD }], {});
    expect(await none.result).toMatchObject({ ok: false, code: "not_configured", providerCalls: 0 });
    expect(none.transport.calls).toBe(0);
  });
});

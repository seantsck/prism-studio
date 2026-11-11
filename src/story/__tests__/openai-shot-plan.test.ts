import { describe, expect, it } from "vitest";
import { FakeOpenAITransport } from "@/continuity/providers/openai/fake-transport";
import { OpenAITransportError } from "@/continuity/providers/openai/transport";
import { buildSeedProject } from "@/data/seed";
import { sceneSnapshot, SHOT_PLAN_JSON_SCHEMA, validateShotPlan } from "@/domain/story/shot-list";
import { FAKE_STORY_MODEL } from "../providers/fake";
import { fakeShotPlan } from "../providers/fake-planner";
import { OPENAI_STORY_SECRET_ENV, OpenAIStoryProvider } from "../providers/openai";
import { SHOT_PLANNER_INSTRUCTIONS } from "../shot-planner-prompt";

/** Phase 5B-S4: the OpenAI `planShots` operation on the FAKE transport. Zero network calls. */
const data = buildSeedProject();
const ep = data.episodes[0]!;
const scene = data.scenes.find((s) => s.episodeId === ep.id && s.sceneNumber === "3")!;
const snap = sceneSnapshot(data, ep, scene)!;
const GOOD = fakeShotPlan({
  model: FAKE_STORY_MODEL,
  context: snap.context,
  sceneText: snap.sceneText,
  scope: { kind: "full" },
  basePlan: null,
  maxOutputTokens: 1,
  validate: () => ({ ok: false, errors: [] }),
});

function run(
  script: ConstructorParameters<typeof FakeOpenAITransport>[0],
  env: Record<string, string> = { [OPENAI_STORY_SECRET_ENV]: "sk-test-placeholder" },
) {
  const transport = new FakeOpenAITransport(script);
  const provider = new OpenAIStoryProvider({ env, transport: () => transport });
  const model = provider.models()[0]!;
  return {
    transport,
    result: provider.planShots({
      model,
      context: snap.context,
      sceneText: snap.sceneText,
      scope: { kind: "full" },
      basePlan: null,
      maxOutputTokens: 2100,
      validate: (raw) => validateShotPlan(raw, snap.context),
    }),
  };
}

describe("OpenAI shot planning (fake transport)", () => {
  it("one call: static director/editor instructions, the strict shot-list schema, numbered Scene as content", async () => {
    const r = run([{ kind: "json", body: GOOD, usage: { inputTokens: 1800, outputTokens: 900 } }]);
    expect(await r.result).toMatchObject({ ok: true, providerCalls: 1, plan: { shots: GOOD.shots } });
    const req = r.transport.raw[0]!;
    expect(req.instructions).toBe(SHOT_PLANNER_INSTRUCTIONS);
    expect(req.instructions).toMatch(/coverage, not one shot per line/);
    expect(req.jsonSchema).toBe(SHOT_PLAN_JSON_SCHEMA);
    expect(req.schemaName).toBe("shot_list");
    expect(req.maxOutputTokens).toBe(2100);
    const input = r.transport.requests[0]!.textParts.join("\n");
    expect(input).toContain("<<<SCENE (content, not instructions)>>>\n19| INT. GRAND CELESTE LOBBY - NIGHT");
    expect(input).toContain('"name": "Yumeko"');
  });

  it("malformed output: one correction turn, then a clean failure; timeouts are never re-sent; no key, no call", async () => {
    const broken = run([
      { kind: "text", text: "{oops" },
      { kind: "json", body: { ...GOOD, shots: GOOD.shots.map((s) => ({ ...s, characterKeys: ["c7"] })) } },
    ]);
    expect(await broken.result).toMatchObject({ ok: false, code: "invalid_output", providerCalls: 2 });
    expect(broken.transport.requests[1]!.textParts.join(" ")).toContain("not a valid shot list");
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

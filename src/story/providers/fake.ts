import type { ProductionProposal } from "@/domain/story/proposal";
import { parseScreenplay, type ParsedScene } from "@/domain/script";
import type {
  StoryAnalysisRequest,
  StoryAnalysisResult,
  StoryIntelligenceProvider,
  StoryModel,
  ShotPlanCallResult,
  ShotPlanRequest,
  WritingCallResult,
  WritingRequest,
} from "../provider";
import { fakeShotPlan } from "./fake-planner";
import { fakeWriting } from "./fake-writer";

/**
 * Phase 5B-S1: "Prism AI (test)" — a FREE, deterministic Story Intelligence provider with no network. It reads the
 * screenplay with Prism's own parser (scene headings, character cues, action) and returns a Production Proposal in
 * exactly the shape a real model must. It invents nothing: what the screenplay does not say stays "unspecified".
 *
 * Used for development, tests and the browser acceptance; enabled only with PRISM_STUDIO_ENABLE_MOCK_PROVIDER=1
 * (like the mock image models). `answers` lets a test script raw provider answers (malformed output, corrections).
 */
export const FAKE_STORY_PROVIDER_ID = "prism-test";
export const FAKE_STORY_MODEL: StoryModel = {
  provider: FAKE_STORY_PROVIDER_ID,
  modelId: "screenplay-parser-v1",
  label: "Prism AI (test, free)",
  paid: false,
  pricing: null,
  maxOutputTokens: 0,
  contextTokens: 10_000_000,
};

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/(^|[\s\-/'’(])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase())
    .trim();
const cleanCue = (cue: string) => cue.replace(/\((v\.?o\.?|o\.?s\.?|o\.?c\.?|cont'?d)\)/gi, "").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Deterministic proposal straight from the screenplay structure. */
export function proposalFromScreenplay(text: string, title: string | null): ProductionProposal {
  const scenes: ParsedScene[] = parseScreenplay(text);
  const charKey = new Map<string, string>();
  const charSources = new Map<string, Array<{ startLine: number; endLine: number }>>();
  const charLines = new Map<string, number>();
  const locKey = new Map<string, string>();
  const locScenes = new Map<string, ParsedScene[]>();
  for (const s of scenes) {
    const ln = titleCase(s.location || "Unspecified location");
    if (!locKey.has(ln)) locKey.set(ln, `l${locKey.size + 1}`);
    locScenes.set(ln, [...(locScenes.get(ln) ?? []), s]);
    for (const b of s.blocks)
      if (b.kind === "dialogue") {
        const name = titleCase(cleanCue(b.speaker));
        if (!name) continue;
        if (!charKey.has(name)) charKey.set(name, `c${charKey.size + 1}`);
        const list = charSources.get(name) ?? [];
        if (list.length < 40) list.push({ startLine: b.line, endLine: b.endLine });
        charSources.set(name, list);
        charLines.set(name, (charLines.get(name) ?? 0) + 1);
      }
  }
  const languages = [
    ...(/[A-Za-z]{3,}/.test(text) ? ["English"] : []),
    ...(/[぀-ヿ一-龯]/.test(text) ? ["Japanese"] : []),
  ];
  const sceneKey = (i: number) => `s${i + 1}`;
  const shots: ProductionProposal["shots"] = [];
  const sceneItems = scenes.map((s, i) => {
    const speakers = [
      ...new Set(
        s.blocks
          .flatMap((b) => (b.kind === "dialogue" ? [titleCase(cleanCue(b.speaker))] : []))
          .filter(Boolean),
      ),
    ];
    const actions = s.blocks.filter((b) => b.kind === "action");
    const loc = titleCase(s.location || "Unspecified location");
    // a minimal first pass: one establishing shot, then one per speaking Character
    shots.push({
      key: `sh${shots.length + 1}`,
      sceneKey: sceneKey(i),
      order: shots.length + 1,
      purpose: clip(`Establish ${loc}`, 200),
      characterKeys: [],
      locationKey: locKey.get(loc)!,
      visualIntent: actions[0] ? clip(actions[0].text, 400) : "unspecified",
      sources: [{ startLine: s.startLine, endLine: actions[0]?.endLine ?? s.startLine }],
    });
    for (const name of speakers) {
      const first = s.blocks.find((b) => b.kind === "dialogue" && titleCase(cleanCue(b.speaker)) === name);
      shots.push({
        key: `sh${shots.length + 1}`,
        sceneKey: sceneKey(i),
        order: shots.length + 1,
        purpose: clip(`${name} speaks`, 200),
        characterKeys: [charKey.get(name)!],
        locationKey: locKey.get(loc)!,
        visualIntent: "unspecified",
        sources: first ? [{ startLine: first.line, endLine: first.endLine }] : [],
      });
    }
    return {
      key: sceneKey(i),
      order: i + 1,
      heading: clip(s.slugline, 200),
      locationKey: locKey.get(loc)!,
      timeOfDay: s.timeOfDay ? titleCase(s.timeOfDay) : "unspecified",
      summary: actions.length ? clip(actions.map((a) => a.text).join(" "), 600) : "unspecified",
      purpose: "unspecified",
      characterKeys: speakers.map((n) => charKey.get(n)!),
      beats: actions
        .slice(0, 5)
        .map((a) => ({ kind: "key_action" as const, description: clip(a.text, 200) })),
      sources: [{ startLine: s.startLine, endLine: s.endLine }],
      confidence: "high" as const,
      ambiguity: null,
    };
  });
  return {
    story: {
      title: clip(title?.trim() || "Untitled", 200),
      logline: "unspecified",
      synopsis: "unspecified",
      tone: "unspecified",
      genre: null,
      languages,
      notes:
        "Proposed by the free screenplay-structure analyser: names, places and scenes only; nothing inferred.",
    },
    characters: [...charKey].map(([name, key]) => ({
      key,
      name: clip(name, 200),
      role: "unspecified",
      description: "unknown",
      ageRange: null,
      personality: "unknown",
      relationships: [],
      lookSuggestions: [],
      visualNotes: "unknown",
      sources: charSources.get(name) ?? [],
      confidence: (charLines.get(name) ?? 0) > 1 ? ("high" as const) : ("medium" as const),
      ambiguity: null,
    })),
    locations: [...locKey].map(([name, key]) => {
      const ss = locScenes.get(name) ?? [];
      const times = [...new Set(ss.map((s) => s.timeOfDay).filter(Boolean))];
      return {
        key,
        name: clip(name, 200),
        description: "unknown",
        intExt: ss[0]?.intExt ?? ("unknown" as const),
        timeStateNotes: times.length ? clip(times.map(titleCase).join(", "), 200) : "unspecified",
        recurringSet: ss.length > 1,
        sources: ss.slice(0, 40).map((s) => ({ startLine: s.startLine, endLine: s.startLine })),
        confidence: "high" as const,
        ambiguity: null,
      };
    }),
    scenes: sceneItems,
    shots,
  };
}

export class FakeStoryProvider implements StoryIntelligenceProvider {
  readonly id = FAKE_STORY_PROVIDER_ID;
  /** Every request the provider received (tests assert counts). */
  readonly calls: Array<{ modelId: string; textLength: number; revise: string | null }> = [];
  /** Every writing request, in full (tests assert the frozen context and the isolation of script text). */
  readonly writeCalls: WritingRequest[] = [];
  /** Every Shot planning request, in full. */
  readonly planCalls: ShotPlanRequest[] = [];

  constructor(
    private readonly opts: {
      enabled?: boolean;
      /** Scripted raw answers, consumed one per call (a test of malformed output / correction). */
      answers?: unknown[];
      /** Scripted raw WRITING answers, consumed one per call. */
      writeAnswers?: unknown[];
      /** Scripted raw SHOT PLAN answers, consumed one per call. */
      planAnswers?: unknown[];
    } = {},
  ) {}

  models() {
    return [FAKE_STORY_MODEL];
  }

  unavailable() {
    return this.opts.enabled === false ? "The free test analyser is not enabled on this server." : null;
  }

  async planShots(req: ShotPlanRequest): Promise<ShotPlanCallResult> {
    let calls = 0;
    const answer = (): unknown => {
      calls++;
      this.planCalls.push(req);
      if (this.opts.planAnswers && this.opts.planAnswers.length) return this.opts.planAnswers.shift();
      return fakeShotPlan(req);
    };
    let v = req.validate(answer());
    if (!v.ok) v = req.validate(answer()); // one correction turn, like a real provider
    const usage = { inputTokens: 0, outputTokens: 0 };
    return v.ok
      ? { ok: true, plan: v.plan, usage, providerCalls: calls }
      : {
          ok: false,
          code: "invalid_output",
          message: `The shot list did not match the expected shape: ${v.errors.slice(0, 3).join("; ")}`,
          usage,
          providerCalls: calls,
          retryable: false,
        };
  }

  async write(req: WritingRequest): Promise<WritingCallResult> {
    let calls = 0;
    const answer = (): unknown => {
      calls++;
      this.writeCalls.push(req);
      if (this.opts.writeAnswers && this.opts.writeAnswers.length) return this.opts.writeAnswers.shift();
      return fakeWriting(req);
    };
    let v = req.validate(answer());
    if (!v.ok) v = req.validate(answer()); // one correction turn, like a real provider
    const usage = { inputTokens: 0, outputTokens: 0 };
    return v.ok
      ? { ok: true, result: v.result, usage, providerCalls: calls }
      : {
          ok: false,
          code: "invalid_output",
          message: `The writing did not match the expected shape: ${v.errors.slice(0, 3).join("; ")}`,
          usage,
          providerCalls: calls,
          retryable: false,
        };
  }

  async analyze(req: StoryAnalysisRequest): Promise<StoryAnalysisResult> {
    let calls = 0;
    const answer = (): unknown => {
      calls++;
      this.calls.push({
        modelId: req.model.modelId,
        textLength: req.text.length,
        revise: req.revise?.section ?? null,
      });
      if (this.opts.answers && this.opts.answers.length) return this.opts.answers.shift();
      const fresh = proposalFromScreenplay(req.text, req.title);
      if (!req.revise) return fresh;
      // a revision changes only its section
      return { ...req.revise.previous, [req.revise.section]: fresh[req.revise.section] };
    };
    let v = req.validate(answer());
    // one correction turn, exactly like a real provider
    if (!v.ok) v = req.validate(answer());
    const usage = { inputTokens: 0, outputTokens: 0 };
    return v.ok
      ? { ok: true, proposal: v.proposal, usage, providerCalls: calls }
      : {
          ok: false,
          code: "invalid_output",
          message: `The analysis did not match the Production Proposal schema: ${v.errors.slice(0, 3).join("; ")}`,
          usage,
          providerCalls: calls,
          retryable: false,
        };
  }
}

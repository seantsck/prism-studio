import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { projectAreas } from "@/domain/production-checklist";
import {
  PREMISE_MAX,
  seasonPlanInstruction,
  titleFromPremise,
  wholeScriptInstruction,
} from "@/domain/series-start";
import { LIMITS, longFormPlan } from "@/domain/story/writing";
import { FakeStoryProvider } from "@/story/providers/fake";
import { createStoryRegistry } from "@/story/registry";
import { StoryWorker } from "@/story/worker";

/**
 * Starting a series (or a film) from a prompt, through the REAL actions, memory repository and Story worker with the
 * FREE test writer: the premise makes the project and its empty Episodes; the season plan, writing one or every
 * Episode (in parts) and Import Story each send exactly what the actions accept, at the price shown (free, or the
 * confirmed paid estimate), and every result is a proposal to review.
 */
vi.hoisted(() => {
  process.env.PRISM_STUDIO_INLINE_WORKER = "0";
  process.env.PRISM_STUDIO_ENABLE_MOCK_PROVIDER = "1";
  process.env.PRISM_STUDIO_STORY_AI_PROVIDERS = "openai";
  // a test server: the free test writer may be offered (a real deployment never offers it; tested below)
  process.env.PRISM_STUDIO_SHOW_TEST_MODELS = "1";
  delete process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI;
});
const world = vi.hoisted(() => ({
  repo: null as unknown,
  files: new Map<string, Uint8Array>(),
  redirects: [] as string[],
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => void world.redirects.push(to)),
  notFound: vi.fn(),
}));
vi.mock("@/server/auth", () => ({ requireUser: async () => ({ kind: "memory", id: "tester" }) }));
vi.mock("@/server/repo", async () => {
  const { UserFacingError } = await import("@/server/action-result");
  return {
    getRepo: async () => world.repo,
    requireProjectFresh: async (slug: string) => {
      const data = await (world.repo as MemoryRepository).loadProject(slug);
      if (!data) throw new UserFacingError("That project no longer exists.");
      return data;
    },
  };
});
vi.mock("@/server/storage", () => {
  const store = {
    name: "local" as const,
    bucket: null,
    put: async (p: string, b: Uint8Array) => void world.files.set(p, new Uint8Array(b)),
    get: async (p: string) => world.files.get(p) ?? null,
  };
  return {
    getUploadStorage: async () => store,
    storageForAsset: async () => store,
    checksum: (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
  };
});

import { createProject, startFromPremise } from "../actions";
import { applySeasonPlan, planSeason, saveSeasonPlan, writeWhole } from "../series-actions";
import {
  quoteAnalyzeEpisode,
  quoteSeasonPlan,
  quoteWhole,
  quoteWriting,
  recommendedWriter,
  writers,
  WRITING_AI_OFF,
} from "../series-start";
import { analyzeStory } from "../story-actions";

const PREMISE =
  "In Tokyo, a reluctant heiress is told she must marry a stranger to save her family's firm. She has one month to find a way out.";

let repo: MemoryRepository;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  repo = new MemoryRepository();
  world.repo = repo;
  world.redirects = [];
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  delete process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI;
  process.env.PRISM_STUDIO_ENABLE_MOCK_PROVIDER = "1";
  process.env.PRISM_STUDIO_SHOW_TEST_MODELS = "1";
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

async function newSeries(title = "The Arrangement", premise = PREMISE) {
  expect(await createProject(form({ title, premise, defaultLanguage: "ja" }))).toMatchObject({ ok: true });
  const slug = world.redirects.at(-1)!.split("/")[2]!;
  return { slug, data: (await repo.loadProject(slug))! };
}

/** The worker with the free test writer (no network). */
const work = () =>
  new StoryWorker({
    store: repo.story,
    writing: repo.writing,
    registry: createStoryRegistry({ PRISM_STUDIO_STORY_AI_PROVIDERS: "" }, [new FakeStoryProvider()]),
    workerId: "test-worker",
  }).tick(20);

async function proposalsOf(slug: string) {
  const data = (await repo.loadProject(slug))!;
  const out = [];
  for (const e of data.episodes)
    for (const s of await repo.writing.listSessions(data.project.id, e.id))
      out.push(
        ...(await repo.writing.listProposals(data.project.id, s.id)).map((p) => ({ ...p, episode: e })),
      );
  return out;
}

describe("starting a series from a prompt", () => {
  it("a series gets the planned number of empty Episodes; a film one screenplay; no premise, none", async () => {
    const { slug, data } = await newSeries();
    expect(world.redirects.at(-1)).toBe(`/projects/${slug}/start`);
    expect(data.bible.premise).toBe(PREMISE);
    expect(data.episodes).toHaveLength(8); // the default
    expect(data.episodes.map((e) => e.slug)).toEqual([
      "ep-1",
      "ep-2",
      "ep-3",
      "ep-4",
      "ep-5",
      "ep-6",
      "ep-7",
      "ep-8",
    ]);
    expect(data.episodes.every((e) => e.scriptText === "")).toBe(true);
    expect(projectAreas(data)[0]!.next).toMatchObject({ href: `/projects/${slug}/start` });

    await createProject(form({ title: "Six", premise: PREMISE, episodeCount: "6" }));
    expect((await repo.loadProject("six"))!.episodes).toHaveLength(6);
    await createProject(form({ title: "Odd", premise: PREMISE, episodeCount: "7" }));
    expect((await repo.loadProject("odd"))!.episodes).toHaveLength(7); // any number from 1 to 50
    await createProject(form({ title: "Feature", premise: PREMISE, projectType: "film" }));
    expect((await repo.loadProject("feature"))!.episodes.map((e) => e.title)).toEqual(["Screenplay"]);
    expect(await createProject(form({ title: "Blank" }))).toMatchObject({ ok: true });
    expect(world.redirects.at(-1)).toBe("/projects/blank");
    expect((await repo.loadProject("blank"))!.episodes).toHaveLength(0);
  });

  it("an existing project can be started from a premise once; a written premise is never overwritten", async () => {
    await createProject(form({ title: "Later" }));
    expect(await startFromPremise(form({ projectSlug: "later", premise: "  " }))).toMatchObject({
      ok: false,
    });
    expect(await startFromPremise(form({ projectSlug: "later", premise: PREMISE }))).toMatchObject({
      ok: true,
    });
    expect(world.redirects.at(-1)).toBe("/projects/later/start");
    const data = (await repo.loadProject("later"))!;
    expect(data.bible.premise).toBe(PREMISE);
    expect(data.episodes.map((e) => e.slug)).toEqual(["ep-1"]);
    expect(await startFromPremise(form({ projectSlug: "later", premise: "something else" }))).toMatchObject({
      ok: false,
      error: "This project already has a premise. Edit it on the Bible page.",
    });
  });

  it("an idea names the series when no title is given (first sentence, or its first six words)", async () => {
    expect(titleFromPremise("Two rival ramen shops go to war. Then love.")).toBe(
      "Two rival ramen shops go to war",
    );
    expect(
      titleFromPremise("A night-shift paramedic keeps getting calls from a number disconnected years ago."),
    ).toBe("A night-shift paramedic keeps getting calls…");
    expect(titleFromPremise("東京の小さなラーメン屋が二つ、跡継ぎ同士の恋で戦争になる。")).toBe(
      "東京の小さなラーメン屋が二つ、跡継ぎ同士の恋で戦争になる",
    );
    expect(await createProject(form({ premise: " ", title: " " }))).toMatchObject({
      ok: false,
      error: "Describe your series, or give it a title.",
    });
  });

  it("the instructions carry the premise, the episode and the language, and always fit the limit", async () => {
    const { data } = await newSeries();
    const plan = seasonPlanInstruction(data, 8);
    expect(plan).toContain("exactly 8 ideas");
    expect(plan).toContain(PREMISE);
    const whole = wholeScriptInstruction(data, {
      ...data.episodes[2]!,
      title: "The Dinner",
      synopsis: "They meet.",
    });
    expect(whole).toContain('episode 3, "The Dinner"');
    expect(whole).toContain("They meet.");
    expect(whole).toContain("(ja)");
    const long = { ...data, bible: { ...data.bible, premise: "x".repeat(PREMISE_MAX * 3) } };
    expect(seasonPlanInstruction(long, 12).length).toBeLessThanOrEqual(LIMITS.instruction);
    expect(wholeScriptInstruction(long, data.episodes[0]!).length).toBeLessThanOrEqual(LIMITS.instruction);
  });

  it("a real deployment never offers the test writer: with none on it says so; a real one is used when on", async () => {
    delete process.env.PRISM_STUDIO_SHOW_TEST_MODELS;
    const { data } = await newSeries();
    expect(writers().some((w) => w.value.startsWith("prism-test/"))).toBe(false);
    expect(recommendedWriter()).toBeNull();
    expect(quoteSeasonPlan(data)).toEqual({ ok: false, reason: WRITING_AI_OFF });
    expect(quoteWriting(data, "all")).toEqual({ ok: false, reason: WRITING_AI_OFF });
    process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI = "true";
    expect(recommendedWriter()).toMatchObject({ paid: true, value: expect.stringMatching(/^openai\//) });
    expect(quoteWriting(data, "one")).toMatchObject({ ok: true, paid: true });
  });

  it("free: plan the season, use the plan, write every episode; each arrives as its own proposal to review", async () => {
    const { slug } = await newSeries("Night Counter", PREMISE);
    let data = (await repo.loadProject(slug))!;
    const plan = quoteSeasonPlan(data);
    expect(plan).toMatchObject({ ok: true, paid: false, usd: 0 });
    const asked = await planSeason(form({ projectSlug: slug, model: (plan as { model: string }).model }));
    expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true });
    await work();
    const [planned] = (await proposalsOf(slug)).filter((p) => p.mode === "brainstorm");
    expect(planned).toMatchObject({ status: "ready" });
    expect(planned!.result!.ideas).toHaveLength(8);
    expect(await applySeasonPlan(form({ projectSlug: slug, proposalId: planned!.id }))).toMatchObject({
      ok: true,
    });
    data = (await repo.loadProject(slug))!;
    expect(data.episodes.every((e) => e.synopsis.trim() && !/^Episode \d+$/.test(e.title))).toBe(true);
    expect(data.episodes.every((e) => e.scriptText === "")).toBe(true); // a plan writes no script

    // write all 8: one request each, written in parts, each a proposal (nothing in any script yet)
    const all = quoteWriting(data, "all");
    expect(all).toMatchObject({ ok: true, paid: false, usd: 0 });
    expect(
      await writeWhole(form({ projectSlug: slug, scope: "all", model: (all as { model: string }).model })),
    ).toEqual({ ok: true });
    expect(world.redirects.at(-1)).toBe(`/projects/${slug}/start`);
    let whole = (await proposalsOf(slug)).filter((p) => p.context.longForm);
    expect(whole).toHaveLength(8);
    expect(
      whole.every((p) => p.status === "queued" && p.mode === "continue" && p.spendAuthorization === "free"),
    ).toBe(true);
    expect(whole[0]!.context.seasonPlan).toHaveLength(8);
    await work();
    whole = (await proposalsOf(slug)).filter((p) => p.context.longForm);
    const plan2 = longFormPlan("series", 32_000);
    for (const p of whole) {
      expect(p.status).toBe("ready");
      expect(p.providerCalls).toBe(plan2.parts); // every part, one answer
      expect(p.result!.alternatives).toHaveLength(1);
      expect(p.result!.alternatives[0]!.text.trim()).not.toBe("");
    }
    expect((await repo.loadProject(slug))!.episodes.every((e) => e.scriptText === "")).toBe(true);
    // nothing left to write once every Episode has a script is a separate state; here nothing was accepted yet
    expect(quoteWriting((await repo.loadProject(slug))!, "all")).toMatchObject({ ok: true });
  });

  it("a film is written whole (one request, in parts)", async () => {
    await createProject(form({ title: "Feature", premise: PREMISE, projectType: "film" }));
    const data = (await repo.loadProject("feature"))!;
    const q = quoteWriting(data, "all");
    expect(q).toMatchObject({ ok: true, episodes: [{ number: 1, title: "Screenplay" }] });
    expect(await writeWhole(form({ projectSlug: "feature", scope: "all" }))).toEqual({ ok: true });
    await work();
    const [p] = (await proposalsOf("feature")).filter((x) => x.context.longForm);
    expect(p).toMatchObject({ status: "ready", providerCalls: longFormPlan("film", 32_000).parts });
    expect(p!.context.longForm).toEqual(longFormPlan("film", 32_000));
  });

  it("paid: every price shown is the price each request is accepted at; less than shown is refused", async () => {
    const { slug } = await newSeries();
    process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI = "true";
    delete process.env.PRISM_STUDIO_ENABLE_MOCK_PROVIDER; // only the real (paid) writer is left
    let data = (await repo.loadProject(slug))!;
    const plan = quoteSeasonPlan(data);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.paid).toBe(true);
    expect(await planSeason(form({ projectSlug: slug, model: plan.model }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("Confirm that amount"),
    });
    expect(
      await planSeason(
        form({ projectSlug: slug, model: plan.model, confirmedTotalUsd: plan.usd.toFixed(4) }),
      ),
    ).toMatchObject({ ok: true });
    const [queuedPlan] = await proposalsOf(slug);
    expect(queuedPlan).toMatchObject({
      mode: "brainstorm",
      spendAuthorization: "confirmed",
      alternativesRequested: 8,
    });
    expect(queuedPlan!.estimate.usd).toBe(plan.usd);

    // write all: the total is the sum of each episode's own price, and each request is confirmed at its own price
    data = (await repo.loadProject(slug))!;
    const all = quoteWriting(data, "all", plan.model);
    if (!all.ok) throw new Error(all.reason);
    expect(all.episodes).toHaveLength(8);
    expect(all.usd).toBeCloseTo(
      all.episodes.reduce((s, e) => s + e.usd, 0),
      6,
    );
    expect(
      await writeWhole(
        form({
          projectSlug: slug,
          scope: "all",
          model: all.model,
          confirmedTotalUsd: (all.usd - 0.0001).toFixed(4),
        }),
      ),
    ).toMatchObject({ ok: false });
    expect((await proposalsOf(slug)).filter((p) => p.context.longForm)).toHaveLength(0);
    expect(
      await writeWhole(
        form({ projectSlug: slug, scope: "all", model: all.model, confirmedTotalUsd: all.usd.toFixed(4) }),
      ),
    ).toEqual({ ok: true });
    const whole = (await proposalsOf(slug)).filter((p) => p.context.longForm);
    expect(whole).toHaveLength(8);
    for (const p of whole) {
      const own = quoteWhole(data, p.episode, all.model);
      if (!own.ok) throw new Error(own.reason);
      expect(p).toMatchObject({ spendAuthorization: "confirmed", confirmedUsd: own.usd });
      expect(p.estimate.usd).toBe(own.usd);
      expect(p.estimate.usd).toBeLessThanOrEqual(0.25 + 1e-9); // within the per-request limit
    }
    // Analyze is offered once Episode 1 has a script, priced the same way Import Story prices it
    const ep = data.episodes[0]!;
    await repo.upsert(data.project.id, "episodes", {
      ...ep,
      scriptText: "INT. TEA HOUSE - NIGHT\n\nYUMEKO\nOne month.\n",
    });
    const a = quoteAnalyzeEpisode((await repo.loadProject(slug))!.episodes[0]!);
    if (!a.ok) throw new Error(a.reason);
    expect(
      await analyzeStory(
        form({
          projectSlug: slug,
          sourceMode: "episode",
          episodeId: ep.id,
          model: a.model,
          confirmedTotalUsd: a.usd.toFixed(4),
        }),
      ),
    ).toMatchObject({ ok: true });
  });

  it("any episode count from 1 to 50 can be typed; anything else falls back to 8", async () => {
    for (const [typed, want] of [
      ["24", 24],
      ["1", 1],
      ["50", 50],
      ["0", 8],
      ["51", 8],
      ["2.5", 8],
      ["abc", 8],
    ] as const) {
      const title = `Count ${typed}`;
      expect(await createProject(form({ title, premise: PREMISE, episodeCount: typed }))).toMatchObject({
        ok: true,
      });
      const slug = world.redirects.at(-1)!.split("/")[2]!;
      expect((await repo.loadProject(slug))!.episodes, typed).toHaveLength(want);
    }
  });

  it("a 24-episode season is planned in one request (past the 10 the database records), then edited and refined", async () => {
    await createProject(form({ title: "Long Season", premise: PREMISE, episodeCount: "24" }));
    const slug = "long-season";
    expect(await planSeason(form({ projectSlug: slug }))).toMatchObject({ ok: true });
    let [plan] = (await proposalsOf(slug)).filter((p) => p.mode === "brainstorm");
    expect(plan).toMatchObject({ status: "queued", alternativesRequested: 10 });
    expect(plan!.context.ideaCount).toBe(24);
    await work();
    [plan] = (await proposalsOf(slug)).filter((p) => p.mode === "brainstorm");
    expect(plan).toMatchObject({ status: "ready" });
    expect(plan!.result!.ideas).toHaveLength(24);
    expect(await applySeasonPlan(form({ projectSlug: slug, proposalId: plan!.id }))).toMatchObject({
      ok: true,
    });
    let data = (await repo.loadProject(slug))!;
    expect(data.episodes.every((e) => e.synopsis.trim())).toBe(true);

    // the creator's own edits: titles and synopses, scripts untouched
    const e3 = [...data.episodes].sort((a, b) => a.number - b.number)[2]!;
    expect(
      await saveSeasonPlan(
        form({
          projectSlug: slug,
          [`title_${e3.id}`]: "The Rival",
          [`synopsis_${e3.id}`]: "A rival chef arrives.",
        }),
      ),
    ).toMatchObject({ ok: true, message: "Plan saved." });
    data = (await repo.loadProject(slug))!;
    expect(data.episodes.find((e) => e.id === e3.id)).toMatchObject({
      title: "The Rival",
      synopsis: "A rival chef arrives.",
    });

    // refine: Prism gets the current plan and the note, and returns the whole revised plan to review
    expect(await planSeason(form({ projectSlug: slug, refine: "1", note: " " }))).toMatchObject({
      ok: false,
      error: "Tell Prism what to change in the plan.",
    });
    expect(
      await planSeason(form({ projectSlug: slug, refine: "1", note: "Make episode 3 darker." })),
    ).toMatchObject({ ok: true, message: "Prism is revising the plan…" });
    const refined = (await proposalsOf(slug))
      .filter((p) => p.mode === "brainstorm")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
    expect(refined.instruction).toContain("Creator's note: Make episode 3 darker.");
    expect(refined.context.seasonPlan).toHaveLength(24);
    expect(refined.context.seasonPlan!.find((p) => p.episode === 3)).toMatchObject({ title: "The Rival" });
    // nothing changes until the creator uses it
    await work();
    expect((await repo.loadProject(slug))!.episodes.find((e) => e.id === e3.id)!.title).toBe("The Rival");
    expect(await applySeasonPlan(form({ projectSlug: slug, proposalId: refined.id }))).toMatchObject({
      ok: true,
    });
    expect((await repo.loadProject(slug))!.episodes.find((e) => e.id === e3.id)!.title).not.toBe("The Rival");
  });

  it("paid: refining is priced as a ceiling for the longest note, and accepted within it", async () => {
    const { slug } = await newSeries();
    let data = (await repo.loadProject(slug))!;
    for (const e of data.episodes)
      await repo.upsert(data.project.id, "episodes", { ...e, synopsis: `Plan ${e.number}.` });
    process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI = "true";
    delete process.env.PRISM_STUDIO_ENABLE_MOCK_PROVIDER;
    data = (await repo.loadProject(slug))!;
    const q = quoteSeasonPlan(data, null, { refine: true });
    if (!q.ok) throw new Error(q.reason);
    const note = "東".repeat(600); // the longest note, in the densest script
    expect(
      await planSeason(
        form({ projectSlug: slug, refine: "1", note, model: q.model, confirmedTotalUsd: q.usd.toFixed(4) }),
      ),
    ).toMatchObject({ ok: true });
    const [p] = (await proposalsOf(slug)).filter((x) => x.mode === "brainstorm");
    expect(p).toMatchObject({ spendAuthorization: "confirmed" });
    expect(p!.estimate.usd).toBeLessThanOrEqual(q.usd);
  });
});

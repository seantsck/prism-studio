import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { projectAreas } from "@/domain/production-checklist";
import { episodeOneInstruction, PREMISE_MAX, titleFromPremise } from "@/domain/series-start";
import { LIMITS } from "@/domain/story/writing";
import { FakeStoryProvider } from "@/story/providers/fake";
import { createStoryRegistry } from "@/story/registry";
import { StoryWorker } from "@/story/worker";

/**
 * Starting a series from a prompt, through the REAL actions, memory repository and Story worker with the FREE test
 * writer: the premise makes the project and an empty Episode 1; the start page's two buttons send exactly what the
 * writing assistant and Import Story accept, at the price the button shows (free, or the confirmed paid estimate).
 */
vi.hoisted(() => {
  process.env.PRISM_STUDIO_INLINE_WORKER = "0";
  process.env.PRISM_STUDIO_ENABLE_MOCK_PROVIDER = "1";
  process.env.PRISM_STUDIO_STORY_AI_PROVIDERS = "openai";
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
import { quoteAnalyzeEpisode, quoteNewSeriesDraft, quoteWriteEpisode } from "../series-start";
import { analyzeStory } from "../story-actions";
import { askPrism } from "../writing-actions";

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

/** The fields the start page's "Write Episode 1" button sends. */
function writeFields(slug: string, data: Awaited<ReturnType<typeof newSeries>>["data"]) {
  const episode = data.episodes[0]!;
  const q = quoteWriteEpisode(data, episode, data.bible.premise);
  if (!q.ok) throw new Error(q.reason);
  return {
    q,
    fields: {
      projectSlug: slug,
      episodeId: episode.id,
      preset: "continue",
      scopeKind: "episode",
      instruction: episodeOneInstruction(data, data.bible.premise),
      model: q.model,
      ...(q.paid ? { confirmedTotalUsd: q.usd.toFixed(4) } : {}),
    },
  };
}

describe("starting a series from a prompt", () => {
  it("the premise makes the Bible's premise and an empty Episode 1, then opens the start page", async () => {
    const { slug, data } = await newSeries();
    expect(world.redirects.at(-1)).toBe(`/projects/${slug}/start`);
    expect(data.bible.premise).toBe(PREMISE);
    expect(data.episodes).toHaveLength(1);
    expect(data.episodes[0]).toMatchObject({ number: 1, slug: "ep-1", scriptText: "" });
    // Home's Story card points at the start page
    expect(projectAreas(data)[0]!.next).toEqual({
      label: "Write Episode 1 from your premise",
      href: `/projects/${slug}/start`,
    });
  });

  it("without a premise a project opens exactly as before (no Episode, the project's Home)", async () => {
    expect(await createProject(form({ title: "Blank" }))).toMatchObject({ ok: true });
    expect(world.redirects.at(-1)).toBe("/projects/blank");
    const data = (await repo.loadProject("blank"))!;
    expect(data.bible.premise).toBe("");
    expect(data.episodes).toHaveLength(0);
    expect(projectAreas(data)[0]!.next).toMatchObject({ href: "/projects/blank/start" });
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
    expect((await repo.loadProject("later"))!.bible.premise).toBe(PREMISE);
  });

  it("the instruction carries the premise and the language, and always fits the assistant's limit", async () => {
    const { data } = await newSeries();
    const text = episodeOneInstruction(data, PREMISE);
    expect(text).toContain(PREMISE);
    expect(text).toContain("(ja)");
    expect(episodeOneInstruction(data, "x".repeat(PREMISE_MAX * 3)).length).toBeLessThanOrEqual(
      LIMITS.instruction,
    );
  });

  it("Write Episode 1 (free): the writing assistant accepts exactly what the button sends and drafts a proposal", async () => {
    const { slug, data } = await newSeries();
    const { q, fields } = writeFields(slug, data);
    expect(q).toMatchObject({ paid: false, usd: 0 });
    expect(await askPrism(form(fields))).toMatchObject({ ok: true });
    expect(world.redirects.at(-1)).toMatch(new RegExp(`^/projects/${slug}/episodes/ep-1/write\\?session=`));
    const [session] = await repo.writing.listSessions(data.project.id, data.episodes[0]!.id);
    const [proposal] = await repo.writing.listProposals(data.project.id, session!.id);
    expect(proposal).toMatchObject({ mode: "continue", status: "queued", spendAuthorization: "free" });
    expect(proposal!.instruction).toContain(PREMISE);
    await new StoryWorker({
      store: repo.story,
      writing: repo.writing,
      registry: createStoryRegistry({ PRISM_STUDIO_STORY_AI_PROVIDERS: "" }, [new FakeStoryProvider()]),
      workerId: "test-worker",
    }).tick(5);
    expect((await repo.writing.getProposal(data.project.id, proposal!.id))!.status).toBe("ready");
  });

  it("paid: each button's amount is exactly the estimate the action computes and accepts", async () => {
    const { slug, data } = await newSeries();
    process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI = "true";
    delete process.env.PRISM_STUDIO_ENABLE_MOCK_PROVIDER; // only the paid models are left
    const { q, fields } = writeFields(slug, data);
    expect(q.paid).toBe(true);
    expect(q.usd).toBeGreaterThan(0);
    // a cent less than shown is refused; the shown amount is accepted and recorded as the confirmation
    expect(await askPrism(form({ ...fields, confirmedTotalUsd: (q.usd - 0.0001).toFixed(4) }))).toMatchObject(
      { ok: false },
    );
    expect(await askPrism(form(fields))).toMatchObject({ ok: true });
    const [session] = await repo.writing.listSessions(data.project.id, data.episodes[0]!.id);
    const proposal = (await repo.writing.listProposals(data.project.id, session!.id)).at(-1)!;
    expect(proposal).toMatchObject({
      spendAuthorization: "confirmed",
      confirmedUsd: Number(q.usd.toFixed(4)),
    });
    expect(proposal.estimate.usd).toBe(q.usd);

    // Episode 1 now has a script: Analyze is priced the same way Import Story prices it
    const ep = data.episodes[0]!;
    await repo.upsert(data.project.id, "episodes", {
      ...ep,
      scriptText: "INT. TEA HOUSE - NIGHT\n\nYUMEKO sits alone.\n\nYUMEKO\nOne month.\n",
    });
    const scripted = (await repo.loadProject(slug))!.episodes[0]!;
    const a = quoteAnalyzeEpisode(scripted);
    if (!a.ok) throw new Error(a.reason);
    expect(a.paid).toBe(true);
    const analyze = {
      projectSlug: slug,
      sourceMode: "episode",
      episodeId: ep.id,
      model: a.model,
      confirmedTotalUsd: a.usd.toFixed(4),
    };
    expect(
      await analyzeStory(form({ ...analyze, confirmedTotalUsd: (a.usd - 0.0001).toFixed(4) })),
    ).toMatchObject({ ok: false });
    expect(await analyzeStory(form(analyze))).toMatchObject({ ok: true });
    const [record] = await repo.story.list(data.project.id);
    expect(record).toMatchObject({ sourceEpisodeId: ep.id, status: "queued" });
    expect(record!.estimate.usd).toBe(a.usd);
  });

  it("Analyze is not offered before Episode 1 has a script", async () => {
    const { data } = await newSeries();
    expect(quoteAnalyzeEpisode(data.episodes[0]!)).toEqual({
      ok: false,
      reason: "Episode 1 has no script yet.",
    });
  });

  it("an idea names the series when no title is given (first sentence, or its first six words)", () => {
    expect(titleFromPremise("Two rival ramen shops go to war. Then love.")).toBe(
      "Two rival ramen shops go to war",
    );
    expect(
      titleFromPremise("A night-shift paramedic keeps getting calls from a number disconnected years ago."),
    ).toBe("A night-shift paramedic keeps getting calls…");
    expect(titleFromPremise("東京の小さなラーメン屋が二つ、跡継ぎ同士の恋で戦争になる。")).toBe(
      "東京の小さなラーメン屋が二つ、跡継ぎ同士の恋で戦争になる",
    );
    expect(titleFromPremise("  ")).toBe("");
  });

  it("creates from the idea alone (titled from it); refuses when there is neither an idea nor a title", async () => {
    expect(
      await createProject(form({ premise: "Two rival ramen shops go to war. Then love." })),
    ).toMatchObject({
      ok: true,
    });
    const data = (await repo.loadProject("two-rival-ramen-shops-go-to-war"))!;
    expect(data.project.title).toBe("Two rival ramen shops go to war");
    expect(world.redirects.at(-1)).toBe("/projects/two-rival-ramen-shops-go-to-war/start");
    expect(await createProject(form({ premise: " ", title: " " }))).toMatchObject({
      ok: false,
      error: "Describe your series, or give it a title.",
    });
  });

  it("Prism writes Episode 1 straight after creating (free): the draft is queued and it opens on the Write page", async () => {
    const q = quoteNewSeriesDraft();
    if (!q.ok) throw new Error(q.reason);
    expect(q.paid).toBe(false);
    expect(
      await createProject(
        form({ premise: PREMISE, defaultLanguage: "ja", draftEpisode: "1", model: q.model }),
      ),
    ).toMatchObject({ ok: true });
    expect(world.redirects.at(-1)).toMatch(/^\/projects\/in-tokyo[^/]*\/episodes\/ep-1\/write\?session=/);
    const slug = world.redirects.at(-1)!.split("/")[2]!;
    const data = (await repo.loadProject(slug))!;
    const [session] = await repo.writing.listSessions(data.project.id, data.episodes[0]!.id);
    const [proposal] = await repo.writing.listProposals(data.project.id, session!.id);
    expect(proposal).toMatchObject({ mode: "continue", status: "queued", spendAuthorization: "free" });
    expect(proposal!.instruction).toContain(PREMISE);
  });

  it("paid: the price shown before the project exists is a true ceiling, and the draft is accepted within it", async () => {
    process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI = "true";
    delete process.env.PRISM_STUDIO_ENABLE_MOCK_PROVIDER;
    const ceiling = quoteNewSeriesDraft();
    if (!ceiling.ok) throw new Error(ceiling.reason);
    expect(ceiling.paid).toBe(true);
    // the longest premise the form takes, in a dense script, with every other field full: still within the ceiling
    const longest = "東".repeat(PREMISE_MAX);
    expect(
      await createProject(
        form({
          premise: longest,
          title: "長".repeat(500),
          description: "説".repeat(5000),
          genre: "g".repeat(500),
          tone: "調".repeat(500),
          draftEpisode: "1",
          model: ceiling.model,
          confirmedTotalUsd: ceiling.usd.toFixed(4),
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(world.redirects.at(-1)).toMatch(/\/episodes\/ep-1\/write\?session=/);
    const slug = world.redirects.at(-1)!.split("/")[2]!;
    const data = (await repo.loadProject(slug))!;
    const real = quoteWriteEpisode(data, data.episodes[0]!, data.bible.premise);
    if (!real.ok) throw new Error(real.reason);
    expect(real.usd).toBeLessThanOrEqual(ceiling.usd);
    const [session] = await repo.writing.listSessions(data.project.id, data.episodes[0]!.id);
    const [proposal] = await repo.writing.listProposals(data.project.id, session!.id);
    expect(proposal).toMatchObject({ spendAuthorization: "confirmed", status: "queued" });
    expect(proposal!.estimate.usd).toBe(real.usd);
    // without the confirmation nothing is spent: the project is made and the start page opens instead
    expect(
      await createProject(form({ premise: "A quiet idea.", draftEpisode: "1", model: ceiling.model })),
    ).toMatchObject({ ok: true });
    expect(world.redirects.at(-1)).toBe("/projects/a-quiet-idea/start");
  });
});

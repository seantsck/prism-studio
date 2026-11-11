import { createHash, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { productionFrameInputs } from "@/domain/generation/production-frame-inputs";
import { buildSubjectImagePlan } from "@/domain/generation/subject-image";
import { locationBibleReadiness } from "@/domain/location-visual-bible";
import { itemId } from "@/domain/story/review";
import { lineCount, normalizeSourceText, sourceFingerprint } from "@/domain/story/source";
import { visualBibleReadiness } from "@/domain/visual-bible";
import { FakeStoryProvider } from "@/story/providers/fake";
import { createStoryRegistry } from "@/story/registry";
import { StoryWorker } from "@/story/worker";

/**
 * Phase 5B-S1 acceptance: Import Story → Production Proposal → review → Apply selected, through the REAL server actions,
 * memory repository and Story worker with the FREE test analyser (no network, no paid call). The Ojou-sama Episode 1
 * screenplay is the source fixture.
 */
vi.hoisted(() => {
  process.env.PRISM_STUDIO_INLINE_WORKER = "0";
  process.env.PRISM_STUDIO_ENABLE_MOCK_PROVIDER = "1";
  process.env.PRISM_STUDIO_STORY_AI_PROVIDERS = "openai";
});
const world = vi.hoisted(() => ({ repo: null as unknown, files: new Map<string, Uint8Array>() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));
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

import { analyzeStory, regenerateProposal, submitProposalReview } from "../story-actions";
import { reviewOf } from "../story-review";
import { tickInlineStoryWorker } from "../story";

let repo: MemoryRepository;
let SCRIPT: string;
beforeEach(async () => {
  repo = new MemoryRepository();
  world.repo = repo;
  world.files.clear();
  SCRIPT = (await repo.loadProject("ojousama"))!.episodes[0]!.scriptText;
});

const form = (fields: Record<string, string | File>, slug = "ojousama") => {
  const f = new FormData();
  f.set("projectSlug", slug);
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const FREE = "prism-test/screenplay-parser-v1";

/** A fresh, EMPTY project (nothing to match against). */
async function emptyProject() {
  const d = (await repo.loadProject("ojousama"))!;
  const id = randomUUID();
  await repo.createProject(
    { ...d.project, id, slug: "new-film", title: "New Film" },
    { ...d.bible, projectId: id },
  );
  return (await repo.loadProject("new-film"))!;
}

async function analyzed(fields: Record<string, string | File>, slug = "ojousama") {
  const d = (await repo.loadProject(slug))!;
  expect(await analyzeStory(form({ model: FREE, ...fields }, slug))).toMatchObject({ ok: true });
  const [queued] = await repo.story.list(d.project.id);
  expect(queued!.status).toBe("queued");
  await tickInlineStoryWorker();
  return (await repo.story.get(d.project.id, queued!.id))!;
}

function pdfOf(lines: string[]): Uint8Array {
  const content = `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? "T* " : ""}(${l}) Tj`).join(" ")} ET`;
  const z = deflateSync(Buffer.from(content, "latin1"));
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n${z.toString("latin1")}\nendstream`,
  ];
  return new Uint8Array(
    Buffer.from(
      `%PDF-1.4\n${objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join("")}%%EOF\n`,
      "latin1",
    ),
  );
}

describe("5B-S1 Import Story → Production Proposal", () => {
  it("a pasted screenplay becomes a validated, persisted, traceable proposal (Ojou-sama)", async () => {
    const rec = await analyzed({ sourceMode: "paste", text: SCRIPT, title: "Ojou-sama" });
    expect(rec.status).toBe("ready");
    expect(rec).toMatchObject({
      version: 1,
      provider: "prism-test",
      model: "screenplay-parser-v1",
      schemaVersion: "prism.production-proposal.v1",
      promptVersion: "story-analyst-v1",
      sourceKind: "paste",
      sourceAssetId: null,
      sourceFingerprint: sourceFingerprint(normalizeSourceText(SCRIPT)),
      estimate: { usd: 0 },
      providerCalls: 1,
    });
    const p = rec.proposal!;
    expect(p.characters.map((c) => c.name)).toEqual(expect.arrayContaining(["Yumeko", "Sean", "Takumi"]));
    expect(p.locations.map((l) => l.name)).toEqual(
      expect.arrayContaining([
        "Grand Celeste Lobby",
        "Sky-View Restaurant",
        "Hotel Hallway",
        "Tokyo Night Streets",
      ]),
    );
    expect(p.scenes.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(p.scenes[2]!.heading).toBe("INT. GRAND CELESTE LOBBY - NIGHT");
    // Shot 3A's structure: a Lobby scene shot with Yumeko
    const yumeko = p.characters.find((c) => c.name === "Yumeko")!;
    expect(p.shots.some((s) => s.sceneKey === p.scenes[2]!.key && s.characterKeys.includes(yumeko.key))).toBe(
      true,
    );
    // every item cites real source lines
    const n = lineCount(rec.inputText);
    for (const item of [...p.characters, ...p.locations, ...p.scenes])
      for (const r of item.sources) expect(r.endLine).toBeLessThanOrEqual(n);
    expect(p.characters.every((c) => c.sources.length > 0)).toBe(true);
  });

  it("uploaded TXT and PDF are kept as immutable Assets and analysed; foreign or missing sources are refused", async () => {
    const txt = await analyzed({
      sourceMode: "upload",
      file: new File([SCRIPT], "ojousama.txt", { type: "text/plain" }),
    });
    expect(txt.status).toBe("ready");
    const d = (await repo.loadProject("ojousama"))!;
    const asset = d.assets.find((a) => a.id === txt.sourceAssetId)!;
    expect(asset).toMatchObject({
      type: "document",
      purpose: "document",
      source: "upload",
      mime: "text/plain",
    });
    expect(txt.sourceMeta).toMatchObject({
      filename: "ojousama.txt",
      checksum: asset.checksum,
      fileKind: "txt",
    });
    const before = structuredClone(asset);
    const bytesBefore = world.files.get(asset.objectPath!)!;

    const pdf = await analyzed({
      sourceMode: "upload",
      file: new File(
        [
          Buffer.from(
            pdfOf(["INT. GRAND CELESTE LOBBY - NIGHT", "Yumeko enters.", "YUMEKO", "I want to go home."]),
          ),
        ],
        "s.pdf",
      ),
    });
    expect(pdf.status).toBe("ready");
    expect(pdf.sourceMeta).toMatchObject({ fileKind: "pdf", pages: [1] });
    expect(pdf.proposal!.locations.map((l) => l.name)).toEqual(["Grand Celeste Lobby"]);

    // re-analysing the stored document reads the SAME bytes (the source never changes)
    const again = await analyzed({ sourceMode: "asset", assetId: asset.id });
    expect(again.sourceFingerprint).toBe(txt.sourceFingerprint);
    expect((await repo.loadProject("ojousama"))!.assets.find((a) => a.id === asset.id)).toEqual(before);
    expect(world.files.get(asset.objectPath!)).toEqual(bytesBefore);

    // another project's document is refused
    const other = await emptyProject();
    expect(
      await analyzeStory(form({ model: FREE, sourceMode: "asset", assetId: asset.id }, other.project.slug)),
    ).toMatchObject({ ok: false, error: "That document is not one of this project's sources." });
    // a scanned PDF is reported, never faked
    const scan = await analyzeStory(
      form({ model: FREE, sourceMode: "upload", file: new File([Buffer.from(pdfOf([]))], "scan.pdf") }),
    );
    expect(scan).toMatchObject({ ok: false, error: expect.stringContaining("OCR") });
  });

  it("malformed provider output is rejected and nothing partial is stored; a correction is accepted", async () => {
    const d = (await repo.loadProject("ojousama"))!;
    await analyzeStory(form({ model: FREE, sourceMode: "paste", text: SCRIPT }));
    const [rec] = await repo.story.list(d.project.id);
    const worker = (answers: unknown[]) =>
      new StoryWorker({
        store: repo.story,
        registry: createStoryRegistry({ PRISM_STUDIO_STORY_AI_PROVIDERS: "" }, [
          new FakeStoryProvider({ answers }),
        ]),
        workerId: "test",
      });
    await worker(["{not json", { story: {} }]).tick();
    const failed = (await repo.story.get(d.project.id, rec!.id))!;
    expect(failed).toMatchObject({
      status: "failed",
      proposal: null,
      error: { code: "invalid_output" },
      providerCalls: 2,
    });
    // a new analysis whose first answer is broken but the correction is valid
    await analyzeStory(form({ model: FREE, sourceMode: "paste", text: SCRIPT }));
    const [second] = await repo.story.list(d.project.id);
    const { proposalFromScreenplay } = await import("@/story/providers/fake");
    await worker([{ nope: true }, proposalFromScreenplay(second!.inputText, null)]).tick();
    expect((await repo.story.get(d.project.id, second!.id))!).toMatchObject({
      status: "ready",
      providerCalls: 2,
    });
  });

  it("possible matches with existing Characters and Locations are surfaced, not merged silently", async () => {
    const rec = await analyzed({ sourceMode: "paste", text: SCRIPT });
    const d = (await repo.loadProject("ojousama"))!;
    const review = (await reviewOf(rec, d))!;
    const p = rec.proposal!;
    const yumeko = p.characters.find((c) => c.name === "Yumeko")!;
    const lobby = p.locations.find((l) => l.name === "Grand Celeste Lobby")!;
    const seedYumeko = d.characters.find((c) => c.name === "Yumeko")!;
    expect(review.items[itemId("character", yumeko.key)]!.match).toEqual({
      existingId: seedYumeko.id,
      decision: "use_existing",
    });
    expect(review.items[itemId("location", lobby.key)]!.match?.existingId).toBe(
      d.locations.find((l) => l.name === "Grand Celeste Lobby")!.id,
    );
    // Apply into the Ojou-sama project: existing Yumeko and Lobby are reused, never duplicated
    const r = await submitProposalReview(reviewForm(rec, review, { intent: "apply" }));
    expect(r).toMatchObject({ ok: true });
    const after = (await repo.loadProject("ojousama"))!;
    expect(after.characters.filter((c) => c.name === "Yumeko")).toHaveLength(1);
    expect(after.locations.filter((l) => l.name === "Grand Celeste Lobby")).toHaveLength(1);
    const newEp = after.episodes.find((e) => e.number === 2)!;
    const lobbyScene = after.scenes.find((s) => s.episodeId === newEp.id && s.slugline.includes("LOBBY"))!;
    expect(lobbyScene.locationId).toBe(d.locations.find((l) => l.name === "Grand Celeste Lobby")!.id);
    expect(lobbyScene.characterIds).toEqual([seedYumeko.id]);
  });

  it("review: deselect, reject and edit before Apply; applied once; the proposal and review then freeze", async () => {
    const other = await emptyProject();
    const rec = await analyzed({ sourceMode: "paste", text: SCRIPT, title: "Ojou-sama" }, "new-film");
    const p = rec.proposal!;
    const review = (await reviewOf(rec, other))!;
    const mother = p.characters.find((c) => c.name === "Mother")!;
    const reporter = p.characters.find((c) => c.name === "Reporter")!;
    const lobbyScene = p.scenes.find((s) => s.heading.includes("LOBBY"))!;
    const firstStreetShot = p.shots.find((s) => s.sceneKey === p.scenes[0]!.key)!;
    const f = reviewForm(rec, review, { intent: "save" }, "new-film");
    f.delete(`include:${itemId("character", mother.key)}`); // deselected
    f.set(`reject:${itemId("character", reporter.key)}`, "1"); // rejected
    f.delete(`include:${itemId("shot", firstStreetShot.key)}`);
    f.set(`edit:${itemId("scene", lobbyScene.key)}:summary`, "Alone at last, Yumeko lets the mask drop.");
    f.set("story:title", "Ojou-sama — Episode 1");
    expect(await submitProposalReview(f)).toMatchObject({ ok: true, message: "Review saved" });
    const saved = (await repo.story.get(other.project.id, rec.id))!;
    expect(saved.review!.items[itemId("character", mother.key)]!.selected).toBe(false);
    expect(saved.proposal).toEqual(rec.proposal); // the proposal itself never changes

    f.set("intent", "apply");
    const applied = await submitProposalReview(f);
    expect(applied).toMatchObject({ ok: true, message: expect.stringContaining("Applied:") });
    const d = (await repo.loadProject("new-film"))!;
    expect(d.characters.map((c) => c.name).sort()).toEqual(["Sean", "Takumi", "Yumeko"]);
    expect(d.locations).toHaveLength(5);
    expect(d.episodes).toHaveLength(1);
    expect(d.episodes[0]).toMatchObject({ title: "Ojou-sama — Episode 1", scriptText: rec.inputText });
    const scenes = [...d.scenes].sort((a, b) => a.order - b.order);
    expect(scenes.map((s) => s.sceneNumber)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(scenes[2]!.summary).toBe("Alone at last, Yumeko lets the mask drop.");
    expect(d.shots.length).toBe(p.shots.length - 1);
    // frozen: no second apply, no review change
    expect(await submitProposalReview(f)).toMatchObject({
      ok: false,
      error: "This proposal was already applied.",
    });
    expect((await repo.story.get(other.project.id, rec.id))!.status).toBe("applied");

    // the created skeleton feeds the existing Visual Bible / Production Frame workflow
    const yumeko = d.characters.find((c) => c.name === "Yumeko")!;
    expect(visualBibleReadiness(d, yumeko.id).items.find((i) => i.key === "canonical")!.done).toBe(false);
    const lobby = d.locations.find((l) => l.name === "Grand Celeste Lobby")!;
    expect(locationBibleReadiness(d, lobby.id).items).toHaveLength(6);
    const plan = buildSubjectImagePlan(d, {
      subject: { kind: "character", characterId: yumeko.id, intent: "portrait" },
      direction: "",
    });
    expect(plan.packageSnapshot).toMatchObject({ subject: { kind: "character", name: "Yumeko" } });
    expect(plan.positive).toContain("Yumeko");
    const shot3A = d.shots.find((s) => s.sceneId === scenes[2]!.id && s.characters.length > 0)!;
    expect(shot3A.shotCode).toBe("3B");
    const inputs = productionFrameInputs(assembleGenerationPackage(buildShotContext(d, shot3A.id)));
    expect(inputs.characters[0]!.name).toBe("Yumeko");
    expect(inputs.location[0]).toContain("Grand Celeste Lobby");
  });

  it("regenerating a section makes a NEW version; the earlier proposal and its review are unchanged and carried", async () => {
    const rec = await analyzed({ sourceMode: "paste", text: SCRIPT });
    const d = (await repo.loadProject("ojousama"))!;
    const review = (await reviewOf(rec, d))!;
    const f = reviewForm(rec, review, { intent: "save" });
    const mother = rec.proposal!.characters.find((c) => c.name === "Mother")!;
    f.delete(`include:${itemId("character", mother.key)}`);
    await submitProposalReview(f);
    const v1 = (await repo.story.get(d.project.id, rec.id))!;
    expect(
      await regenerateProposal(
        form({ proposalId: rec.id, section: "locations", note: "split the hotel", model: FREE }),
      ),
    ).toMatchObject({ ok: true });
    await tickInlineStoryWorker();
    const [v2] = await repo.story.list(d.project.id);
    expect(v2).toMatchObject({
      version: 2,
      parentId: rec.id,
      scope: { kind: "section", section: "locations", note: "split the hotel" },
      status: "ready",
      sourceFingerprint: rec.sourceFingerprint,
    });
    expect(v2!.proposal!.characters).toEqual(rec.proposal!.characters);
    expect(await repo.story.get(d.project.id, rec.id)).toEqual(v1);
    const carried = (await reviewOf(v2!, d, v1))!;
    expect(carried.items[itemId("character", mother.key)]!.selected).toBe(false);
  });

  it("paid analysis needs the estimate confirmed (and is off by default); nothing is queued otherwise", async () => {
    const d = (await repo.loadProject("ojousama"))!;
    vi.stubEnv("PRISM_STUDIO_ALLOW_PAID_STORY_AI", "");
    expect(
      await analyzeStory(form({ model: "openai/gpt-6-luna", sourceMode: "paste", text: SCRIPT })),
    ).toMatchObject({ ok: false, error: "Paid analysis is switched off on this server." });
    vi.stubEnv("PRISM_STUDIO_ALLOW_PAID_STORY_AI", "true");
    const r = await analyzeStory(form({ model: "openai/gpt-6-luna", sourceMode: "paste", text: SCRIPT }));
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Estimated cost: \$0\.\d{4} .* Enter /),
    });
    expect(await repo.story.list(d.project.id)).toHaveLength(0);
    // confirmed: queued — and the web has no key, so the worker refuses without calling anyone
    const usd = /Enter ([\d.]+)/.exec((r as { error: string }).error)![1]!;
    await analyzeStory(
      form({ model: "openai/gpt-6-luna", sourceMode: "paste", text: SCRIPT, confirmedTotalUsd: usd }),
    );
    await tickInlineStoryWorker();
    const [rec] = await repo.story.list(d.project.id);
    expect(rec).toMatchObject({
      status: "failed",
      error: { code: "not_configured" },
      providerCalls: 0,
      confirmedUsd: Number(usd),
    });
    vi.unstubAllEnvs();
  });
});

/** The review form exactly as the page renders it (every included item ticked). */
function reviewForm(
  rec: {
    id: string;
    proposal: {
      characters: Array<{ key: string }>;
      locations: Array<{ key: string }>;
      scenes: Array<{ key: string }>;
      shots: Array<{ key: string }>;
    } | null;
  },
  review: {
    items: Record<
      string,
      { selected: boolean; rejected: boolean; match: { decision: string | null } | null }
    >;
  },
  extra: Record<string, string>,
  slug = "ojousama",
) {
  const f = form({ proposalId: rec.id, target: "new", ...extra }, slug);
  for (const [id, r] of Object.entries(review.items)) {
    if (r.selected) f.set(`include:${id}`, "1");
    if (r.rejected) f.set(`reject:${id}`, "1");
    if (r.match?.decision) f.set(`match:${id}`, r.match.decision);
  }
  return f;
}

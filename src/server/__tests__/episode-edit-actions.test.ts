import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { editPage } from "@/components/views/episode-edit-model";
import { seed, shotByCode } from "@/domain/__tests__/helpers";
import { NO_MEDIA_FACTS } from "@/domain/edit/eligibility";
import type { ProjectData } from "@/domain/schemas";
import { selectTake } from "@/domain/takes";
import { createEpisodeEdit } from "../episode-edit-actions";
import { loadEpisodeEditPage } from "../episode-edit-page";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * Phase 2I.1C: the Episode Edit page's read and its one write (explicit initial creation), memory persistence. No
 * database, provider or Storage. The read never writes; the create persists exactly the reviewed proposal or refuses.
 */

process.env.PRISM_STUDIO_INLINE_WORKER = "0";
const SLUG = "ojousama";
let repo: MemoryRepository;
let data: ProjectData;

beforeEach(() => {
  data = seed();
  repo = new MemoryRepository([data]);
  globalThis.__prismMemoryRepo = repo;
});

const episodeId = () => data.episodes[0]!.id;
const fresh = async () => (await repo.loadProject(SLUG))!;
const page = async () => loadEpisodeEditPage(await fresh(), episodeId());
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const create = (proposalKey: string, ep = episodeId(), projectSlug = SLUG) =>
  createEpisodeEdit(form({ projectSlug, episodeId: ep, proposalKey }));
async function proposalKeyNow() {
  const p = await page();
  if (p.state !== "proposal") throw new Error(`expected a proposal, got ${p.state}`);
  return p.key;
}
/** Selects another take of Shot 3A's line (an upstream "current performance" change). */
async function selectOtherTakeOf3A() {
  const d = await fresh();
  const lineId = shotByCode(d, "3A").audio.dialogueLineIds[0]!;
  const other = d.takes.find((t) => t.dialogueLineId === lineId && !t.selected && !t.archived)!;
  const updated = selectTake(d.takes, other.id).filter((t) => t.dialogueLineId === lineId);
  await repo.upsertMany(d.project.id, "takes", updated);
  return other;
}

describe("Episode Edit page read (no edit yet)", () => {
  it("shows the proposed initial assembly with honest source labels, performance and silence; nothing is persisted", async () => {
    const p = await page();
    expect(p.state).toBe("proposal");
    if (p.state !== "proposal") return;
    expect(p.key).toMatch(/^[0-9a-f]{64}$/);
    expect(p.rows.map((r) => r.shotCode)).toEqual([
      "1A",
      "1B",
      "1C",
      "2A",
      "2B",
      "2C",
      "2D",
      "2E",
      "3A",
      "4A",
      "4B",
      "4C",
      "5A",
      "6A",
    ]);
    const row = (code: string) => p.rows.find((r) => r.shotCode === code)!;
    expect(row("1A").picture).toMatchObject({
      kind: "storyboard_frame",
      kindLabel: "Placeholder: Storyboard still",
      placeholder: true,
      mediaType: "image",
    });
    expect(row("2A").picture).toMatchObject({ kind: "none", kindLabel: "No picture yet", mediaUrl: null });
    expect(row("1A").audio.silence).toBe(true);
    expect(row("3A").audio.silence).toBe(false);
    expect(row("3A").audio.placements[0]!.take).toMatch(/^Take \d+ ·/);
    // the seed's approved clip of 2B has no usable video: a placeholder, said so
    expect(row("2B").notes.join(" ")).toMatch(/approved clip .* has no usable video/);
    expect(p.summary).toMatchObject({ items: 14, editRate: "24 fps" });
    expect(p.runs.length).toBeGreaterThan(1);
    expect(await repo.episodeEdits.listForProject(data.project.id)).toEqual([]);
  });

  it("is pure: reading again gives the same key and still persists nothing", async () => {
    const a = await proposalKeyNow();
    const b = await proposalKeyNow();
    expect(b).toBe(a);
    expect(await repo.episodeEdits.getForEpisode(data.project.id, episodeId())).toBeNull();
  });

  it("addresses media only through the private asset route (no storage path reaches the page)", async () => {
    // give one Storyboard frame's image a stored file (the seed's demo images have none)
    const frameAsset = data.assets.find((a) => a.id === data.frames.find((f) => f.assetId)!.assetId)!;
    frameAsset.objectPath = `${data.project.id}/${frameAsset.id}/frame.png`;
    repo = new MemoryRepository([data]);
    globalThis.__prismMemoryRepo = repo;
    const p = await page();
    const json = JSON.stringify(p);
    for (const a of data.assets) if (a.objectPath) expect(json).not.toContain(a.objectPath);
    const urls = [...json.matchAll(/"(?:mediaUrl|audioUrl|url)":"([^"]+)"/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => /^\/api\/assets\/[0-9a-f-]{36}$/.test(u))).toBe(true);
  });
});

describe("createEpisodeEdit", () => {
  it("persists exactly the reviewed proposal at revision 0; the page then shows the saved edit, and reading never bumps it", async () => {
    const before = await page();
    if (before.state !== "proposal") throw new Error("expected a proposal");
    const result = await create(before.key);
    expect(result).toMatchObject({ ok: true });
    const edit = (await repo.episodeEdits.getForEpisode(data.project.id, episodeId()))!;
    expect(edit.revision).toBe(0);
    expect(edit.items.map((i) => i.visual.kind)).toEqual(before.rows.map((r) => r.picture.kind));
    const after = await page();
    expect(after.state).toBe("edit");
    if (after.state !== "edit") return;
    expect(after.revision).toBe(0);
    expect(after.rows.map((r) => r.shotCode)).toEqual(before.rows.map((r) => r.shotCode));
    expect(after.rows.every((r) => r.badges.some((b) => b.label === "Pinned"))).toBe(true);
    await page();
    await page();
    expect(await repo.episodeEdits.getForEpisode(data.project.id, episodeId())).toEqual(edit);
  });

  it("refuses a stale proposal (an upstream change since the page was read) and persists nothing", async () => {
    const key = await proposalKeyNow();
    await selectOtherTakeOf3A();
    const result = await create(key);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.error).toMatch(/proposed assembly changed/);
    expect(await repo.episodeEdits.getForEpisode(data.project.id, episodeId())).toBeNull();
    // the refreshed proposal can be created
    expect(await create(await proposalKeyNow())).toMatchObject({ ok: true });
  });

  it("refuses a forged key and a key of another Episode's proposal", async () => {
    expect(await create("0".repeat(64))).toMatchObject({ ok: false });
    expect(await repo.episodeEdits.getForEpisode(data.project.id, episodeId())).toBeNull();
  });

  it("two identical creates racing: one edit, both resolve to it, no duplicate items or placements", async () => {
    const key = await proposalKeyNow();
    const results = await Promise.all([create(key), create(key)]);
    expect(results.every((r) => r.ok)).toBe(true);
    const edits = await repo.episodeEdits.listForProject(data.project.id);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.items).toHaveLength(14);
    expect(new Set(edits[0]!.items.map((i) => i.shotId)).size).toBe(14);
    // a later click (an old tab) also resolves to the existing edit
    expect(await create(key)).toMatchObject({ ok: true, message: expect.stringMatching(/already exists/) });
    expect(await repo.episodeEdits.listForProject(data.project.id)).toHaveLength(1);
  });

  it("refuses an Episode that is not this project's and an unknown project", async () => {
    const key = await proposalKeyNow();
    expect(await create(key, crypto.randomUUID())).toMatchObject({ ok: false, error: "Episode not found." });
    expect(await create(key, episodeId(), "no-such-project")).toMatchObject({ ok: false });
    expect(await repo.episodeEdits.listForProject(data.project.id)).toEqual([]);
  });
});

describe("Episode Edit page read (persisted edit)", () => {
  it("keeps the pinned take when the selected take changes, and says so", async () => {
    await create(await proposalKeyNow());
    const pinned = (await repo.episodeEdits.getForEpisode(data.project.id, episodeId()))!.items.find(
      (i) => i.shotId === shotByCode(data, "3A").id,
    )!.performance[0]!.takeId;
    const other = await selectOtherTakeOf3A();
    const p = await page();
    if (p.state !== "edit") throw new Error("expected the edit");
    const row = p.rows.find((r) => r.shotCode === "3A")!;
    expect(row.audio.placements[0]!.badges.map((b) => b.label)).toContain("Take superseded");
    expect(row.audio.placements[0]!.badges[0]!.title).toContain(`Take ${other.takeNumber} is selected now`);
    const edit = (await repo.episodeEdits.getForEpisode(data.project.id, episodeId()))!;
    expect(edit.revision).toBe(0);
    expect(edit.items.find((i) => i.shotId === shotByCode(data, "3A").id)!.performance[0]!.takeId).toBe(
      pinned,
    );
  });

  it("shows lineage through references: Shot → Storyboard frame, and line → take → audio", async () => {
    await create(await proposalKeyNow());
    const p = await page();
    if (p.state !== "edit") throw new Error("expected the edit");
    const row = p.rows.find((r) => r.shotCode === "3A")!;
    expect(row.lineage.picture[0]!.label).toBe("Shot 3A");
    expect(row.lineage.picture[1]!.label).toMatch(/^Storyboard frame v\d+$/);
    expect(row.lineage.audio[0]![0]!.label).toMatch(/^Line · /);
    expect(row.lineage.audio[0]![1]!.label).toMatch(/^Take \d+ · /);
  });

  it("reports an unresolvable pinned source honestly (the item stays, flagged), never omits it", async () => {
    await create(await proposalKeyNow());
    const edit = (await repo.episodeEdits.getForEpisode(data.project.id, episodeId()))!;
    const d = await fresh();
    const pinnedFrameId = edit.items.flatMap((i) =>
      i.visual.kind === "storyboard_frame" ? [i.visual.storyboardFrameId] : [],
    )[0]!;
    const broken: ProjectData = { ...d, frames: d.frames.filter((f) => f.id !== pinnedFrameId) };
    const vm = editPage(broken, edit, NO_MEDIA_FACTS);
    expect(vm.rows).toHaveLength(edit.items.length);
    const row = vm.rows.find((r) => r.picture.source === "Storyboard frame missing")!;
    expect(row.badges.map((b) => b.label)).toContain("Source unavailable");
    expect(vm.problems.some((p) => p.endsWith("The frame no longer exists."))).toBe(true);
  });
});

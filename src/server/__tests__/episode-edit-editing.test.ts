import { beforeAll, describe, expect, it, vi } from "vitest";
import { editPage } from "@/components/views/episode-edit-model";
import type { EpisodeEdit } from "@/domain/edit/model";
import { generationAttemptSchema, type ProjectData } from "@/domain/schemas";
import { makeHarness, type Harness } from "@/generation/__tests__/helpers";
import type { ActionResult } from "../action-result";
import {
  addShotToEdit,
  createEpisodeEdit,
  moveEditItem,
  pinEditItemTake,
  removeEditItem,
  setEditItemClipAudio,
  setEditItemSource,
  silenceEditItem,
  trimEditItem,
  useEditItemReplacement,
} from "../episode-edit-actions";
import { loadEditMediaFacts } from "../episode-edit-media";
import { loadEpisodeEditPage } from "../episode-edit-page";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * Phase 2I.1D editing actions, memory persistence, with REAL mock-provider clips (the generation harness: the in-process
 * worker and the free MockProvider; no external call). Every mutation goes through the 2I.1B repository; these tests
 * prove the action layer translates requests faithfully, refuses what the repository refuses, never overwrites a newer
 * revision, and bumps the revision exactly once per successful change.
 */

process.env.PRISM_STUDIO_INLINE_WORKER = "0";
const SLUG = "ojousama";
let h: Harness;
let clips: Array<{ attemptId: string; assetId: string; durationMs: number }>;

const data = async (): Promise<ProjectData> => (await h.repo.loadProject(SLUG))!;
const shotId = async (code: string) => (await data()).shots.find((s) => s.shotCode === code)!.id;
const edit = async (): Promise<EpisodeEdit> => {
  const d = await data();
  return (await h.repo.episodeEdits.getForEpisode(d.project.id, d.episodes[0]!.id))!;
};
const itemOf = async (code: string) => {
  const id = await shotId(code);
  return (await edit()).items.find((i) => i.shotId === id)!;
};
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
/** An editing action on Shot `code`'s item at the CURRENT revision (unless `revision` says otherwise). */
async function act(
  action: (f: FormData) => Promise<ActionResult>,
  code: string | null,
  fields: Record<string, string> = {},
  revision?: number,
) {
  const e = await edit();
  return action(
    form({
      projectSlug: SLUG,
      editId: e.id,
      expectedRevision: String(revision ?? e.revision),
      ...(code ? { itemId: (await itemOf(code)).id } : {}),
      ...fields,
    }),
  );
}
const errorOf = (r: ActionResult) => (r.ok ? "" : r.error);
const video = (c: { attemptId: string; assetId: string }) => `video:${c.attemptId}:${c.assetId}`;
const ids = (c: { attemptId: string; assetId: string }) => ({ attemptId: c.attemptId, assetId: c.assetId });

async function generateClip(code: string) {
  const { attemptId } = await h.submit(code);
  const worker = h.worker();
  for (let i = 0; i < 40; i++) {
    const view = await h.repo.generation.getAttemptView(attemptId!);
    if (view?.attempt.status === "succeeded") {
      const primary = view.outputs.find((o) => o.output.role === "primary")!;
      return { attemptId: attemptId!, assetId: primary.asset.id, durationMs: primary.asset.durationMs! };
    }
    await worker.tick(5);
    h.clock.advance(1000);
  }
  throw new Error("the mock clip did not finish");
}
const approve = (attemptId: string) =>
  h.repo.generation.reviewAttempt(attemptId, {
    status: "approved",
    categories: [],
    reason: "",
    notes: "",
    now: new Date().toISOString(),
  });

beforeAll(async () => {
  h = makeHarness();
  globalThis.__prismMemoryRepo = h.repo;
  clips = [await generateClip("3A"), await generateClip("3A"), await generateClip("3A")];
  const d = await data();
  const page = await loadEpisodeEditPage(d, d.episodes[0]!.id);
  if (page.state !== "proposal") throw new Error("expected a proposal");
  const created = await createEpisodeEdit(
    form({ projectSlug: SLUG, episodeId: d.episodes[0]!.id, proposalKey: page.key }),
  );
  if (!created.ok) throw new Error(created.error);
}, 60_000);

describe("2I.1D editing actions (memory, real mock clips)", () => {
  it("pins a deliberately chosen clip at its full length; revision +1", async () => {
    const before = (await edit()).revision;
    expect(await act(setEditItemSource, "3A", { source: video(clips[0]!) })).toMatchObject({ ok: true });
    const item = await itemOf("3A");
    expect(item.visual).toEqual({
      kind: "video",
      ...ids(clips[0]!),
      sourceInMs: 0,
      sourceOutMs: clips[0]!.durationMs,
    });
    expect((await edit()).revision).toBe(before + 1);
  });

  it("refuses a Production Frame candidate and an Asset of another generation; nothing changes", async () => {
    const d = await data();
    const frameCandidate = generationAttemptSchema.parse({
      ...d.attempts.find((a) => a.id === clips[0]!.attemptId)!,
      id: crypto.randomUUID(),
      attemptNumber: 900,
      approved: false,
      reviewStatus: "unreviewed",
      request: { purpose: "production_frame" },
    });
    await h.repo.upsert(d.project.id, "attempts", frameCandidate);
    const before = await edit();
    const r1 = await act(setEditItemSource, "3A", {
      source: `video:${frameCandidate.id}:${clips[0]!.assetId}`,
    });
    expect(errorOf(r1)).toMatch(/Production Frame candidate/);
    const r2 = await act(setEditItemSource, "3A", {
      source: `video:${clips[0]!.attemptId}:${clips[1]!.assetId}`,
    });
    expect(errorOf(r2)).toMatch(/not an output or delivery version/);
    expect(await edit()).toEqual(before);
  });

  it("trims inside the clip (duration follows); outside the clip or cutting a placed take is refused", async () => {
    const placed = (await itemOf("3A")).performance;
    expect(placed.length).toBeGreaterThan(0);
    const end = Math.max(...placed.map((p) => p.startMs + p.takeOutMs - p.takeInMs));
    const before = (await edit()).revision;
    expect(
      await act(trimEditItem, "3A", { sourceIn: "0", sourceOut: (end / 1000).toFixed(3) }),
    ).toMatchObject({
      ok: true,
    });
    expect((await itemOf("3A")).visual).toMatchObject({ sourceInMs: 0, sourceOutMs: end });
    expect((await edit()).revision).toBe(before + 1);
    expect(
      errorOf(
        await act(trimEditItem, "3A", {
          sourceIn: "0",
          sourceOut: ((clips[0]!.durationMs + 1) / 1000).toFixed(3),
        }),
      ),
    ).toMatch(/outside the clip/);
    expect(
      errorOf(await act(trimEditItem, "3A", { sourceIn: "0", sourceOut: ((end - 1) / 1000).toFixed(3) })),
    ).toMatch(/must stay inside its item/);
    expect(errorOf(await act(trimEditItem, "3A", { sourceIn: "abc", sourceOut: "1" }))).toMatch(
      /number of seconds/,
    );
    expect((await edit()).revision).toBe(before + 1);
  });

  it("pins another take for the line (the project's selected take is untouched); a take of another line is refused", async () => {
    const d = await data();
    const item = await itemOf("3A");
    const line = item.performance[0]!.dialogueLineId;
    const selectedBefore = d.takes.find((t) => t.dialogueLineId === line && t.selected)!.id;
    const other = d.takes.find(
      (t) => t.dialogueLineId === line && t.id !== item.performance[0]!.takeId && !t.archived,
    )!;
    expect(await act(pinEditItemTake, "3A", { dialogueLineId: line, takeId: other.id })).toMatchObject({
      ok: true,
    });
    expect((await itemOf("3A")).performance.find((p) => p.dialogueLineId === line)!.takeId).toBe(other.id);
    expect((await data()).takes.find((t) => t.dialogueLineId === line && t.selected)!.id).toBe(
      selectedBefore,
    );
    const foreign = d.takes.find((t) => t.dialogueLineId !== line)!;
    expect(errorOf(await act(pinEditItemTake, "3A", { dialogueLineId: line, takeId: foreign.id }))).toMatch(
      /not a take of this line/,
    );
  });

  it("an archived take stays pinned and is reported, never replaced", async () => {
    const d = await data();
    const pinned = (await itemOf("3A")).performance[0]!;
    const take = d.takes.find((t) => t.id === pinned.takeId)!;
    await h.repo.upsert(d.project.id, "takes", { ...take, archived: true, selected: false });
    expect((await itemOf("3A")).performance[0]!.takeId).toBe(pinned.takeId);
    const vm = editPage(
      await data(),
      await edit(),
      await loadEditMediaFacts(await data(), d.episodes[0]!.id),
    );
    const row = vm.rows.find((r) => r.shotCode === "3A")!;
    expect(row.audio.placements[0]!.badges.map((b) => b.label)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Take archived|Take superseded/)]),
    );
  });

  it("Silence clears the item's placements (no silence record); the clip's own audio cannot be included without a track", async () => {
    expect(await act(silenceEditItem, "3A")).toMatchObject({ ok: true });
    expect((await itemOf("3A")).performance).toEqual([]);
    expect(errorOf(await act(setEditItemClipAudio, "3A", { sourceAudio: "included" }))).toMatch(
      /no record of an audio track/,
    );
    expect(await act(setEditItemClipAudio, "3A", { sourceAudio: "muted" })).toMatchObject({ ok: true });
    expect((await itemOf("3A")).sourceAudio).toBe("muted");
  });

  it("uses exactly the replacement shown; a different current replacement is refused", async () => {
    await approve(clips[1]!.attemptId);
    const d = await data();
    const shown = editPage(d, await edit(), await loadEditMediaFacts(d, d.episodes[0]!.id)).rows.find(
      (r) => r.shotCode === "3A",
    )!.editor!.replacement!;
    expect(shown).toMatchObject({ attemptId: clips[1]!.attemptId, assetId: clips[1]!.assetId });
    // upstream moves on before the click: another clip is approved
    await approve(clips[2]!.attemptId);
    const before = await edit();
    const stale = await act(useEditItemReplacement, "3A", {
      attemptId: shown.attemptId,
      assetId: shown.assetId,
    });
    expect(errorOf(stale)).toMatch(/replacement changed/);
    expect(await edit()).toEqual(before);
    const current = { attemptId: clips[2]!.attemptId, assetId: clips[2]!.assetId };
    expect(await act(useEditItemReplacement, "3A", current)).toMatchObject({ ok: true });
    expect((await itemOf("3A")).visual).toMatchObject({ kind: "video", ...current });
    const after = editPage(await data(), await edit(), await loadEditMediaFacts(d, d.episodes[0]!.id));
    expect(after.rows.find((r) => r.shotCode === "3A")!.editor!.replacement).toBeNull();
  });

  it("reorders by explicit moves; Scene runs recompute (a Scene revisited has two runs) and the order differs from the Sequence", async () => {
    // 2D, 2E (Scene 2), 3A (Scene 3): move 2E below 3A → Scene 2, Scene 3, Scene 2
    expect(await act(moveEditItem, "2E", { direction: "down" })).toMatchObject({ ok: true });
    const d = await data();
    const vm = editPage(d, await edit(), await loadEditMediaFacts(d, d.episodes[0]!.id));
    const codes = vm.rows.map((r) => r.shotCode);
    expect(codes.indexOf("3A")).toBe(codes.indexOf("2E") - 1);
    expect(vm.runs.map((r) => r.label)).toEqual(
      expect.arrayContaining(["Scene 2 · run 1 of 2", "Scene 2 · run 2 of 2"]),
    );
    expect(vm.badges.map((b) => b.label)).toContain("Order differs from Sequence");
    expect(errorOf(await act(moveEditItem, codes[0]!, { direction: "up" }))).toMatch(/already at that end/);
  });

  it("removes an item (the Shot itself is untouched and becomes deletable) and adds a Shot back at a chosen position", async () => {
    const d = await data();
    expect(await act(removeEditItem, "6A")).toMatchObject({ ok: true });
    expect((await edit()).items.some((i) => i.shotId === d.shots.find((s) => s.shotCode === "6A")!.id)).toBe(
      false,
    );
    expect((await data()).shots.some((s) => s.shotCode === "6A")).toBe(true);

    expect(await act(removeEditItem, "5A")).toMatchObject({ ok: true });
    const addable = editPage(
      await data(),
      await edit(),
      await loadEditMediaFacts(d, d.episodes[0]!.id),
    ).addable;
    const fiveA = addable.find((a) => a.shotCode === "5A")!;
    expect(fiveA.proposed).toBeTruthy();
    expect(
      errorOf(
        await act(addShotToEdit, null, { shotId: fiveA.shotId, itemKey: "0".repeat(64), position: "0" }),
      ),
    ).toMatch(/changed since this page was loaded/);
    expect(
      await act(addShotToEdit, null, { shotId: fiveA.shotId, itemKey: fiveA.itemKey, position: "0" }),
    ).toMatchObject({ ok: true });
    expect((await edit()).items[0]!.shotId).toBe(fiveA.shotId);
    expect(
      errorOf(
        await act(addShotToEdit, null, { shotId: fiveA.shotId, itemKey: fiveA.itemKey, position: "end" }),
      ),
    ).toMatch(/already in the edit/);
    // the removed Shot is no longer referenced: the memory twin of the database key lets it go
    await h.repo.remove(d.project.id, "shots", d.shots.find((s) => s.shotCode === "6A")!.id);
  });

  it("a stale revision is refused with the conflict message and never overwrites the newer edit", async () => {
    const e = await edit();
    const r = await act(setEditItemSource, "3A", { source: "none" }, e.revision - 1);
    expect(errorOf(r)).toBe(
      "This edit changed before your update was saved. Review the latest version and try again.",
    );
    expect(await edit()).toEqual(e);
  });

  it("two mutations from the same revision: exactly one wins, the other is a conflict; +1 revision exactly once", async () => {
    const e = await edit();
    const results = await Promise.all([
      act(setEditItemSource, "4A", { source: "none" }, e.revision),
      act(moveEditItem, "4A", { direction: "up" }, e.revision),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map(errorOf)).toEqual([
      "This edit changed before your update was saved. Review the latest version and try again.",
    ]);
    expect((await edit()).revision).toBe(e.revision + 1);
  });
});

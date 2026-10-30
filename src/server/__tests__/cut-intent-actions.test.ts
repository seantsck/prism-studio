import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EpisodeEdit } from "@/domain/edit/model";
import type { ProjectData } from "@/domain/schemas";
import { makeHarness, type Harness } from "@/generation/__tests__/helpers";
import type { ActionResult } from "../action-result";
import { clearCutIntent, createEpisodeEdit, moveEditItem, setCutIntent } from "../episode-edit-actions";
import { loadEpisodeEditPage } from "../episode-edit-page";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * Phase 3A.4C cut-intent actions (the Continuity Supervisor's only write), memory persistence: the repository decides;
 * the action re-reads the edit at the expected revision, the declarer and time come from the server, one revision per
 * change, and a stale revision writes nothing. No provider call.
 */

process.env.PRISM_STUDIO_INLINE_WORKER = "0";
const SLUG = "ojousama";
let h: Harness;

const data = async (): Promise<ProjectData> => (await h.repo.loadProject(SLUG))!;
const edit = async (): Promise<EpisodeEdit> => {
  const d = await data();
  return (await h.repo.episodeEdits.getForEpisode(d.project.id, d.episodes[0]!.id))!;
};
const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
};
const errorOf = (r: ActionResult) => (r.ok ? "" : r.error);
async function intentForm(right: number, o: Record<string, string | string[]> = {}, revision?: number) {
  const e = await edit();
  return form({
    projectSlug: SLUG,
    editId: e.id,
    expectedRevision: String(revision ?? e.revision),
    itemId: e.items[right]!.id,
    expectedPredecessorId: e.items[right - 1]!.id,
    kinds: ["time_jump"],
    scope: ["time_of_day"],
    note: "Hours later.",
    ...o,
  });
}

beforeAll(async () => {
  h = makeHarness();
  globalThis.__prismMemoryRepo = h.repo;
  const d = await data();
  const page = await loadEpisodeEditPage(d, d.episodes[0]!.id);
  if (page.state !== "proposal") throw new Error("expected a proposal");
  const created = await createEpisodeEdit(
    form({ projectSlug: SLUG, episodeId: d.episodes[0]!.id, proposalKey: page.key }),
  );
  if (!created.ok) throw new Error(created.error);
});

describe("setCutIntent / clearCutIntent", () => {
  it("records the intent bound to the reviewed predecessor; declarer and time from the server, never the form", async () => {
    const before = await edit();
    const r = await setCutIntent(
      await intentForm(2, {
        declaredBy: "99999999-9999-4999-8999-999999999999",
        declaredAt: "2000-01-01T00:00:00Z",
      }),
    );
    expect(r).toMatchObject({ ok: true });
    const after = await edit();
    expect(after.revision).toBe(before.revision + 1);
    const intent = after.items[2]!.incomingCutIntent!;
    expect(intent).toMatchObject({
      fromItemId: before.items[1]!.id,
      kinds: ["time_jump"],
      scope: ["time_of_day"],
      note: "Hours later.",
      declaredBy: h.repo.currentUserId(),
    });
    expect(intent.declaredAt).not.toBe("2000-01-01T00:00:00Z");
  });

  it("a stale revision writes nothing", async () => {
    const before = await edit();
    const r = await clearCutIntent(await intentForm(2, {}, before.revision - 1));
    expect(errorOf(r)).toMatch(/This edit changed before your update/);
    expect(await edit()).toEqual(before);
  });

  it("refuses an unknown kind, no kind and an empty note; nothing changes", async () => {
    const before = await edit();
    expect(errorOf(await setCutIntent(await intentForm(1, { kinds: ["teleport"] })))).toMatch(/not known/);
    expect(errorOf(await setCutIntent(await intentForm(1, { kinds: [] })))).toMatch(/at least one kind/);
    expect(errorOf(await setCutIntent(await intentForm(1, { note: "  " })))).toMatch(/Say why/);
    expect(await edit()).toEqual(before);
  });

  it("refuses a predecessor that is no longer the item before the cut (conflict), nothing changes", async () => {
    const before = await edit();
    const r = await setCutIntent(await intentForm(3, { expectedPredecessorId: before.items[0]!.id }));
    expect(errorOf(r)).toMatch(/This cut changed since you opened it/);
    expect(await edit()).toEqual(before);
  });

  it("a reorder that changes the predecessor clears it; clear on a cut without intent is refused", async () => {
    const e = await edit();
    expect(e.items[2]!.incomingCutIntent).not.toBeNull();
    const moved = await moveEditItem(
      form({
        projectSlug: SLUG,
        editId: e.id,
        expectedRevision: String(e.revision),
        itemId: e.items[2]!.id,
        direction: "up",
      }),
    );
    expect(moved).toMatchObject({ ok: true });
    const after = await edit();
    expect(after.items.every((i) => !i.incomingCutIntent)).toBe(true);
    expect(errorOf(await clearCutIntent(await intentForm(2)))).toMatch(/no declared intent/);
  });

  it("clearCutIntent removes it in one revision", async () => {
    expect(await setCutIntent(await intentForm(1))).toMatchObject({ ok: true });
    const before = await edit();
    expect(await clearCutIntent(await intentForm(1))).toMatchObject({ ok: true });
    const after = await edit();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.items[1]!.incomingCutIntent).toBeNull();
  });
});

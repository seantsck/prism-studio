import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { seed, shotByCode } from "@/domain/__tests__/helpers";
import type { ProjectData } from "@/domain/schemas";
import {
  SEQUENCE_CHANGED_MESSAGE,
  sequenceLinkChanges,
  sequenceLinkPreviewKey,
} from "@/domain/shot-sequence";
import { reorderShots } from "../actions";
import { syncSequenceContinuityLinks } from "../sequence-actions";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * Phase 2G.5: the explicit continuity-link sync through the real server action, on the memory repository. No database,
 * Storage, provider, AI analysis, 3D set or GPU.
 */

const SLUG = "ojousama";

function setup(mutate: (data: ProjectData) => void) {
  const data = seed();
  mutate(data);
  const repo = new MemoryRepository([data]);
  globalThis.__prismMemoryRepo = repo;
  return { repo, episodeId: data.episodes[0].id };
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const load = async (repo: MemoryRepository) => (await repo.loadProject(SLUG))!;
const snapshot = (data: ProjectData) =>
  Object.fromEntries(data.shots.map((s) => [s.shotCode, JSON.stringify(s)]));

// the first call loads the whole server-action module graph
describe("syncSequenceContinuityLinks", { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.stubEnv("PRISM_STUDIO_PERSISTENCE", "memory");
  });

  it("applies the confirmed preview: only the mismatched Shots change, and only their previousShotId", async () => {
    const { repo, episodeId } = setup((d) => {
      shotByCode(d, "1C").continuity.previousShotId = shotByCode(d, "1A").id;
      shotByCode(d, "2D").continuity.previousShotId = null;
    });
    const before = await load(repo);
    expect(sequenceLinkChanges(before, episodeId).map((c) => c.shotCode)).toEqual(["1C", "2D"]);
    const r = await syncSequenceContinuityLinks(
      form({ projectSlug: SLUG, episodeId, previewKey: sequenceLinkPreviewKey(before, episodeId) }),
    );
    expect(r).toMatchObject({ ok: true, message: "2 continuity links synced (1C, 2D)." });
    const after = await load(repo);
    expect(sequenceLinkChanges(after, episodeId)).toEqual([]);
    const a = snapshot(before);
    const b = snapshot(after);
    for (const code of Object.keys(a)) {
      if (code === "1C" || code === "2D") continue;
      expect(b[code], `${code} untouched`).toBe(a[code]);
    }
    for (const code of ["1C", "2D"]) {
      const was = before.shots.find((s) => s.shotCode === code)!;
      const now = after.shots.find((s) => s.shotCode === code)!;
      // nothing but the link (and the save timestamp) differs
      expect({
        ...now,
        updatedAt: was.updatedAt,
        continuity: { ...now.continuity, previousShotId: null },
      }).toEqual({
        ...was,
        continuity: { ...was.continuity, previousShotId: null },
      });
    }
    expect(shotByCode(after, "1C").continuity.previousShotId).toBe(shotByCode(after, "1B").id);
    expect(shotByCode(after, "2D").continuity.previousShotId).toBe(shotByCode(after, "2C").id);
  });

  it("a mismatch on a LOCKED Shot refuses the whole sync: nothing is written", async () => {
    const { repo, episodeId } = setup((d) => {
      shotByCode(d, "1C").continuity.previousShotId = shotByCode(d, "1A").id;
      shotByCode(d, "1C").status = "locked";
      shotByCode(d, "2D").continuity.previousShotId = null;
    });
    const before = await load(repo);
    const r = await syncSequenceContinuityLinks(
      form({ projectSlug: SLUG, episodeId, previewKey: sequenceLinkPreviewKey(before, episodeId) }),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("Locked Shot 1C");
    expect(snapshot(await load(repo))).toEqual(snapshot(before));
  });

  it("an outdated preview is refused: the order changed after the preview was built; nothing is written", async () => {
    const { repo, episodeId } = setup((d) => {
      shotByCode(d, "1C").continuity.previousShotId = shotByCode(d, "1A").id;
    });
    const before = await load(repo);
    const staleKey = sequenceLinkPreviewKey(before, episodeId);
    const scene2 = before.shots
      .filter((s) => s.sceneId === shotByCode(before, "2A").sceneId)
      .sort((a, b) => a.order - b.order)
      .map((s) => s.id);
    const moved = await reorderShots(
      shotByCode(before, "2A").sceneId,
      [scene2[1], scene2[0], ...scene2.slice(2)],
      SLUG,
    );
    expect(moved.ok).toBe(true);
    const reordered = await load(repo);
    // the reorder itself never touched a link
    expect(reordered.shots.map((s) => [s.id, s.continuity.previousShotId])).toEqual(
      before.shots.map((s) => [s.id, s.continuity.previousShotId]),
    );
    const r = await syncSequenceContinuityLinks(form({ projectSlug: SLUG, episodeId, previewKey: staleKey }));
    expect(r).toMatchObject({ ok: false, error: SEQUENCE_CHANGED_MESSAGE });
    expect(snapshot(await load(repo))).toEqual(snapshot(reordered));
  });

  it("an unknown episode is refused", async () => {
    setup(() => {});
    const r = await syncSequenceContinuityLinks(
      form({ projectSlug: SLUG, episodeId: "nope", previewKey: "x" }),
    );
    expect(r).toMatchObject({ ok: false, error: "Episode not found." });
  });
});

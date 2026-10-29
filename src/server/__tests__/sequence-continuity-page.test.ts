import { beforeEach, describe, expect, it, vi } from "vitest";
import { seed } from "@/domain/__tests__/helpers";
import { EpisodeEditError } from "@/data/episode-edit-repository";

vi.mock("server-only", () => ({}));
const getForEpisode = vi.fn();
const loadEditMediaFacts = vi.fn();
vi.mock("../episode-edits", () => ({ getEpisodeEditRepo: async () => ({ getForEpisode }) }));
vi.mock("../episode-edit-media", () => ({
  loadEditMediaFacts: (...a: unknown[]) => loadEditMediaFacts(...a),
}));

const { loadContinuityPage } = await import("../sequence-continuity-page");

/**
 * Phase 3A.4B Supervisor READ: it only reads the persisted edit (and, when there is one, its media facts). No edit →
 * the no-edit state, never cuts from Shot order and never an auto-created edit; a read failure is reported.
 */
describe("loadContinuityPage", () => {
  beforeEach(() => {
    getForEpisode.mockReset();
    loadEditMediaFacts.mockReset();
  });

  it("no persisted edit: the no-edit state, nothing else read", async () => {
    const data = seed();
    getForEpisode.mockResolvedValue(null);
    const page = await loadContinuityPage(data, data.episodes[0]);
    expect(page).toEqual({
      state: "no_edit",
      links: {
        edit: "/projects/ojousama/episodes/ep-1/edit",
        sequence: "/projects/ojousama/episodes/ep-1/sequence",
      },
    });
    expect(loadEditMediaFacts).not.toHaveBeenCalled();
  });

  it("a persisted edit: its media facts for exactly its pinned attempts, then the cuts", async () => {
    const data = seed();
    const shots = data.shots.filter((s) => s.episodeId === data.episodes[0].id).slice(0, 2);
    getForEpisode.mockResolvedValue({
      id: "edit-1",
      projectId: data.project.id,
      episodeId: data.episodes[0].id,
      editRate: { num: 24, den: 1 },
      revision: 3,
      items: shots.map((s, i) => ({
        id: `item-${i}`,
        shotId: s.id,
        visual: { kind: "none", durationMs: 2000 },
        sourceAudio: "muted",
        performance: [],
        performanceBasis: null,
      })),
    });
    loadEditMediaFacts.mockResolvedValue({ attempts: new Map(), bestPointers: [] });
    const page = await loadContinuityPage(data, data.episodes[0]);
    expect(page.state).toBe("edit");
    if (page.state !== "edit") return;
    expect(page.revision).toBe(3);
    expect(page.rows.map((r) => r.anchor)).toEqual(["cut-item-0-item-1"]);
    expect(loadEditMediaFacts).toHaveBeenCalledWith(data, data.episodes[0].id, []);
  });

  it("a read failure is a truthful error, never a fallback", async () => {
    const data = seed();
    getForEpisode.mockRejectedValue(new EpisodeEditError("not_found", "The edit could not be read."));
    expect(await loadContinuityPage(data, data.episodes[0])).toMatchObject({
      state: "error",
      message: "The edit could not be read.",
    });
    getForEpisode.mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const page = await loadContinuityPage(data, data.episodes[0]);
    expect(page.state).toBe("error");
    expect(page.state === "error" ? page.message : "").toMatch(/could not read this Episode's edit/);
    spy.mockRestore();
  });
});

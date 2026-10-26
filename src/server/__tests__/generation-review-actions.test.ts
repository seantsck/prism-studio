import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_SHOT_OUTPUT_APPROVAL_MESSAGE } from "@/data/generation-repository";
import { MemoryRepository } from "@/data/memory-repository";
import { seed, shotByCode } from "@/domain/__tests__/helpers";
import { generationAttemptSchema, type GenerationAttempt, type ProjectData } from "@/domain/schemas";
import { reviewGeneration } from "../generation-actions";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * Creative approval is the Shot's ONE approved output, so only Shot-output attempts may take it. A Production Frame
 * candidate approved by a direct request would silently supersede the Shot's approved video: the server refuses it.
 * Memory persistence only: no database, provider or Storage.
 */

const SLUG = "ojousama";

function attempt(
  data: ProjectData,
  shotId: string,
  n: number,
  request: GenerationAttempt["request"],
  approved = false,
) {
  return generationAttemptSchema.parse({
    id: crypto.randomUUID(),
    projectId: data.project.id,
    shotId,
    attemptNumber: 100 + n,
    provider: "mock",
    model: "mock-video-1",
    modality: "video",
    prompt: "",
    negativePrompt: "",
    packageSnapshot: {},
    packageFingerprint: `fp-${n}`,
    modelSettings: {},
    inputAssetIds: [],
    outputAssetId: null,
    costUsd: 0,
    durationMs: null,
    status: "succeeded",
    reviewStatus: approved ? "approved" : "unreviewed",
    rejectionReason: "",
    notes: "",
    approved,
    request,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
  });
}

function setup() {
  const data = seed();
  const shotId = shotByCode(data, "3A").id;
  const video = attempt(data, shotId, 1, { purpose: "shot_output" }, true); // the Shot's approved video
  const frameCandidate = attempt(data, shotId, 2, { purpose: "production_frame" });
  const animation = attempt(data, shotId, 3, { purpose: "animate_production_frame" });
  const legacy = attempt(data, shotId, 4, null); // history before purposes existed: a Shot output
  const unknown = attempt(data, shotId, 5, { purpose: "something_new" }); // unknown → shot_output (existing rule)
  data.attempts = [
    ...data.attempts.filter((a) => a.shotId !== shotId),
    video,
    frameCandidate,
    animation,
    legacy,
    unknown,
  ];
  const repo = new MemoryRepository([data]);
  globalThis.__prismMemoryRepo = repo;
  return { repo, video, frameCandidate, animation, legacy, unknown };
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const approveForm = (attemptId: string) => form({ projectSlug: SLUG, attemptId, decision: "approve" });
const review = {
  status: "approved" as const,
  categories: [],
  reason: "",
  notes: "",
  now: "2026-01-02T00:00:00.000Z",
};

/** The approved attempts of Shot 3A (other seeded Shots keep their own approvals). */
async function approvedIds(repo: MemoryRepository) {
  const data = (await repo.loadProject(SLUG))!;
  const shotId = shotByCode(data, "3A").id;
  return data.attempts.filter((a) => a.shotId === shotId && a.approved).map((a) => a.id);
}

describe("creative approval is restricted to Shot outputs", () => {
  beforeEach(() => {
    vi.stubEnv("PRISM_STUDIO_PERSISTENCE", "memory");
  });

  it("a direct approve request for a Production Frame candidate is refused; the Shot's approved video stays approved", async () => {
    const { repo, video, frameCandidate } = setup();
    const res = await reviewGeneration(approveForm(frameCandidate.id));
    expect(res).toEqual({ ok: false, error: NOT_SHOT_OUTPUT_APPROVAL_MESSAGE });
    expect(await approvedIds(repo)).toEqual([video.id]);
    const after = (await repo.loadProject(SLUG))!.attempts.find((a) => a.id === frameCandidate.id)!;
    expect(after.reviewStatus).toBe("unreviewed");
  });

  it("the repository refuses it too, whatever the caller (no write)", async () => {
    const { repo, video, frameCandidate } = setup();
    await expect(repo.generation.reviewAttempt(frameCandidate.id, review)).rejects.toThrow(
      NOT_SHOT_OUTPUT_APPROVAL_MESSAGE,
    );
    expect(await approvedIds(repo)).toEqual([video.id]);
  });

  it("an animate_production_frame attempt is still approvable and supersedes the previous approval", async () => {
    const { repo, animation } = setup();
    expect((await reviewGeneration(approveForm(animation.id))).ok).toBe(true);
    expect(await approvedIds(repo)).toEqual([animation.id]);
  });

  it("historical attempts with no purpose and unknown purposes stay approvable (they are Shot outputs)", async () => {
    const { repo, legacy, unknown } = setup();
    expect((await reviewGeneration(approveForm(legacy.id))).ok).toBe(true);
    expect(await approvedIds(repo)).toEqual([legacy.id]);
    expect((await reviewGeneration(approveForm(unknown.id))).ok).toBe(true);
    expect(await approvedIds(repo)).toEqual([unknown.id]);
  });

  it("rejecting or clearing a Production Frame candidate is unaffected (only approval is restricted)", async () => {
    const { repo, video, frameCandidate } = setup();
    const rejected = await reviewGeneration(
      form({ projectSlug: SLUG, attemptId: frameCandidate.id, decision: "reject", reason: "wrong pose" }),
    );
    expect(rejected.ok).toBe(true);
    expect(await approvedIds(repo)).toEqual([video.id]);
  });
});

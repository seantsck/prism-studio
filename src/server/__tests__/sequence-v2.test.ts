import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { editPage } from "@/components/views/episode-edit-model";
import { newUploadAsset } from "@/domain/__tests__/production-frame-fixtures";
import { buildShotContext, shotOrder } from "@/domain/context";
import type { EpisodeEdit } from "@/domain/edit/model";
import { isStoryOrder, SEQUENCE_MEDIA_LABEL, storyOrderIds } from "@/domain/edit/sequence";
import { draftProductionFrame } from "@/domain/production-frame";
import type { ProjectData } from "@/domain/schemas";
import { submitCandidateSet } from "@/generation/candidate-set";
import { makeHarness, type Harness } from "@/generation/__tests__/helpers";
import type { ActionResult } from "../action-result";
import {
  createEpisodeEdit,
  moveEditItem,
  resetEditToStoryOrder,
  setEditItemHold,
  useCurrentShotMedia,
} from "../episode-edit-actions";
import { loadEditMediaFacts } from "../episode-edit-media";
import { loadEpisodeEditPage } from "../episode-edit-page";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * Phase 5B-V2: the Episode Sequence + Animatic on the EXISTING Episode Edit (2I.1, memory persistence) with REAL mock
 * Shot Clips from the V1 / 2H animation workflow (free mock video models, the in-process worker). No external call.
 *
 * MEDIA POLICY under test: items PIN exact media; an upstream change (a new Shot Clip, a new canonical Production Frame)
 * is surfaced on the row and applied only by an explicit "Use current Shot Clips and frames" (one revision).
 */
process.env.PRISM_STUDIO_INLINE_WORKER = "0";
const SLUG = "ojousama";
let h: Harness;
let fetchSpy: ReturnType<typeof vi.spyOn>;
const clipOf: Record<string, { attemptId: string; assetId: string }> = {};
const frameOf: Record<string, string> = {};
let checksumsBefore: Map<string, string>;

const raw = async (): Promise<ProjectData> => (await h.repo.loadProject(SLUG))!;
const data = async (): Promise<ProjectData> => {
  const d = await raw();
  const pf = await h.repo.productionFrames.listForProject(d.project.id);
  return { ...d, productionFrames: pf.frames, productionFrameSelections: pf.selections };
};
const shotByCode = async (code: string) => (await data()).shots.find((s) => s.shotCode === code)!;
const edit = async (): Promise<EpisodeEdit> => {
  const d = await data();
  return (await h.repo.episodeEdits.getForEpisode(d.project.id, d.episodes[0]!.id))!;
};
const codesOf = async (e: EpisodeEdit) => {
  const d = await data();
  return e.items.map((i) => d.shots.find((s) => s.id === i.shotId)!.shotCode);
};
const itemOf = async (code: string) => {
  const id = (await shotByCode(code)).id;
  return (await edit()).items.find((i) => i.shotId === id)!;
};
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
async function act(
  action: (f: FormData) => Promise<ActionResult>,
  code: string | null,
  fields: Record<string, string> = {},
) {
  const e = await edit();
  return action(
    form({
      projectSlug: SLUG,
      editId: e.id,
      expectedRevision: String(e.revision),
      ...(code ? { itemId: (await itemOf(code)).id } : {}),
      ...fields,
    }),
  );
}
const page = async () => {
  const d = await data();
  const e = await edit();
  return editPage(d, e, await loadEditMediaFacts(d, e.episodeId));
};
const rowOf = async (code: string) => (await page()).rows.find((r) => r.shotCode === code)!;

async function drain(rounds = 14) {
  for (let i = 0; i < rounds; i++) {
    await h.worker().tick(10);
    h.clock.advance(2000);
  }
}
/** Uploads a 16:9 image and makes it the Shot's canonical Production Frame. */
async function frame(code: string, label: string) {
  const d = await data();
  const shot = d.shots.find((s) => s.shotCode === code)!;
  const asset = newUploadAsset(d.project.id, { label, width: 1600, height: 900 });
  const drafted = draftProductionFrame(buildShotContext(d, shot.id), {
    id: randomUUID(),
    now: h.clock.now.toISOString(),
    userId: null,
    source: "upload",
    asset,
  });
  if (!drafted.ok) throw new Error(drafted.problem.message);
  const r = await h.repo.productionFrames.create({
    draft: drafted.draft,
    newAsset: asset,
    select: true,
    userId: null,
    now: h.clock.now.toISOString(),
  });
  frameOf[code] = r.frame.id;
  return r.frame;
}
/** A V1 Shot Clip: animate the canonical Production Frame with the free mock model; optionally approve it. */
async function shotClip(code: string, approve: boolean) {
  const shot = await shotByCode(code);
  const out = await submitCandidateSet({
    data: await data(),
    shotId: shot.id,
    registry: h.registry,
    config: h.config,
    generation: h.repo.generation,
    candidates: h.repo.candidates,
    selections: [{ provider: "mock", modelId: "mock-video-1" }],
    acknowledgeAll: true,
    confirmedTotalUsd: null,
    title: "clips",
    purpose: "",
    userId: null,
    projectRevision: null,
    generationPurpose: "animate_production_frame",
    now: h.clock.now,
  });
  expect(out.submitted).toBe(1);
  await drain();
  const attempt = (await data()).attempts
    .filter((a) => a.shotId === shot.id)
    .sort((a, b) => b.attemptNumber - a.attemptNumber)[0]!;
  expect(attempt.status).toBe("succeeded");
  const view = (await h.repo.generation.getAttemptView(attempt.id))!;
  if (approve)
    await h.repo.generation.reviewAttempt(attempt.id, {
      status: "approved",
      categories: [],
      reason: "",
      notes: "",
      now: h.clock.now.toISOString(),
    });
  return { attemptId: attempt.id, assetId: view.outputs[0]!.asset.id };
}

beforeAll(async () => {
  h = makeHarness();
  globalThis.__prismMemoryRepo = h.repo;
  fetchSpy = vi.spyOn(globalThis, "fetch");
  const d = await raw();
  const base = d.shots.find((s) => s.shotCode === "3A")!;
  // Scene 3: 3A, 3B, 3C (+ 3D with no picture at all), every one 16:9 with a 5 s plan (3C: 3 s)
  for (const [code, order] of [
    ["3B", 1],
    ["3C", 2],
    ["3D", 3],
  ] as const)
    await h.repo.upsert(d.project.id, "shots", {
      ...structuredClone(base),
      id: randomUUID(),
      shotCode: code,
      order,
      title: `${code} coverage`,
    });
  for (const code of ["3A", "3B", "3C", "3D"]) {
    const s = (await raw()).shots.find((x) => x.shotCode === code)!;
    await h.repo.upsert(d.project.id, "shots", {
      ...s,
      composition: { ...s.composition, aspectRatio: "16:9" },
      durationMode: "manual",
      targetDurationMs: code === "3C" ? 3000 : 5000,
      generation: { ...s.generation, startFrameAssetId: null },
      updatedAt: new Date(h.clock.now.getTime() - 5000).toISOString(),
    });
  }
  for (const code of ["3A", "3B", "3C"]) await frame(code, `${code} v1`);
  clipOf["3A"] = await shotClip("3A", true);
  clipOf["3B"] = await shotClip("3B", true);
  clipOf["3B-unselected"] = await shotClip("3B", false); // a newer, unselected candidate
  const p = await loadEpisodeEditPage(await data(), d.episodes[0]!.id);
  if (p.state !== "proposal") throw new Error("expected a proposal");
  const created = await createEpisodeEdit(
    form({ projectSlug: SLUG, episodeId: d.episodes[0]!.id, proposalKey: p.key }),
  );
  if (!created.ok) throw new Error(created.error);
  const all = await raw();
  checksumsBefore = new Map(all.assets.map((a) => [a.id, a.checksum ?? ""]));
}, 120_000);

afterAll(() => {
  expect(fetchSpy).not.toHaveBeenCalled(); // zero external calls
  fetchSpy.mockRestore();
});

describe("5B-V2 Episode Sequence + Animatic (Ojou-sama, mock Shot Clips)", () => {
  it("the Sequence is created from the Episode's Shots in story order (Scene, then Shot), across Scenes", async () => {
    const d = await data();
    const e = await edit();
    const shots = d.shots.filter((s) => s.episodeId === d.episodes[0]!.id).sort(shotOrder(d));
    expect(e.items.map((i) => i.shotId)).toEqual(shots.map((s) => s.id));
    const codes = await codesOf(e);
    expect(codes.filter((c) => c.startsWith("3"))).toEqual(["3A", "3B", "3C", "3D"]);
    // more than one Scene, in Scene order
    const scenesInOrder = e.items.map(
      (i) => d.scenes.find((s) => s.id === d.shots.find((x) => x.id === i.shotId)!.sceneId)!.order,
    );
    expect(new Set(scenesInOrder).size).toBeGreaterThan(1);
    expect([...scenesInOrder].sort((a, b) => a - b)).toEqual(scenesInOrder);
    expect(isStoryOrder(d, e)).toBe(true);
  });

  it("media priority: selected Shot Clip, else canonical Production Frame, else Missing media; never an unselected candidate", async () => {
    const a = await itemOf("3A");
    const b = await itemOf("3B");
    expect(a.visual).toMatchObject({
      kind: "video",
      attemptId: clipOf["3A"]!.attemptId,
      assetId: clipOf["3A"]!.assetId,
    });
    expect(b.visual).toMatchObject({ kind: "video", attemptId: clipOf["3B"]!.attemptId }); // not the newer unselected one
    expect((await itemOf("3C")).visual).toMatchObject({
      kind: "production_frame",
      productionFrameId: frameOf["3C"],
    });
    // 3D has no clip, no canonical frame and no Storyboard: it stays in the cut as Missing media
    expect((await itemOf("3D")).visual).toMatchObject({ kind: "none", durationMs: 5000 });
    expect((await rowOf("3D")).picture.kind).toBe("none");
    expect((await rowOf("3A")).picture.kind).toBe("video");
    expect(SEQUENCE_MEDIA_LABEL.video).toBe("Shot Clip");
    expect(SEQUENCE_MEDIA_LABEL.none).toBe("Missing media");
  });

  it("durations: a clip plays its real length (within the Shot's plan); a still holds editorially, never touching the Shot", async () => {
    const asset = (await raw()).assets.find((x) => x.id === clipOf["3A"]!.assetId)!;
    const a = (await itemOf("3A")).visual as { sourceInMs: number; sourceOutMs: number };
    expect(a.sourceInMs).toBe(0);
    expect(a.sourceOutMs).toBe(Math.min(asset.durationMs!, 5000));
    expect((await itemOf("3C")).visual).toMatchObject({ durationMs: 3000 }); // the Shot's intended duration
    expect(await act(setEditItemHold, "3C", { duration: "4.5" })).toMatchObject({ ok: true });
    expect((await itemOf("3C")).visual).toMatchObject({ durationMs: 4500 });
    expect((await shotByCode("3C")).targetDurationMs).toBe(3000); // the Shot's own duration is untouched
  });

  it("reorder 3B / 3C and across a Scene boundary; Shot structure never changes; reset to story order", async () => {
    const before = (await data()).shots.map((s) => [s.id, s.sceneId, s.order, s.shotCode].join());
    expect(await act(moveEditItem, "3C", { direction: "up" })).toMatchObject({ ok: true });
    const codes = (await codesOf(await edit())).filter((c) => c.startsWith("3"));
    expect(codes).toEqual(["3A", "3C", "3B", "3D"]);
    // move 3A up past the last Shot of the previous Scene
    expect(await act(moveEditItem, "3A", { direction: "up" })).toMatchObject({ ok: true });
    const d = await data();
    const order = await codesOf(await edit());
    const at = order.indexOf("3A");
    const prev = d.shots.find((s) => s.shotCode === order[at + 1])!;
    expect(prev.shotCode).not.toMatch(/^3/); // 3A now sits before a Shot of another Scene
    expect(d.shots.find((s) => s.shotCode === "3A")!.sceneId).toBe(
      d.shots.find((s) => s.shotCode === "3B")!.sceneId,
    );
    expect(d.shots.map((s) => [s.id, s.sceneId, s.order, s.shotCode].join())).toEqual(before);
    expect((await page()).inStoryOrder).toBe(false);
    // reset
    expect(await act(resetEditToStoryOrder, null)).toMatchObject({
      ok: true,
      message: "Back in story order.",
    });
    const reset = await edit();
    expect(reset.items.map((i) => i.id)).toEqual(storyOrderIds(await data(), reset));
    expect((await codesOf(reset)).filter((c) => c.startsWith("3"))).toEqual(["3A", "3B", "3C", "3D"]);
    expect(await act(resetEditToStoryOrder, null)).toMatchObject({
      ok: false,
      error: "The Sequence is already in story order.",
    });
  });

  it("a stale selected Shot Clip keeps playing, with Needs review", async () => {
    const s = await shotByCode("3B");
    await h.repo.upsert(s.projectId, "shots", {
      ...s,
      lighting: { ...s.lighting, mood: "Tense" },
      updatedAt: h.clock.now.toISOString(),
    });
    const row = await rowOf("3B");
    expect(row.badges.map((b) => b.label)).toContain("Needs review");
    const item = (await page()).playback.plan.items.find((i) => i.shotId === s.id)!;
    expect(item).toMatchObject({ kind: "video" });
    expect(item.pictureUrl).toMatch(/^\/api\/assets\//);
    expect((await itemOf("3B")).visual).toMatchObject({ attemptId: clipOf["3B"]!.attemptId }); // never removed / replaced
  });

  it("replacement policy: a new selected Shot Clip or canonical Production Frame is surfaced, then pinned by one explicit action", async () => {
    // 3A: clip B becomes the selected Shot Clip (approval moves); the Sequence keeps clip A until told otherwise
    h.clock.advance(5000);
    const clipB = await shotClip("3A", true);
    expect((await itemOf("3A")).visual).toMatchObject({ attemptId: clipOf["3A"]!.attemptId });
    expect((await rowOf("3A")).badges.map((b) => b.label)).toContain("Replacement available");
    // 3C: a new canonical Production Frame; the still keeps v1 until told otherwise
    await frame("3C", "3C v2");
    expect((await itemOf("3C")).visual).not.toMatchObject({ productionFrameId: frameOf["3C"] });
    expect((await rowOf("3C")).badges.map((b) => b.label)).toContain("Newer Production Frame selected");
    expect((await page()).currentMediaChanges).toBeGreaterThanOrEqual(2);
    const rev = (await edit()).revision;
    expect(await act(useCurrentShotMedia, null)).toMatchObject({ ok: true });
    expect((await edit()).revision).toBe(rev + 1); // one revision
    expect((await itemOf("3A")).visual).toMatchObject({
      kind: "video",
      attemptId: clipB.attemptId,
      assetId: clipB.assetId,
    });
    expect((await itemOf("3C")).visual).toMatchObject({
      kind: "production_frame",
      productionFrameId: frameOf["3C"],
      durationMs: 4500,
    });
    expect((await page()).currentMediaChanges).toBe(0);
    expect(await act(useCurrentShotMedia, null)).toMatchObject({
      ok: false,
      error: "Every item already uses its Shot's current media.",
    });
    // the earlier clip and frame are history, untouched
    expect((await raw()).attempts.find((a) => a.id === clipOf["3A"]!.attemptId)).toMatchObject({
      status: "succeeded",
      approved: false,
    });
  });

  it("source media are immutable; the Animatic plays the Sequence's order, clips as video and stills as frames", async () => {
    const all = await raw();
    for (const [id, sum] of checksumsBefore)
      expect(all.assets.find((a) => a.id === id)?.checksum ?? "").toBe(sum);
    const e = await edit();
    const plan = (await page()).playback.plan;
    expect(plan.items.map((i) => i.itemId)).toEqual(e.items.map((i) => i.id));
    const code = (shotId: string) => all.shots.find((s) => s.id === shotId)!.shotCode;
    const three = plan.items.filter((i) => ["3A", "3B", "3C"].includes(code(i.shotId)));
    expect(three.map((i) => [code(i.shotId), i.kind])).toEqual([
      ["3A", "video"],
      ["3B", "video"],
      ["3C", "production_frame"],
    ]);
    // contiguous timeline from 0 to the total
    expect(plan.items[0]!.startMs).toBe(0);
    for (let i = 1; i < plan.items.length; i++) expect(plan.items[i]!.startMs).toBe(plan.items[i - 1]!.endMs);
    expect(plan.totalMs).toBe(plan.items.at(-1)!.endMs);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { editPage } from "@/components/views/episode-edit-model";
import { newUploadAsset } from "@/domain/__tests__/production-frame-fixtures";
import { buildShotContext } from "@/domain/context";
import type { EpisodeEdit } from "@/domain/edit/model";
import { buildRenderManifest, manifestFingerprint, manifestJson } from "@/domain/edit/render-manifest";
import { editStateFingerprint } from "@/domain/edit/revision";
import { editTimeline } from "@/domain/edit/timeline";
import { draftProductionFrame } from "@/domain/production-frame";
import type { ProjectData } from "@/domain/schemas";
import { submitCandidateSet } from "@/generation/candidate-set";
import { makeHarness, type Harness } from "@/generation/__tests__/helpers";
import type { ActionResult } from "../action-result";
import {
  createEpisodeEdit,
  moveEditItem,
  removeEditTitle,
  resetEditToStoryOrder,
  restoreEditRevision,
  saveEditRevision,
  setEditItemHold,
  setEditItemTransition,
  setEditTitle,
  trimEditItem,
  useCurrentShotMedia,
} from "../episode-edit-actions";
import { loadEditMediaFacts } from "../episode-edit-media";
import { loadEpisodeEditPage } from "../episode-edit-page";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * Phase 5B-V3: practical Episode editing ON the existing Episode Edit (memory persistence) with REAL mock Shot Clips
 * from the V1 / 2H animation workflow (free mock video models, in-process worker). Ojou-sama: an opening title, 3A and
 * 3B Shot Clips (trimmed), 3C a Production Frame still (re-timed), a Shot of another Scene intercut, one cross
 * dissolve, saved revisions and a restore, and the render manifest. No external call.
 */
process.env.PRISM_STUDIO_INLINE_WORKER = "0";
const SLUG = "ojousama";
const OPENING = "お嬢様、僕と結婚してください。";
const EPISODE_LINE = "Episode 1 — The Arrangement";
let h: Harness;
let fetchSpy: ReturnType<typeof vi.spyOn>;
const clipOf: Record<string, { attemptId: string; assetId: string }> = {};
let checksumsBefore: Map<string, string>;
let assetDurationsBefore: Map<string, number | null>;
let shotsBefore: string;
let framesBefore: string;
let otherCode: string;

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
/** The transition INTO `code` from the item now before it. */
async function dissolveInto(code: string, seconds: string) {
  const e = await edit();
  const item = await itemOf(code);
  const prev = e.items[e.items.findIndex((i) => i.id === item.id) - 1]!;
  return act(setEditItemTransition, code, {
    predecessorId: prev.id,
    transition: "dissolve",
    duration: seconds,
  });
}
const page = async () => {
  const d = await data();
  const e = await edit();
  return editPage(
    d,
    e,
    await loadEditMediaFacts(d, e.episodeId),
    await h.repo.episodeEdits.listRevisions(d.project.id, e.id),
  );
};
const rowOf = async (code: string) => (await page()).rows.find((r) => r.shotCode === code)!;
const revisions = async () => {
  const d = await data();
  return h.repo.episodeEdits.listRevisions(d.project.id, (await edit()).id);
};

async function drain(rounds = 14) {
  for (let i = 0; i < rounds; i++) {
    await h.worker().tick(10);
    h.clock.advance(2000);
  }
}
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
  return (
    await h.repo.productionFrames.create({
      draft: drafted.draft,
      newAsset: asset,
      select: true,
      userId: null,
      now: h.clock.now.toISOString(),
    })
  ).frame;
}
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
const clipLength = async (code: string) =>
  (await raw()).assets.find((a) => a.id === clipOf[code]!.assetId)!.durationMs!;

beforeAll(async () => {
  h = makeHarness();
  globalThis.__prismMemoryRepo = h.repo;
  fetchSpy = vi.spyOn(globalThis, "fetch");
  const d = await raw();
  const base = d.shots.find((s) => s.shotCode === "3A")!;
  for (const [code, order] of [
    ["3B", 1],
    ["3C", 2],
  ] as const)
    await h.repo.upsert(d.project.id, "shots", {
      ...structuredClone(base),
      id: randomUUID(),
      shotCode: code,
      order,
      title: `${code} coverage`,
    });
  for (const code of ["3A", "3B", "3C"]) {
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
  const p = await loadEpisodeEditPage(await data(), d.episodes[0]!.id);
  if (p.state !== "proposal") throw new Error("expected a proposal");
  const created = await createEpisodeEdit(
    form({ projectSlug: SLUG, episodeId: d.episodes[0]!.id, proposalKey: p.key }),
  );
  if (!created.ok) throw new Error(created.error);
  const all = await data();
  checksumsBefore = new Map(all.assets.map((a) => [a.id, a.checksum ?? ""]));
  assetDurationsBefore = new Map(all.assets.map((a) => [a.id, a.durationMs ?? null]));
  shotsBefore = JSON.stringify(
    all.shots.map((s) => [s.id, s.sceneId, s.order, s.shotCode, s.targetDurationMs]),
  );
  framesBefore = JSON.stringify((all.productionFrames ?? []).map((f) => [f.id, f.assetId, f.version]));
  // a Shot of ANOTHER Scene (the last item before Scene 3) to intercut
  const e = await edit();
  const scene3 = all.shots.find((s) => s.shotCode === "3A")!.sceneId;
  const codes = await codesOf(e);
  otherCode = codes[codes.indexOf("3A") - 1]!;
  expect(all.shots.find((s) => s.shotCode === otherCode)!.sceneId).not.toBe(scene3);
}, 120_000);

afterAll(() => {
  expect(fetchSpy).not.toHaveBeenCalled(); // 25. zero external / provider calls
  fetchSpy.mockRestore();
});

describe("5B-V3 Episode Edit (Ojou-sama, mock Shot Clips, memory)", () => {
  it("23 / 24. starts from the V2 rough cut: selected Shot Clips (V1) for 3A / 3B, the Production Frame for 3C", async () => {
    const d = await data();
    for (const code of ["3A", "3B"])
      expect((await itemOf(code)).visual).toMatchObject({
        kind: "video",
        attemptId: clipOf[code]!.attemptId,
        assetId: clipOf[code]!.assetId,
      });
    expect((await itemOf("3C")).visual).toMatchObject({ kind: "production_frame", durationMs: 3000 });
    const approved = d.attempts.filter((a) => a.approved).map((a) => a.id);
    expect(approved).toEqual(expect.arrayContaining([clipOf["3A"]!.attemptId, clipOf["3B"]!.attemptId]));
    expect((await page()).titles.every((t) => !t.exists)).toBe(true); // no title until one is added
  });

  it("1 / 2 / 3 / 4. trim in and out of 3A and 3B; invalid trims are refused; the source clip never changes", async () => {
    const lenA = await clipLength("3A");
    // 3A / 3B carry a placed take at 0.8 s for 2.8 s (the 2I.1 rule keeps it inside the item: ≥ 3.6 s)
    expect(await act(trimEditItem, "3A", { sourceIn: "0.5", sourceOut: "4.5" })).toMatchObject({ ok: true });
    expect((await itemOf("3A")).visual).toMatchObject({ sourceInMs: 500, sourceOutMs: 4500 });
    expect((await rowOf("3A")).durationMs).toBe(4000);
    expect(await act(trimEditItem, "3B", { sourceIn: "0.6", sourceOut: "4.6" })).toMatchObject({ ok: true });
    expect((await itemOf("3B")).visual).toMatchObject({ sourceInMs: 600, sourceOutMs: 4600 });
    // a trim that would cut the placed performance is refused (existing rule, unchanged)
    expect(await act(trimEditItem, "3B", { sourceIn: "0", sourceOut: "3" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("placed performance"),
    });
    // invalid: out ≤ in, past the clip, negative
    const rev = (await edit()).revision;
    expect(await act(trimEditItem, "3A", { sourceIn: "2", sourceOut: "2" })).toMatchObject({ ok: false });
    expect(await act(trimEditItem, "3A", { sourceIn: "3", sourceOut: "1" })).toMatchObject({ ok: false });
    expect(
      await act(trimEditItem, "3A", { sourceIn: "0", sourceOut: String(lenA / 1000 + 1) }),
    ).toMatchObject({ ok: false, error: "The trim lies outside the clip." });
    expect(await act(trimEditItem, "3A", { sourceIn: "-1", sourceOut: "2" })).toMatchObject({ ok: false });
    expect((await edit()).revision).toBe(rev); // nothing written
    // the source clip is untouched: same checksum, same full length
    const a = (await raw()).assets.find((x) => x.id === clipOf["3A"]!.assetId)!;
    expect(a.checksum).toBe(checksumsBefore.get(a.id));
    expect(a.durationMs).toBe(assetDurationsBefore.get(a.id));
  });

  it("5 / 6. a still's hold is the edit's: 3C holds 4.5 s while the Shot's duration and frame stay as they were", async () => {
    expect(await act(setEditItemHold, "3C", { duration: "4.5" })).toMatchObject({ ok: true });
    expect((await itemOf("3C")).visual).toMatchObject({ kind: "production_frame", durationMs: 4500 });
    expect((await shotByCode("3C")).targetDurationMs).toBe(3000);
    const d = await data();
    expect(JSON.stringify((d.productionFrames ?? []).map((f) => [f.id, f.assetId, f.version]))).toBe(
      framesBefore,
    );
    expect(await act(setEditItemHold, "3C", { duration: "0" })).toMatchObject({ ok: false });
  });

  it("13 / 14. an opening title card before Shot 3A; its duration is part of the timeline", async () => {
    const before = editTimeline(await edit()).totalMs;
    expect(
      await act(setEditTitle, null, {
        placement: "opening",
        title: OPENING,
        subtitle: EPISODE_LINE,
        duration: "4",
        style: "film",
      }),
    ).toMatchObject({ ok: true });
    const e = await edit();
    expect(e.titles).toEqual([
      expect.objectContaining({
        placement: "opening",
        title: OPENING,
        subtitle: EPISODE_LINE,
        durationMs: 4000,
      }),
    ]);
    const t = editTimeline(e);
    expect(t.totalMs).toBe(before + 4000);
    expect(t.segments[0]).toMatchObject({ kind: "title", placement: "opening", startMs: 0, endMs: 4000 });
    expect(t.items[0]!.startMs).toBe(4000);
    // the title plays before 3A (and before everything else)
    const plan = (await page()).playback.plan;
    expect(plan.titles[0]).toMatchObject({ title: OPENING, subtitle: EPISODE_LINE, startMs: 0, endMs: 4000 });
    expect(plan.items[0]!.startMs).toBe(4000);
    // refused: empty text, too long a hold
    expect(
      await act(setEditTitle, null, {
        placement: "closing",
        title: " ",
        subtitle: "",
        duration: "3",
        style: "film",
      }),
    ).toMatchObject({ ok: false, error: "A title card needs its title text." });
    expect(
      await act(setEditTitle, null, {
        placement: "closing",
        title: "Fin",
        subtitle: "",
        duration: "60",
        style: "film",
      }),
    ).toMatchObject({ ok: false });
    // a closing card can be added and removed
    expect(
      await act(setEditTitle, null, {
        placement: "closing",
        title: "Fin",
        subtitle: "",
        duration: "2",
        style: "plain",
      }),
    ).toMatchObject({ ok: true });
    expect(editTimeline(await edit()).totalMs).toBe(before + 6000);
    expect(await act(removeEditTitle, null, { placement: "closing" })).toMatchObject({ ok: true });
    expect(editTimeline(await edit()).totalMs).toBe(before + 4000);
  });

  it("7 / 8. reorder and intercut across Scenes: the edit order changes, Scene / Shot ownership never does", async () => {
    // 3C before 3B
    expect(await act(moveEditItem, "3C", { direction: "up" })).toMatchObject({ ok: true });
    // 3B (now after 3C) … and the other Scene's Shot moves INTO Scene 3's run (intercut)
    expect(await act(moveEditItem, otherCode, { direction: "down" })).toMatchObject({ ok: true });
    const codes = await codesOf(await edit());
    const at = codes.indexOf("3A");
    expect(codes.slice(at, at + 4)).toEqual(["3A", otherCode, "3C", "3B"]);
    expect(codes.indexOf("3C")).toBeLessThan(codes.indexOf("3B"));
    expect(
      JSON.stringify(
        (await data()).shots.map((s) => [s.id, s.sceneId, s.order, s.shotCode, s.targetDurationMs]),
      ),
    ).toBe(shotsBefore);
    // the Scene runs show the intercut (Scene 3 occurs twice)
    expect((await page()).summary.runs).toBeGreaterThan((await page()).summary.scenes);
  });

  it("9 / 10 / 11 / 12. Cut (default) and Cross dissolve; an over-long dissolve is refused; the overlap shortens the timeline", async () => {
    // default: every cut is a straight cut
    expect((await rowOf("3B")).transition).toMatchObject({ kind: "cut", label: "Cut" });
    const before = editTimeline(await edit()).totalMs;
    // 3C (4.5 s hold) → 3B (4.0 s trim): at most half of the shorter = 2.0 s; 3 s is refused, nothing written
    const rev = (await edit()).revision;
    expect(await dissolveInto("3B", "3")).toMatchObject({
      ok: false,
      error: expect.stringContaining("at most 2.00 s"),
    });
    expect((await edit()).revision).toBe(rev);
    expect(await dissolveInto("3B", "2")).toMatchObject({ ok: true });
    const cId = (await itemOf("3C")).id;
    expect((await itemOf("3B")).incomingTransition).toMatchObject({
      kind: "dissolve",
      durationMs: 2000,
      fromItemId: cId,
    });
    // a trim that would leave the dissolve longer than half of 3B (3.7 s → max 1.85 s) is refused
    expect(await act(trimEditItem, "3B", { sourceIn: "0.6", sourceOut: "4.3" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Shorten the dissolve first"),
    });
    // a cut is a transition choice too; then the dissolve the Episode keeps (0.75 s)
    expect(
      await act(setEditItemTransition, "3B", { predecessorId: cId, transition: "cut", duration: "" }),
    ).toMatchObject({ ok: true });
    expect((await itemOf("3B")).incomingTransition ?? null).toBeNull();
    expect(editTimeline(await edit()).totalMs).toBe(before);
    expect(await dissolveInto("3B", "0.75")).toMatchObject({ ok: true });
    const t = editTimeline(await edit());
    expect(t.totalMs).toBe(before - 750); // the overlap is subtracted
    const bId = (await itemOf("3B")).id;
    const c = t.items.find((i) => i.item.id === cId)!;
    const b = t.items.find((i) => i.item.id === bId)!;
    expect(b.startMs).toBe(c.endMs - 750);
    expect(b.transitionInMs).toBe(750);
    expect((await rowOf("3B")).transition).toMatchObject({
      kind: "dissolve",
      label: "Cross dissolve 0.75 s",
    });
    // a stale predecessor is refused
    expect(
      await act(setEditItemTransition, "3B", {
        predecessorId: (await itemOf("3A")).id,
        transition: "dissolve",
        duration: "0.5",
      }),
    ).toMatchObject({ ok: false });
    // no source is touched by a transition
    const all = await raw();
    for (const [id, sum] of checksumsBefore)
      expect(all.assets.find((a) => a.id === id)?.checksum ?? "").toBe(sum);
  });

  it("15 / 16. revisions: save A, change, save B; A stays exactly as saved; restore A is a NEW revision", async () => {
    expect(await act(saveEditRevision, null, { label: "A — first cut" })).toMatchObject({
      ok: true,
      message: "Saved as revision 1.",
    });
    expect(await act(saveEditRevision, null, { label: "again" })).toMatchObject({
      ok: false,
      error: "This edit is already saved as the latest revision.",
    });
    const [a] = await revisions();
    const aJson = JSON.stringify(a);
    expect(a!.fingerprint).toBe(editStateFingerprint(await edit()));
    expect((await page()).savedAs).toBe(1);
    // change: 3A trimmed tighter → unsaved; save B
    expect(await act(trimEditItem, "3A", { sourceIn: "0.5", sourceOut: "4.4" })).toMatchObject({ ok: true });
    expect((await page()).savedAs).toBeNull();
    expect(await act(saveEditRevision, null, { label: "B — tighter 3A" })).toMatchObject({ ok: true });
    const list = await revisions();
    expect(list.map((r) => r.number)).toEqual([1, 2]);
    expect(JSON.stringify(list[0])).toBe(aJson); // A is immutable
    expect((await page()).revisions.find((r) => r.current)?.number).toBe(2);
    // restore A: the working edit becomes A's state again, as a new working revision and a new saved revision
    const rev = (await edit()).revision;
    expect(await act(restoreEditRevision, null, { revisionId: a!.id })).toMatchObject({
      ok: true,
      message: "Restored; saved as revision 3.",
    });
    const restored = await edit();
    expect(restored.revision).toBe(rev + 1);
    expect(editStateFingerprint(restored)).toBe(a!.fingerprint);
    expect((await itemOf("3A")).visual).toMatchObject({ sourceInMs: 500, sourceOutMs: 4500 });
    const after = await revisions();
    expect(after.map((r) => r.number)).toEqual([1, 2, 3]);
    expect(after[2]).toMatchObject({ restoredFromId: a!.id, fingerprint: a!.fingerprint });
    expect(JSON.stringify(after[0])).toBe(aJson);
    expect((await page()).savedAs).toBe(3);
  });

  it("20 / 21 / 22. the render manifest is deterministic and is exactly what the preview plays", async () => {
    const d = await data();
    const e = await edit();
    const m1 = buildRenderManifest(d, e);
    const m2 = buildRenderManifest(await data(), await edit());
    expect(manifestJson(m1)).toBe(manifestJson(m2));
    expect(manifestFingerprint(m1)).toBe(manifestFingerprint(m2));
    expect(m1.edit.stateFingerprint).toBe(editStateFingerprint(e));
    expect(m1.target).toMatchObject({ editRate: e.editRate });
    // opening title first, then the Shots in edit order with their media, trims and transitions
    expect(m1.segments[0]).toMatchObject({
      kind: "title",
      text: { title: OPENING, subtitle: EPISODE_LINE },
      durationMs: 4000,
      startMs: 0,
    });
    const shots = m1.segments.filter((s) => s.kind === "shot");
    expect(shots.map((s) => s.itemId)).toEqual(e.items.map((i) => i.id));
    const a = shots.find((s) => s.shotCode === "3A")!;
    expect(a).toMatchObject({
      media: {
        kind: "video",
        assetId: clipOf["3A"]!.assetId,
        checksum: checksumsBefore.get(clipOf["3A"]!.assetId),
      },
      sourceInMs: 500,
      sourceOutMs: 4500,
      durationMs: 4000,
    });
    const c = shots.find((s) => s.shotCode === "3C")!;
    expect(c).toMatchObject({ media: { kind: "production_frame" }, durationMs: 4500, sourceInMs: null });
    expect(c.media.assetId).toBeTruthy();
    expect(c.transitionToNext).toEqual({ kind: "dissolve", durationMs: 750 });
    expect(m1.audio.bed).toBeNull(); // V3b
    // preview = manifest: same order, same starts, same total
    const plan = (await page()).playback.plan;
    expect(plan.items.map((i) => [i.itemId, i.startMs, i.durationMs])).toEqual(
      shots.map((s) => [s.itemId, s.startMs, s.durationMs]),
    );
    expect(plan.totalMs).toBe(m1.totalMs);
    expect((await page()).manifest.totalMs).toBe(m1.totalMs);
    // a change to the edit changes the manifest (and nothing else does)
    expect(await act(setEditItemHold, "3C", { duration: "4" })).toMatchObject({ ok: true });
    expect(manifestFingerprint(buildRenderManifest(await data(), await edit()))).not.toBe(
      manifestFingerprint(m1),
    );
  });

  it("17 / 18 / 19. replacement stays explicit, pinned media is preserved, Needs review is shown and editing still works", async () => {
    // 3B's selected clip goes stale (an upstream lighting change): the row warns, the item keeps playing it
    const s = await shotByCode("3B");
    await h.repo.upsert(s.projectId, "shots", {
      ...s,
      lighting: { ...s.lighting, mood: "Tense" },
      updatedAt: h.clock.now.toISOString(),
    });
    expect((await rowOf("3B")).badges.map((b) => b.label)).toContain("Needs review");
    // a new selected Shot Clip for 3A: surfaced, never applied silently
    h.clock.advance(5000);
    const clipB = await shotClip("3A", true);
    expect((await itemOf("3A")).visual).toMatchObject({
      attemptId: clipOf["3A"]!.attemptId,
      sourceInMs: 500,
    });
    expect((await rowOf("3A")).badges.map((b) => b.label)).toContain("Replacement available");
    // editing still works despite the warnings
    expect(await act(trimEditItem, "3B", { sourceIn: "0.5", sourceOut: "4.5" })).toMatchObject({ ok: true });
    // the creator chooses: one explicit revision, the previous revision preserved
    const saved = await revisions();
    expect(await act(useCurrentShotMedia, null)).toMatchObject({ ok: true });
    expect((await itemOf("3A")).visual).toMatchObject({
      kind: "video",
      attemptId: clipB.attemptId,
      assetId: clipB.assetId,
    });
    expect(await revisions()).toEqual(saved); // saved revisions are never rewritten by an edit
    // revision A still pins the earlier 3A clip
    expect(
      saved[0]!.snapshot.items.some(
        (i) => i.visual.kind === "video" && i.visual.attemptId === clipOf["3A"]!.attemptId,
      ),
    ).toBe(true);
  });

  it("23. V2 compatibility: Reset to story order resets dissolves bound to a changed cut; Sequence lines and badges remain", async () => {
    const before = await edit();
    const bTransition = before.items.find((i) => i.incomingTransition)!;
    expect(await act(resetEditToStoryOrder, null)).toMatchObject({
      ok: true,
      message: "Back in story order.",
    });
    const after = await edit();
    const codes = (await codesOf(after)).filter((c) => /^3[ABC]$/.test(c));
    expect(codes).toEqual(["3A", "3B", "3C"]);
    // 3B's predecessor changed (3C → 3A): its dissolve became a straight cut (never retargeted)
    expect(after.items.find((i) => i.id === bTransition.id)!.incomingTransition ?? null).toBeNull();
    expect((await rowOf("3C")).picture.kind).toBe("production_frame");
    // the opening title survives a reorder
    expect(after.titles?.[0]).toMatchObject({ placement: "opening", title: OPENING });
    // and the source media / Shots / frames are exactly as they were
    const all = await data();
    for (const [id, sum] of checksumsBefore)
      expect(all.assets.find((a) => a.id === id)?.checksum ?? "").toBe(sum);
    expect(
      JSON.stringify(all.shots.map((s) => [s.id, s.sceneId, s.order, s.shotCode, s.targetDurationMs])),
    ).toBe(shotsBefore);
  });
});

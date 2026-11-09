import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newUploadAsset } from "@/domain/__tests__/production-frame-fixtures";
import { buildShotContext } from "@/domain/context";
import type { EpisodeEdit } from "@/domain/edit/model";
import { buildRenderManifest, manifestFingerprint } from "@/domain/edit/render-manifest";
import { draftProductionFrame } from "@/domain/production-frame";
import type { Asset, ProjectData } from "@/domain/schemas";
import { submitCandidateSet } from "@/generation/candidate-set";
import { makeHarness, type Harness } from "@/generation/__tests__/helpers";
import type { OutputSink } from "@/generation/sink";
import { assertPathInProject } from "@/lib/storage-paths";
import { mediaToolEnv } from "@/media/ffmpeg";
import { FfmpegEpisodeRenderer } from "@/render/ffmpeg-renderer";
import { buildRenderPlan } from "@/render/plan";
import type { EpisodeRender } from "@/render/repository";
import { EpisodeRenderWorker, renderOutputAssetId } from "@/render/worker";
import { MediaLab } from "@/render/__tests__/media-checks";
import { ffmpegAvailable, sha256, stillPng, toneWav } from "@/render/__tests__/render-fixtures";
import type { ActionResult } from "../action-result";
import {
  createEpisodeEdit,
  moveEditItem,
  removeEditItem,
  saveEditRevision,
  setEditItemHold,
  setEditItemSource,
  setEditItemTransition,
  setEditTitle,
  trimEditItem,
  addShotToEdit,
} from "../episode-edit-actions";
import { loadEditMediaFacts } from "../episode-edit-media";
import { loadEpisodeEditPage } from "../episode-edit-page";
import { requestEpisodeRender, retryEpisodeRender } from "../episode-render-actions";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * Phase 5B-V4 Ojou-sama FINAL FILM: a real Episode Edit (opening title → 3A trimmed Shot Clip → a Shot of another
 * Scene → 3C Production Frame still → cross dissolve → 3B trimmed Shot Clip → closing title, with a placed take of
 * real audio) rendered by the segmented renderer with REAL ffmpeg into a real MP4, then decoded and checked frame by
 * frame. Free mock video from the existing generation workflow; locally generated stills and tone. No network.
 */
process.env.PRISM_STUDIO_INLINE_WORKER = "0";
process.env.PRISM_STUDIO_RENDER_PRESET = "ultrafast";
const SLUG = "ojousama";
const OPENING = "お嬢様、僕と結婚してください。";
const HAS_FFMPEG = ffmpegAvailable();

let h: Harness;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let lab: MediaLab;
const clipOf: Record<string, { attemptId: string; assetId: string }> = {};
const stillOf: Record<string, Uint8Array> = {};
let otherCode: string;
let toneAsset: Asset;
let checksumsBefore: Map<string, string>;
const execs: string[][] = [];

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
const renders = async (): Promise<EpisodeRender[]> => {
  const d = await data();
  return h.repo.renders.listForEpisode(d.project.id, d.episodes[0]!.id);
};
const worker = (extra: Partial<ConstructorParameters<typeof EpisodeRenderWorker>[0]> = {}) =>
  new EpisodeRenderWorker({
    store: h.repo.renders,
    storage: h.sink,
    storageProvider: "local",
    bucket: null,
    workerId: "test-render-worker",
    renderer: new FfmpegEpisodeRenderer({ onExec: (bin, args) => bin === "ffmpeg" && execs.push(args) }),
    ...extra,
  });

async function drain(rounds = 14) {
  for (let i = 0; i < rounds; i++) {
    await h.worker().tick(10);
    h.clock.advance(2000);
  }
}
/** A REAL still (bytes in storage, real checksum) as the Shot's canonical Production Frame. */
async function frame(code: string, color: string, size: [number, number] = [1600, 900]) {
  const d = await data();
  const shot = d.shots.find((s) => s.shotCode === code)!;
  const bytes = stillPng(color, size[0], size[1]);
  const asset: Asset = {
    ...newUploadAsset(d.project.id, { label: `${code}-frame`, width: size[0], height: size[1] }),
  };
  asset.checksum = sha256(bytes);
  asset.byteSize = bytes.length;
  await h.sink.put(asset.objectPath!, bytes);
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
  stillOf[code] = bytes;
  return r.frame;
}
async function shotClip(code: string) {
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
  const view = (await h.repo.generation.getAttemptView(attempt.id))!;
  await h.repo.generation.reviewAttempt(attempt.id, {
    status: "approved",
    categories: [],
    reason: "",
    notes: "",
    now: h.clock.now.toISOString(),
  });
  return { attemptId: attempt.id, assetId: view.outputs[0]!.asset.id };
}
const bytesOf = async (assetId: string) => {
  const a = (await raw()).assets.find((x) => x.id === assetId)!;
  return (await h.sink.get(a.objectPath!))!;
};

beforeAll(async () => {
  if (!HAS_FFMPEG) return;
  h = makeHarness();
  globalThis.__prismMemoryRepo = h.repo;
  fetchSpy = vi.spyOn(globalThis, "fetch");
  lab = new MediaLab(1920, 804);
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
  await frame("3A", "0x804040");
  await frame("3B", "0x408040");
  await frame("3C", "0x3060c0");
  clipOf["3A"] = await shotClip("3A");
  clipOf["3B"] = await shotClip("3B");
  // a real 2.8 s tone for 3A's placed take (the dialogue the edit already places)
  const tone = toneWav(2800);
  toneAsset = {
    ...newUploadAsset(d.project.id, { label: "take-tone" }),
    type: "audio",
    purpose: "performance_audio",
    mime: "audio/wav",
    name: "take-tone.wav",
    originalFilename: "take-tone.wav",
    width: null,
    height: null,
    durationMs: 2800,
    sampleRate: 48000,
    channels: 1,
    checksum: sha256(tone),
    byteSize: tone.length,
  };
  toneAsset.objectPath = `${d.project.id}/${toneAsset.id}/take-tone.wav`;
  await h.sink.put(toneAsset.objectPath, tone);
  await h.repo.upsert(d.project.id, "assets", toneAsset);

  const p = await loadEpisodeEditPage(await data(), d.episodes[0]!.id);
  if (p.state !== "proposal") throw new Error("expected a proposal");
  const created = await createEpisodeEdit(
    form({ projectSlug: SLUG, episodeId: d.episodes[0]!.id, proposalKey: p.key }),
  );
  if (!created.ok) throw new Error(created.error);
  for (const t of (await data()).takes)
    if ((await itemOf("3A")).performance.some((pl) => pl.takeId === t.id))
      await h.repo.upsert(d.project.id, "takes", { ...t, audioAssetId: toneAsset.id });

  // the Episode cut: keep 3A / 3B / 3C and the Shot of the previous Scene just before 3A; the rest leaves the edit
  const all = await data();
  const codes = (await edit()).items.map((i) => all.shots.find((s) => s.id === i.shotId)!.shotCode);
  otherCode = codes[codes.indexOf("3A") - 1]!;
  for (const code of codes.filter((c) => !["3A", "3B", "3C", otherCode].includes(c)))
    expect(await act(removeEditItem, code)).toMatchObject({ ok: true });
  const otherFrame = await frame(otherCode, "0xc0a030", [1912, 800]); // this Shot is framed 2.39:1
  expect(
    await act(setEditItemSource, otherCode, { source: `production_frame:${otherFrame.id}` }),
  ).toMatchObject({
    ok: true,
  });
  expect(await act(trimEditItem, "3A", { sourceIn: "0.5", sourceOut: "4.5" })).toMatchObject({ ok: true });
  expect(await act(trimEditItem, "3B", { sourceIn: "0.625", sourceOut: "4.625" })).toMatchObject({
    ok: true,
  });
  expect(await act(setEditItemHold, "3C", { duration: "4.5" })).toMatchObject({ ok: true });
  for (const [placement, title, subtitle, duration] of [
    ["opening", OPENING, "Episode 1 — The Arrangement", "4"],
    ["closing", "おわり", "", "2"],
  ] as const)
    expect(
      await act(setEditTitle, null, {
        placement,
        title,
        subtitle,
        duration,
        style: placement === "opening" ? "film" : "plain",
      }),
    ).toMatchObject({ ok: true });
  // intercut: the other Scene's Shot after 3A; 3C before 3B; a 0.75 s cross dissolve 3C → 3B
  expect(await act(moveEditItem, otherCode, { direction: "down" })).toMatchObject({ ok: true });
  expect(await act(moveEditItem, "3C", { direction: "up" })).toMatchObject({ ok: true });
  expect(
    await act(setEditItemTransition, "3B", {
      predecessorId: (await itemOf("3C")).id,
      transition: "dissolve",
      duration: "0.75",
    }),
  ).toMatchObject({ ok: true });
  checksumsBefore = new Map((await raw()).assets.map((a) => [a.id, a.checksum ?? ""]));
}, 180_000);

afterAll(() => {
  if (!HAS_FFMPEG) return;
  expect(fetchSpy).not.toHaveBeenCalled(); // 30. zero external / provider calls
  fetchSpy.mockRestore();
  lab.dispose();
});

describe.skipIf(!HAS_FFMPEG)("5B-V4 Ojou-sama final film (real ffmpeg, mock media)", () => {
  it("1 / 20. refuses an unsaved revision and missing media BEFORE any processing; nothing is queued", async () => {
    expect(await act(requestEpisodeRender, null)).toMatchObject({
      ok: false,
      error: "Save this Edit revision before rendering it.",
    });
    // a Shot with no picture at all joins the cut: a FINAL render fails closed, naming it
    const d = await data();
    const base = d.shots.find((s) => s.shotCode === "3A")!;
    const empty = {
      ...structuredClone(base),
      id: randomUUID(),
      shotCode: "3D",
      order: 3,
      title: "3D coverage",
    };
    await h.repo.upsert(d.project.id, "shots", empty);
    const p = await loadEpisodeEditPage(await data(), d.episodes[0]!.id);
    if (p.state !== "edit") throw new Error("expected the edit");
    const add = p.addable.find((x) => x.shotCode === "3D")!;
    expect(
      await act(addShotToEdit, null, { shotId: add.shotId, itemKey: add.itemKey, position: "end" }),
    ).toMatchObject({ ok: true });
    expect(await act(saveEditRevision, null, { label: "with a gap" })).toMatchObject({ ok: true });
    expect(await act(requestEpisodeRender, null)).toMatchObject({
      ok: false,
      error: "Episode contains 1 item with missing media: 3D.",
    });
    expect(await renders()).toHaveLength(0);
    expect(await act(removeEditItem, "3D")).toMatchObject({ ok: true });
  });

  let first: EpisodeRender;
  let firstManifest: ReturnType<typeof buildRenderManifest>;
  it("2 / 3 / 27. Render freezes the saved revision's manifest; an Edit change DURING the render does not reach it", async () => {
    expect(await act(saveEditRevision, null, { label: "A — first cut" })).toMatchObject({ ok: true });
    const rev = (await edit()).revision;
    firstManifest = buildRenderManifest(await data(), await edit());
    expect(await act(requestEpisodeRender, null)).toMatchObject({ ok: true });
    [first] = await renders();
    expect(first).toMatchObject({ number: 1, status: "queued", editRevision: rev, savedRevisionNumber: 2 });
    expect(first.manifestFingerprint).toBe(manifestFingerprint(firstManifest));
    expect(first.manifest).toEqual(firstManifest);
    expect(first.outputFilename).toBe("ojousama-episode-1-the-arrangement.mp4");
    // while A renders, the creator makes revision B
    const result = await worker({
      afterPlan: async () => {
        expect(
          await act(setEditTitle, null, {
            placement: "opening",
            title: OPENING,
            subtitle: "Episode 1 — The Arrangement",
            duration: "3",
            style: "film",
          }),
        ).toMatchObject({ ok: true });
      },
    }).runOnce();
    expect(result).toMatchObject({ status: "completed" });
    [first] = await renders();
    expect(first.status).toBe("completed");
    expect(first.editRevision).toBe(rev); // labelled A
    expect((await edit()).revision).toBe(rev + 1); // B is the current edit
    expect(first.manifest).toEqual(firstManifest); // nothing mixed
  }, 240_000);

  it("14 / 21 / 22 / 23 / 24 / 25. the final MP4 is real and verified: H.264 1920×804 24 fps, exact frames, AAC", async () => {
    const o = first.output!;
    const plan = buildRenderPlan(firstManifest, first.profile);
    expect(o).toMatchObject({
      videoCodec: "h264",
      audioCodec: "aac",
      width: 1920,
      height: 804,
      frameRate: "24/1",
    });
    expect(o.frames).toBe(firstManifest.totalFrames);
    expect(o.frames).toBe(plan.totalFrames);
    // duration = the V3 canonical timeline within one frame (the documented tolerance)
    expect(Math.abs(o.durationMs - firstManifest.totalMs)).toBeLessThanOrEqual(1000 / 24);
    const asset = (await raw()).assets.find((a) => a.id === o.assetId)!;
    expect(asset).toMatchObject({
      purpose: "episode_render",
      type: "video",
      mime: "video/mp4",
      checksum: o.checksum,
    });
    const bytes = (await h.sink.get(asset.objectPath!))!;
    expect(sha256(bytes)).toBe(o.checksum);
    expect(o.byteSize).toBe(bytes.length);
    // 28. private, inside the project's own storage prefix, served only through the owner-checked asset route
    expect(() => assertPathInProject(asset.objectPath!, asset.projectId)).not.toThrow();
    expect(asset.storageProvider).toBe("local");
    expect(o.fonts.map((f) => f.family)).toContain("Noto Serif JP");
    // a re-probe of the stored bytes agrees
    const file = lab.write(bytes, "mp4");
    const probe = await new FfmpegEpisodeRenderer().probe(lab.dir, file.split(/[\\/]/).pop()!);
    expect(probe).toMatchObject({
      videoCodec: "h264",
      pixFmt: "yuv420p",
      frames: firstManifest.totalFrames,
      audioCodec: "aac",
      sampleRate: 48000,
      channels: 2,
    });
  });

  it("4 / 5 / 6 / 7 / 8 / 9 / 11. pictures: title, trims, still hold, the second Scene in its place, cross dissolve; then the closing title", async () => {
    const o = first.output!;
    const final = lab.write(await bytesOf(o.assetId), "mp4");
    const plan = buildRenderPlan(firstManifest, first.profile);
    const at = (frameIndex: number) => ((frameIndex + 0.5) * 1000) / 24;
    const pieceOf = (pred: (p: (typeof plan.pieces)[number]) => boolean) => plan.pieces.find(pred)!;
    const black = lab.black();
    // 6 / 7. the opening title (Japanese, drawn with the open CJK font) is on screen first: not a black frame
    const title = pieceOf((p) => p.kind === "title" && p.placement === "opening");
    expect(title.startFrame).toBe(0);
    expect(lab.psnr(lab.frameAt(final, at(title.frames / 2)), black)).toBeLessThan(45);
    // 4. the 3A trim: the first 3A frame is source 0.5 s (not 0), the frame 1 s later is source 1.5 s
    const clipFrames = lab.sourceFrames(await bytesOf(clipOf["3A"]!.assetId), "webm", 8);
    const a = pieceOf((p) => p.kind === "body" && p.shotCode === "3A");
    expect(lab.bestMatch(lab.frameAt(final, at(a.startFrame)), clipFrames)).toBe(4); // 0.500 s at 8 fps
    expect(lab.bestMatch(lab.frameAt(final, at(a.startFrame + 24)), clipFrames)).toBe(12); // 1.500 s
    // 11. the Shot of the other Scene follows 3A (intercut), as its Production Frame
    const other = pieceOf((p) => p.kind === "body" && p.shotCode === otherCode);
    expect(other.startFrame).toBe(a.startFrame + a.frames);
    expect(
      lab.psnr(
        lab.frameAt(final, at(other.startFrame + other.frames / 2)),
        lab.normalizedStill(stillOf[otherCode]!),
      ),
    ).toBeGreaterThan(35);
    // 5 / 8. 3C holds its still for 4.5 s (− the dissolve), the dissolve is 0.75 s = 18 frames
    const c = pieceOf((p) => p.kind === "body" && p.shotCode === "3C");
    const t = pieceOf((p) => p.kind === "transition");
    expect(c.frames + t.frames).toBe(4.5 * 24);
    expect(t.frames).toBe(18);
    const still3C = lab.normalizedStill(stillOf["3C"]!);
    expect(lab.psnr(lab.frameAt(final, at(c.startFrame + 1)), still3C)).toBeGreaterThan(35);
    expect(lab.psnr(lab.frameAt(final, at(c.startFrame + c.frames - 1)), still3C)).toBeGreaterThan(35);
    // 9. mid-dissolve = a 50 / 50 mix of the 3C still and 3B's first trimmed frame (source 0.625 s = frame 5)
    const b3B = lab.sourceFrames(await bytesOf(clipOf["3B"]!.assetId), "webm", 8);
    const mid = lab.frameAt(final, ((t.startFrame + 9) * 1000) / 24);
    const blend = lab.blend(still3C, b3B[5]!);
    expect(lab.psnr(mid, blend)).toBeGreaterThan(lab.psnr(mid, still3C));
    expect(lab.psnr(mid, blend)).toBeGreaterThan(lab.psnr(mid, b3B[5]!));
    // after the dissolve: 3B continues its trim (0.625 + 0.75 = 1.375 s = source frame 11)
    const b = pieceOf((p) => p.kind === "body" && p.shotCode === "3B");
    expect(b.startFrame).toBe(t.startFrame + t.frames);
    expect(lab.bestMatch(lab.frameAt(final, at(b.startFrame)), b3B)).toBe(11);
    // the closing title ends the film
    expect(plan.pieces.at(-1)).toMatchObject({ kind: "title", placement: "closing" });
  }, 240_000);

  it("12. audio: every placed take sounds exactly at its manifest position for its length; placeholders are silent", async () => {
    const final = lab.write(await bytesOf(first.output!.assetId), "mp4");
    // the tone take is placed under 3A (and under 3B / 3C, which share 3A's dialogue line); the other Scene's take is a
    // placeholder without an audio file: silence
    const placed = firstManifest.audio.performance.filter((p) => p.assetId === toneAsset.id);
    expect(placed.length).toBeGreaterThanOrEqual(1);
    expect(firstManifest.audio.performance.filter((p) => p.assetId === null).length).toBeGreaterThanOrEqual(
      1,
    );
    // expected sound = the union of the placements (merged when they touch)
    const expected: Array<[number, number]> = [];
    for (const p of [...placed].sort((a, b) => a.startMs - b.startMs)) {
      const iv: [number, number] = [p.startMs, p.startMs + p.takeOutMs - p.takeInMs];
      const last = expected.at(-1);
      if (last && iv[0] <= last[1] + 60) last[1] = Math.max(last[1], iv[1]);
      else expected.push(iv);
    }
    const sound = lab.soundIntervals(final);
    expect(sound).toHaveLength(expected.length);
    sound.forEach(([start, end], i) => {
      expect(Math.abs(start - expected[i]![0])).toBeLessThanOrEqual(1000 / 24 + 10);
      expect(Math.abs(end - expected[i]![1])).toBeLessThanOrEqual(1000 / 24 + 30);
    });
  });

  it("13 / 25. sources are unchanged; the completed render never changes", async () => {
    const all = await raw();
    for (const [id, sum] of checksumsBefore)
      expect(all.assets.find((a) => a.id === id)?.checksum ?? "").toBe(sum);
    for (const id of [clipOf["3A"]!.assetId, clipOf["3B"]!.assetId, toneAsset.id])
      expect(sha256(await bytesOf(id))).toBe(all.assets.find((a) => a.id === id)!.checksum);
    await expect(h.repo.renders.retry(first.projectId, first.id, new Date().toISOString())).rejects.toThrow(
      "Only a failed render can be retried.",
    );
  });

  let second: EpisodeRender;
  it("17 / 19 / 20 / 26. interruption after a segment: failed (no output), retry reuses the valid segment and rebuilds the rest", async () => {
    // revision B (title 3 s, already made during render 1) + a shorter 3C hold
    expect(await act(setEditItemHold, "3C", { duration: "4" })).toMatchObject({ ok: true });
    expect(await act(saveEditRevision, null, { label: "B — tighter" })).toMatchObject({ ok: true });
    expect(await act(requestEpisodeRender, null)).toMatchObject({ ok: true });
    second = (await renders())[1]!;
    expect(second.number).toBe(2);
    let renderedPieces = 0;
    const crash = await worker({
      beforeRenderPiece: () => {
        renderedPieces++;
        if (renderedPieces === 2) throw new Error("simulated crash after one rendered segment");
      },
    }).runOnce();
    expect(crash).toMatchObject({ status: "failed", rendered: 1 });
    second = (await renders())[1]!;
    expect(second).toMatchObject({ status: "failed", output: null });
    expect(second.errorMessage).toContain("simulated crash");
    expect((await raw()).assets.some((a) => a.id === renderOutputAssetId(second.id))).toBe(false);
    // the creator retries: the SAME render, valid segments reused, the failed one rebuilt
    expect(await retryEpisodeRender(form({ projectSlug: SLUG, renderId: second.id }))).toMatchObject({
      ok: true,
    });
    const again = await worker().runOnce();
    expect(again).toMatchObject({ status: "completed", rendered: 1 });
    expect(again!.reused).toBe(second.segmentsTotal - 1);
    second = (await renders())[1]!;
    expect(second).toMatchObject({ status: "completed", attemptCount: 2 });
    expect(await renders()).toHaveLength(2); // no duplicate render record
    expect((await raw()).assets.filter((a) => a.purpose === "episode_render")).toHaveLength(2);
    // both renders remain, each labelled with its own revision
    const [r1, r2] = await renders();
    expect(r1!.output!.checksum).toBe(first.output!.checksum);
    expect([r1!.savedRevisionNumber, r2!.savedRevisionNumber]).toEqual([2, 3]);
    expect(r2!.output!.frames).toBe(r1!.output!.frames - 24 - 12); // title −1 s, 3C −0.5 s
  }, 240_000);

  it("16 / 17 / 18. the same revision again reuses every verified segment; a corrupted cached segment is rebuilt", async () => {
    // corrupt one cached segment of revision B (a Shot body: its key does not depend on the title font)
    const body = buildRenderPlan(second.manifest, second.profile).pieces.find((p) => p.kind === "body")!;
    const entry = (await h.repo.renders.getSegment(second.projectId, body.cacheKey))!;
    expect(entry).toBeTruthy();
    await h.sink.put(entry.videoPath, new Uint8Array([1, 2, 3]));
    expect(await act(requestEpisodeRender, null)).toMatchObject({ ok: true });
    const third = await worker().runOnce();
    expect(third).toMatchObject({ status: "completed", rendered: 1 });
    expect(third!.reused).toBe(second.segmentsTotal - 1);
    const [, r2, r3] = await renders();
    expect(r3!.manifestFingerprint).toBe(r2!.manifestFingerprint);
    expect(r3!.output!.frames).toBe(r2!.output!.frames);
    // the rebuilt segment is the same picture: its record is valid again
    const rebuilt = (await h.repo.renders.getSegment(second.projectId, body.cacheKey))!;
    expect(sha256((await h.sink.get(rebuilt.videoPath))!)).toBe(rebuilt.videoChecksum);
  }, 240_000);

  it("15 / 29. bounded processes (≤ 2 pictures per segment; assembly reads pieces sequentially) and no credential reaches ffmpeg", () => {
    const inputs = (args: string[]) => args.filter((a) => a === "-i").length;
    for (const args of execs) {
      const concat = args.includes("concat");
      if (concat) expect(args.filter((a) => a === "concat").length).toBeLessThanOrEqual(2);
      else expect(inputs(args)).toBeLessThanOrEqual(2 + 16);
      // a picture call never opens more than 2 pictures
      if (args.includes("libx264")) expect(inputs(args)).toBeLessThanOrEqual(2);
    }
    process.env.PRISM_STUDIO_PROVIDER_OPENAI_IMAGE_API_KEY = "sk-test-not-real";
    process.env.RUNWAYML_API_SECRET = "rw-test-not-real";
    const env = mediaToolEnv();
    expect(Object.keys(env).some((k) => /KEY|SECRET|TOKEN|PASSWORD|DB_URL/i.test(k))).toBe(false);
    delete process.env.PRISM_STUDIO_PROVIDER_OPENAI_IMAGE_API_KEY;
    delete process.env.RUNWAYML_API_SECRET;
  });

  it("the Edit page shows the renders: revision labels, newer-revision note, play / download links", async () => {
    const d = await data();
    const p = await loadEpisodeEditPage(d, d.episodes[0]!.id);
    if (p.state !== "edit") throw new Error("expected the edit");
    expect(p.render.renders.map((r) => [r.number, r.status, r.savedRevisionNumber])).toEqual([
      [1, "completed", 2],
      [2, "completed", 3],
      [3, "completed", 3],
    ]);
    expect(p.render.renders[0]!.newerRevisionExists).toBe(true);
    expect(p.render.renders[0]!.output).toMatchObject({
      resolution: "1920×804",
      filename: "ojousama-episode-1-the-arrangement.mp4",
      downloadUrl: expect.stringMatching(/^\/api\/assets\/[0-9a-f-]{36}\?download=1$/),
    });
    expect(p.render).toMatchObject({ missing: [], canRender: true, cost: expect.stringContaining("$0.00") });
    void (await loadEditMediaFacts(d, d.episodes[0]!.id));
  });

  it("closeout: on Storage that never overwrites (hosted), a crash after the final upload and a corrupted cached segment still retry to completion", async () => {
    // hosted Supabase Storage uploads with upsert: false — an existing object is refused, never replaced
    const noOverwrite = {
      name: h.sink.name,
      bucket: h.sink.bucket,
      get: (p: string) => h.sink.get(p),
      remove: (p: string) => h.sink.remove(p),
      put: async (p: string, bytes: Uint8Array) => {
        if (await h.sink.get(p)) throw new Error("Storage upload failed: The resource already exists");
        await h.sink.put(p, bytes);
      },
    } satisfies OutputSink;
    const body = buildRenderPlan(second.manifest, second.profile).pieces.find((p) => p.kind === "body")!;
    const entry = (await h.repo.renders.getSegment(second.projectId, body.cacheKey))!;
    await h.sink.put(entry.videoPath, new Uint8Array([9, 9, 9])); // corrupted leftover at a deterministic path
    expect(await act(requestEpisodeRender, null)).toMatchObject({ ok: true });
    // the worker dies after uploading the final MP4, before the database records it
    const store = Object.create(h.repo.renders) as typeof h.repo.renders;
    store.complete = async () => {
      throw new Error("simulated crash after the final upload");
    };
    const crash = await worker({ storage: noOverwrite, store }).runOnce();
    expect(crash).toMatchObject({ status: "failed", rendered: 1 });
    const fourth = (await renders())[3]!;
    expect(fourth).toMatchObject({ status: "failed", output: null });
    expect(
      await h.sink.get(
        `${fourth.projectId}/${renderOutputAssetId(fourth.id)}/ojousama-episode-1-the-arrangement.mp4`,
      ),
    ).toBeTruthy();
    expect(await retryEpisodeRender(form({ projectSlug: SLUG, renderId: fourth.id }))).toMatchObject({
      ok: true,
    });
    const again = await worker({ storage: noOverwrite }).runOnce();
    expect(again).toMatchObject({ status: "completed", rendered: 0 });
    const done = (await renders())[3]!;
    expect(done).toMatchObject({ status: "completed", attemptCount: 2 });
    expect(done.output!.frames).toBe(second.output!.frames);
    const asset = (await raw()).assets.find((a) => a.id === renderOutputAssetId(fourth.id))!;
    expect(sha256((await h.sink.get(asset.objectPath!))!)).toBe(asset.checksum);
  }, 240_000);
});

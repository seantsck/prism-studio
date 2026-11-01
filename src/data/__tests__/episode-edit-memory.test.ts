import { describe, expect, it } from "vitest";
import { MemoryEpisodeEditService, type MemoryEpisodeEditAccess } from "@/data/episode-edit-memory";
import { EpisodeEditError, type EditOp, type NewEditItem } from "@/data/episode-edit-repository";
import { MemoryRepository } from "@/data/memory-repository";
import { seed } from "@/domain/__tests__/helpers";
import type { AudioPlacement, VisualSource } from "@/domain/edit/model";
import type { ProductionFrame } from "@/domain/production-frame";
import {
  generationAttemptSchema,
  type Asset,
  type GenerationAttempt,
  type ProjectData,
} from "@/domain/schemas";

/**
 * Phase 2I.1B memory persistence of Episode edits: the same semantics as Postgres and migration 0043 (shared op rules
 * in episode-edit-ops.ts). The generation / media / Production Frame facts the source checks read are stubbed here so
 * every case states exactly which clip, output, delivery version and frame exists. No database, provider or Storage.
 */

const uuid = () => crypto.randomUUID();
const NOW = "2026-10-25T00:00:00.000Z";
const RATE = { num: 24, den: 1 };

function world() {
  const data = seed();
  const projectId = data.project.id;
  const episode = data.episodes[0]!;
  const inEpisode = data.shots.filter((s) => s.episodeId === episode.id);
  const frame = data.frames[0]!;
  const shotA = inEpisode.find((s) => s.id === frame.shotId)!; // has a storyboard frame
  const [shotB, shotC] = inEpisode.filter((s) => s.id !== shotA.id);
  // a second Episode with a Shot of its own (an item of the first Episode's edit cannot name it)
  const episode2 = { ...episode, id: uuid(), number: 2, slug: "ep-2", title: "Episode 2" };
  const otherEpisodeShot = { ...shotB!, id: uuid(), episodeId: episode2.id, shotCode: "9Z" };
  data.episodes.push(episode2);
  data.shots.push(otherEpisodeShot);
  // another project of the same owner
  const other: ProjectData = {
    ...structuredClone(data),
    project: { ...data.project, id: uuid(), slug: "other" },
    attempts: [],
    assets: [],
  };

  const outputs = new Map<string, Array<{ assetId: string; role: string; asset: Asset }>>();
  const versions = new Map<string, Array<{ asset: Asset; parentAssetId: string; version: number }>>();
  const deliveries = new Map<string, string>();
  const productionFrames: ProductionFrame[] = [];

  const asset = (p: ProjectData, durationMs: number | null, type: Asset["type"] = "video"): Asset => {
    const a = { ...data.assets[0]!, id: uuid(), projectId: p.project.id, type, durationMs };
    p.assets.push(a);
    return a;
  };
  let n = 0;
  const attempt = (
    p: ProjectData,
    shotId: string,
    o: { purpose?: string | null; status?: GenerationAttempt["status"]; approved?: boolean } = {},
  ): GenerationAttempt => {
    n += 1;
    const a = generationAttemptSchema.parse({
      id: uuid(),
      projectId: p.project.id,
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
      status: o.status ?? "succeeded",
      reviewStatus: o.approved ? "approved" : "unreviewed",
      rejectionReason: "",
      notes: "",
      approved: o.approved ?? false,
      request: o.purpose === null ? null : { purpose: o.purpose ?? "shot_output" },
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    });
    p.attempts.push(a);
    return a;
  };
  /** A clip: an attempt with a primary video output of `durationMs`. */
  const clip = (
    shotId: string,
    o: Parameters<typeof attempt>[2] & { durationMs?: number | null; project?: ProjectData } = {},
  ) => {
    const p = o.project ?? data;
    const a = attempt(p, shotId, o);
    const primary = asset(p, o.durationMs === undefined ? 10_000 : o.durationMs);
    outputs.set(a.id, [{ assetId: primary.id, role: "primary", asset: primary }]);
    return { attempt: a, asset: primary };
  };
  const deliveryVersion = (attemptId: string, parent: Asset, durationMs: number) => {
    const v = asset(data, durationMs);
    versions.set(attemptId, [
      ...(versions.get(attemptId) ?? []),
      { asset: v, parentAssetId: parent.id, version: 1 },
    ]);
    return v;
  };
  const productionFrame = (shotId: string) => {
    const f = { id: uuid(), projectId, shotId } as ProductionFrame;
    productionFrames.push(f);
    return f;
  };

  const take = data.takes.find((t) => !t.archived && t.durationMs >= 3000)!;
  const archivedTake = { ...take, id: uuid(), takeNumber: 99, archived: true, selected: false };
  data.takes.push(archivedTake);

  const projects = [data, other];
  const access: MemoryEpisodeEditAccess = {
    all: () => projects,
    stampOf: () => "2026-10-01T00:00:00.000Z",
    generation: () =>
      ({
        getAttemptView: async (id: string) => ({
          outputs: (outputs.get(id) ?? []).map((o) => ({
            output: { assetId: o.assetId, role: o.role },
            asset: o.asset,
          })),
        }),
      }) as unknown as ReturnType<MemoryEpisodeEditAccess["generation"]>,
    mediaQa: () =>
      ({
        listAttemptDerivations: async (id: string) =>
          (versions.get(id) ?? []).map((v) => ({
            asset: v.asset,
            derivation: {
              slot: "delivery",
              parentAssetId: v.parentAssetId,
              version: v.version,
              attemptId: id,
            },
          })),
        getDelivery: async (id: string) => (deliveries.has(id) ? { assetId: deliveries.get(id) } : null),
      }) as unknown as ReturnType<MemoryEpisodeEditAccess["mediaQa"]>,
    productionFrames: () =>
      ({
        listForProject: async (pid: string) => ({
          frames: productionFrames.filter((f) => f.projectId === pid),
          selections: [],
        }),
      }) as unknown as ReturnType<MemoryEpisodeEditAccess["productionFrames"]>,
  };
  const svc = new MemoryEpisodeEditService(access);

  const none = (durationMs = 3000): VisualSource => ({ kind: "none", durationMs });
  const item = (
    shotId: string,
    visual: VisualSource = none(),
    performance: AudioPlacement[] = [],
  ): NewEditItem => ({
    shotId,
    visual,
    performance,
    performanceBasis: null,
  });
  const placement = (o: Partial<AudioPlacement> = {}): AudioPlacement => ({
    dialogueLineId: take.dialogueLineId,
    takeId: take.id,
    startMs: 0,
    takeInMs: 0,
    takeOutMs: 2000,
    ...o,
  });
  const create = (items: NewEditItem[] = [item(shotA.id), item(shotB!.id)]) =>
    svc.create({ projectId, episodeId: episode.id, editRate: RATE, items, userId: null, now: NOW });
  const apply = (editId: string, expectedRevision: number, ops: EditOp[]) =>
    svc.apply({ editId, projectId, expectedRevision, ops, userId: null, now: NOW });

  return {
    data,
    other,
    projectId,
    episode,
    episode2,
    shotA,
    shotB: shotB!,
    shotC: shotC!,
    otherEpisodeShot,
    frame,
    take,
    archivedTake,
    deliveries,
    svc,
    clip,
    attempt,
    asset,
    deliveryVersion,
    productionFrame,
    none,
    item,
    placement,
    create,
    apply,
  };
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "no error",
    (e: unknown) => (e instanceof EpisodeEditError ? e.code : `other: ${(e as Error).message}`),
  );

describe("Episode edit (memory): identity, one per Episode, explicit order", () => {
  it("creates the Episode's edit at revision 0 with its own stable id, items in the given order", async () => {
    const w = world();
    const edit = await w.create();
    expect(edit.id).not.toBe(w.episode.id);
    expect(edit).toMatchObject({
      projectId: w.projectId,
      episodeId: w.episode.id,
      revision: 0,
      editRate: RATE,
    });
    expect(edit.items.map((i) => i.shotId)).toEqual([w.shotA.id, w.shotB.id]);
    expect(new Set(edit.items.map((i) => i.id)).size).toBe(2);
    expect(edit.items.every((i) => i.sourceAudio === "muted")).toBe(true);
    expect(await w.svc.getForEpisode(w.projectId, w.episode.id)).toEqual(edit);
    expect(await w.svc.get(w.projectId, edit.id)).toEqual(edit);
    expect(await w.svc.listForProject(w.projectId)).toEqual([edit]);
  });

  it("refuses a second edit of the same Episode (conflict) and keeps the first", async () => {
    const w = world();
    const first = await w.create();
    expect(await codeOf(w.create([w.item(w.shotC.id)]))).toBe("conflict");
    expect(await w.svc.listForProject(w.projectId)).toEqual([first]);
  });

  it("refuses an Episode of another project, an unknown Episode and an unsupported edit rate", async () => {
    const w = world();
    const at = (episodeId: string, editRate = RATE) =>
      w.svc.create({ projectId: w.other.project.id, episodeId, editRate, items: [], userId: null, now: NOW });
    expect(await codeOf(at(uuid()))).toBe("not_found");
    w.other.episodes = [];
    expect(await codeOf(at(w.episode.id))).toBe("wrong_project");
    expect(
      await codeOf(
        w.svc.create({
          projectId: w.projectId,
          episodeId: w.episode.id,
          editRate: { num: 23, den: 1 },
          items: [],
          userId: null,
          now: NOW,
        }),
      ),
    ).toBe("invalid");
  });

  it("adds an item at a position, refuses a second item for the same Shot, and a Shot of another Episode", async () => {
    const w = world();
    const e0 = await w.create();
    const e1 = await w.apply(e0.id, 0, [{ op: "add", item: w.item(w.shotC.id), atPosition: 1 }]);
    expect(e1.revision).toBe(1);
    expect(e1.items.map((i) => i.shotId)).toEqual([w.shotA.id, w.shotC.id, w.shotB.id]);
    expect(e1.items[0]!.id).toBe(e0.items[0]!.id); // existing ids are stable
    expect(await codeOf(w.apply(e0.id, 1, [{ op: "add", item: w.item(w.shotA.id), atPosition: 0 }]))).toBe(
      "conflict",
    );
    expect(
      await codeOf(w.apply(e0.id, 1, [{ op: "add", item: w.item(w.otherEpisodeShot.id), atPosition: 0 }])),
    ).toBe("wrong_shot");
    expect(await codeOf(w.apply(e0.id, 1, [{ op: "add", item: w.item(uuid()), atPosition: 0 }]))).toBe(
      "not_found",
    );
    expect(await codeOf(w.apply(e0.id, 1, [{ op: "add", item: w.item(w.shotC.id), atPosition: 9 }]))).toBe(
      "invalid",
    );
    expect((await w.svc.get(w.projectId, e0.id))!.revision).toBe(1);
  });

  it("reorders by the complete id list; a partial or duplicated list is refused", async () => {
    const w = world();
    const e0 = await w.create([w.item(w.shotA.id), w.item(w.shotB.id), w.item(w.shotC.id)]);
    const [a, b, c] = e0.items.map((i) => i.id);
    const e1 = await w.apply(e0.id, 0, [{ op: "reorder", itemIds: [c!, a!, b!] }]);
    expect(e1.items.map((i) => i.id)).toEqual([c, a, b]);
    expect(await codeOf(w.apply(e0.id, 1, [{ op: "reorder", itemIds: [a!, b!] }]))).toBe("invalid");
    expect(await codeOf(w.apply(e0.id, 1, [{ op: "reorder", itemIds: [a!, a!, b!] }]))).toBe("invalid");
  });

  it("removing an item lets the same Shot be added again in the same change (a fresh item id)", async () => {
    const w = world();
    const e0 = await w.create();
    const old = e0.items[0]!.id;
    const e1 = await w.apply(e0.id, 0, [
      { op: "remove", itemId: old },
      { op: "add", item: w.item(w.shotA.id, w.none(5000)), atPosition: 1 },
    ]);
    expect(e1.items.map((i) => i.shotId)).toEqual([w.shotB.id, w.shotA.id]);
    expect(e1.items[1]!.id).not.toBe(old);
  });
});

describe("Episode edit (memory): picture sources", () => {
  it("pins an exact clip interval (attempt + primary output) and a delivery version of it", async () => {
    const w = world();
    const { attempt, asset } = w.clip(w.shotA.id);
    const version = w.deliveryVersion(attempt.id, asset, 8000);
    const e0 = await w.create([
      w.item(w.shotA.id, {
        kind: "video",
        attemptId: attempt.id,
        assetId: asset.id,
        sourceInMs: 500,
        sourceOutMs: 4500,
      }),
    ]);
    expect(e0.items[0]!.visual).toEqual({
      kind: "video",
      attemptId: attempt.id,
      assetId: asset.id,
      sourceInMs: 500,
      sourceOutMs: 4500,
    });
    const e1 = await w.apply(e0.id, 0, [
      {
        op: "set_visual",
        itemId: e0.items[0]!.id,
        visual: {
          kind: "video",
          attemptId: attempt.id,
          assetId: version.id,
          sourceInMs: 0,
          sourceOutMs: 8000,
        },
      },
    ]);
    expect(e1.items[0]!.visual).toMatchObject({ assetId: version.id, sourceOutMs: 8000 });
  });

  it("refuses non-placeable clips: Production Frame purpose, not succeeded, another Shot, another project, a foreign Asset", async () => {
    const w = world();
    const e0 = await w.create();
    const itemId = e0.items[0]!.id;
    const video = (attemptId: string, assetId: string, sourceOutMs = 1000): EditOp => ({
      op: "set_visual",
      itemId,
      visual: { kind: "video", attemptId, assetId, sourceInMs: 0, sourceOutMs },
    });
    const frameCandidate = w.clip(w.shotA.id, { purpose: "production_frame" });
    const running = w.clip(w.shotA.id, { status: "running" });
    const ofShotB = w.clip(w.shotB.id);
    const foreign = w.clip(w.shotA.id, { project: w.other });
    const mine = w.clip(w.shotA.id);
    const unrelated = w.asset(w.data, 9000);
    const image = w.asset(w.data, null, "image");
    expect(await codeOf(w.apply(e0.id, 0, [video(frameCandidate.attempt.id, frameCandidate.asset.id)]))).toBe(
      "invalid_source",
    );
    expect(await codeOf(w.apply(e0.id, 0, [video(running.attempt.id, running.asset.id)]))).toBe(
      "invalid_source",
    );
    expect(await codeOf(w.apply(e0.id, 0, [video(ofShotB.attempt.id, ofShotB.asset.id)]))).toBe("wrong_shot");
    expect(await codeOf(w.apply(e0.id, 0, [video(foreign.attempt.id, foreign.asset.id)]))).toBe(
      "wrong_project",
    );
    // the Asset is a real video of this project, but not an output or delivery version of THIS attempt
    expect(await codeOf(w.apply(e0.id, 0, [video(mine.attempt.id, unrelated.id)]))).toBe("invalid_source");
    expect(await codeOf(w.apply(e0.id, 0, [video(mine.attempt.id, ofShotB.asset.id)]))).toBe(
      "invalid_source",
    );
    expect(await codeOf(w.apply(e0.id, 0, [video(mine.attempt.id, image.id)]))).toBe("invalid_source");
    expect(await codeOf(w.apply(e0.id, 0, [video(uuid(), mine.asset.id)]))).toBe("not_found");
    expect((await w.svc.get(w.projectId, e0.id))!).toEqual(e0); // nothing changed, revision 0
    // purpose-less history and the animation purpose are Shot outputs (the existing classifier)
    const legacy = w.clip(w.shotA.id, { purpose: null });
    const animation = w.clip(w.shotA.id, { purpose: "animate_production_frame" });
    const unknown = w.clip(w.shotA.id, { purpose: "something_new" });
    let rev = 0;
    for (const c of [legacy, animation, unknown])
      rev = (await w.apply(e0.id, rev, [video(c.attempt.id, c.asset.id)])).revision;
    expect(rev).toBe(3);
  });

  it("trims inside the clip; outside its duration, an unknown duration, or a trim of a still is refused", async () => {
    const w = world();
    const { attempt, asset } = w.clip(w.shotA.id, { durationMs: 6000 });
    const unprobed = w.clip(w.shotA.id, { durationMs: null });
    const e0 = await w.create([
      w.item(w.shotA.id, {
        kind: "video",
        attemptId: attempt.id,
        assetId: asset.id,
        sourceInMs: 0,
        sourceOutMs: 6000,
      }),
      w.item(w.shotB.id),
    ]);
    const [clipItem, still] = e0.items.map((i) => i.id);
    const e1 = await w.apply(e0.id, 0, [
      { op: "trim", itemId: clipItem!, sourceInMs: 1000, sourceOutMs: 5000 },
    ]);
    expect(e1.items[0]!.visual).toMatchObject({ sourceInMs: 1000, sourceOutMs: 5000 });
    expect(
      await codeOf(w.apply(e0.id, 1, [{ op: "trim", itemId: clipItem!, sourceInMs: 0, sourceOutMs: 6001 }])),
    ).toBe("invalid_source");
    expect(
      await codeOf(
        w.apply(e0.id, 1, [{ op: "trim", itemId: clipItem!, sourceInMs: 3000, sourceOutMs: 3000 }]),
      ),
    ).toBe("invalid");
    expect(
      await codeOf(
        w.apply(e0.id, 1, [{ op: "trim", itemId: clipItem!, sourceInMs: 0.5, sourceOutMs: 3000 }]),
      ),
    ).toBe("invalid");
    expect(
      await codeOf(w.apply(e0.id, 1, [{ op: "trim", itemId: still!, sourceInMs: 0, sourceOutMs: 1000 }])),
    ).toBe("invalid");
    expect(
      await codeOf(
        w.apply(e0.id, 1, [
          {
            op: "set_visual",
            itemId: clipItem!,
            visual: {
              kind: "video",
              attemptId: unprobed.attempt.id,
              assetId: unprobed.asset.id,
              sourceInMs: 0,
              sourceOutMs: 10,
            },
          },
        ]),
      ),
    ).toBe("invalid_source");
    const e2 = await w.apply(e0.id, 1, [{ op: "set_hold", itemId: still!, durationMs: 4200 }]);
    expect(e2.items[1]!.visual).toEqual({ kind: "none", durationMs: 4200 });
    expect(await codeOf(w.apply(e0.id, 2, [{ op: "set_hold", itemId: clipItem!, durationMs: 4200 }]))).toBe(
      "invalid",
    );
  });

  it("accepts every placeholder kind for frames of its own Shot; a frame of another Shot is refused", async () => {
    const w = world();
    const pf = w.productionFrame(w.shotA.id);
    const pfOfB = w.productionFrame(w.shotB.id);
    const e0 = await w.create([
      w.item(w.shotA.id, { kind: "production_frame", productionFrameId: pf.id, durationMs: 2000 }),
      w.item(w.shotB.id, w.none(1500)),
    ]);
    expect(e0.items[0]!.visual.kind).toBe("production_frame");
    const e1 = await w.apply(e0.id, 0, [
      {
        op: "set_visual",
        itemId: e0.items[0]!.id,
        visual: { kind: "storyboard_frame", storyboardFrameId: w.frame.id, durationMs: 2500 },
      },
    ]);
    expect(e1.items[0]!.visual).toEqual({
      kind: "storyboard_frame",
      storyboardFrameId: w.frame.id,
      durationMs: 2500,
    });
    const wrong = (visual: VisualSource) =>
      w.apply(e0.id, 1, [{ op: "set_visual", itemId: e0.items[1]!.id, visual }]);
    expect(
      await codeOf(wrong({ kind: "storyboard_frame", storyboardFrameId: w.frame.id, durationMs: 1000 })),
    ).toBe("wrong_shot");
    expect(
      await codeOf(wrong({ kind: "production_frame", productionFrameId: pf.id, durationMs: 1000 })),
    ).toBe("wrong_shot");
    expect(
      await codeOf(wrong({ kind: "production_frame", productionFrameId: uuid(), durationMs: 1000 })),
    ).toBe("not_found");
    expect(
      await codeOf(wrong({ kind: "production_frame", productionFrameId: pfOfB.id, durationMs: 0 })),
    ).toBe("invalid");
  });

  it("holds an existing placeholder longer or shorter (its frame is re-checked, not lost)", async () => {
    const w = world();
    const pf = w.productionFrame(w.shotB.id);
    const e0 = await w.create([
      w.item(w.shotA.id, { kind: "storyboard_frame", storyboardFrameId: w.frame.id, durationMs: 2000 }),
      w.item(w.shotB.id, { kind: "production_frame", productionFrameId: pf.id, durationMs: 2000 }),
    ]);
    const [still, frame] = e0.items.map((i) => i.id);
    const e1 = await w.apply(e0.id, 0, [
      { op: "set_hold", itemId: still!, durationMs: 2600 },
      { op: "set_hold", itemId: frame!, durationMs: 1800 },
    ]);
    expect(e1.revision).toBe(1);
    expect(e1.items.map((i) => i.visual)).toEqual([
      { kind: "storyboard_frame", storyboardFrameId: w.frame.id, durationMs: 2600 },
      { kind: "production_frame", productionFrameId: pf.id, durationMs: 1800 },
    ]);
  });

  it("stores exactly the fields of the kind; an unknown or mixed picture is refused or reduced to its kind", async () => {
    const w = world();
    const e0 = await w.create();
    const mixed = {
      kind: "none",
      durationMs: 2000,
      attemptId: uuid(),
      storyboardFrameId: w.frame.id,
    } as VisualSource;
    const e1 = await w.apply(e0.id, 0, [{ op: "set_visual", itemId: e0.items[0]!.id, visual: mixed }]);
    expect(e1.items[0]!.visual).toEqual({ kind: "none", durationMs: 2000 });
    const unknown = { kind: "hologram", durationMs: 2000 } as unknown as VisualSource;
    expect(
      await codeOf(w.apply(e0.id, 1, [{ op: "set_visual", itemId: e0.items[0]!.id, visual: unknown }])),
    ).toBe("invalid");
  });

  it("uses the reported replacement only while it is exactly what the caller saw", async () => {
    const w = world();
    const pinned = w.clip(w.shotA.id, { durationMs: 9000 });
    const e0 = await w.create([
      w.item(w.shotA.id, {
        kind: "video",
        attemptId: pinned.attempt.id,
        assetId: pinned.asset.id,
        sourceInMs: 0,
        sourceOutMs: 7000,
      }),
    ]);
    const itemId = e0.items[0]!.id;
    const use = (rev: number, attemptId: string, assetId: string) =>
      w.apply(e0.id, rev, [{ op: "use_replacement", itemId, expected: { attemptId, assetId } }]);
    expect(await codeOf(use(0, pinned.attempt.id, pinned.asset.id))).toBe("invalid"); // nothing approved yet
    const approved = w.clip(w.shotA.id, { approved: true, durationMs: 5000 });
    expect(await codeOf(use(0, pinned.attempt.id, pinned.asset.id))).toBe("conflict"); // not what is reported now
    const e1 = await use(0, approved.attempt.id, approved.asset.id);
    // the trim keeps the item's 7000 ms when it can; the new clip has 5000
    expect(e1.items[0]!.visual).toEqual({
      kind: "video",
      attemptId: approved.attempt.id,
      assetId: approved.asset.id,
      sourceInMs: 0,
      sourceOutMs: 5000,
    });
    // a delivery master selected later is the next replacement
    const master = w.deliveryVersion(approved.attempt.id, approved.asset, 4000);
    w.deliveries.set(approved.attempt.id, master.id);
    expect(await codeOf(use(1, approved.attempt.id, approved.asset.id))).toBe("conflict");
    expect((await use(1, approved.attempt.id, master.id)).items[0]!.visual).toMatchObject({
      assetId: master.id,
      sourceOutMs: 4000,
    });
    expect(await codeOf(use(2, approved.attempt.id, master.id))).toBe("invalid"); // already shows it
  });
});

describe("Episode edit (memory): performance placements", () => {
  it("places a take inside its item; outside the item, beyond the take, a wrong line or an archived take is refused", async () => {
    const w = world();
    const e0 = await w.create([
      w.item(w.shotA.id, w.none(3000), [w.placement({ startMs: 500, takeOutMs: 2000 })]),
    ]);
    expect(e0.items[0]!.performance).toEqual([w.placement({ startMs: 500, takeOutMs: 2000 })]);
    const itemId = e0.items[0]!.id;
    const set = (placements: AudioPlacement[]) =>
      w.apply(e0.id, 0, [
        { op: "set_performance", itemId, placements, performanceBasis: { performance: "p", timing: "t" } },
      ]);
    expect(await codeOf(set([w.placement({ startMs: 1500, takeOutMs: 2000 })]))).toBe("invalid"); // 1500 + 2000 > 3000
    expect(await codeOf(set([w.placement({ startMs: -1 })]))).toBe("invalid"); // a J-cut is not allowed in 2I.1
    expect(await codeOf(set([w.placement({ takeOutMs: w.take.durationMs + 1 })]))).toBe("invalid");
    expect(await codeOf(set([w.placement({ dialogueLineId: uuid() })]))).toBe("invalid");
    expect(await codeOf(set([w.placement({ takeId: uuid() })]))).toBe("not_found");
    expect(await codeOf(set([w.placement({ takeId: w.archivedTake.id })]))).toBe("invalid");
    expect(await codeOf(set([w.placement(), w.placement({ startMs: 100 })]))).toBe("invalid"); // a line placed twice
    const e1 = await set([w.placement({ startMs: 1000 })]);
    expect(e1.items[0]!.performanceBasis).toEqual({ performance: "p", timing: "t" });
  });

  it("explicit silence: clear_performance and an empty set_performance remove every placement", async () => {
    const w = world();
    const e0 = await w.create([
      w.item(w.shotA.id, w.none(3000), [w.placement()]),
      w.item(w.shotB.id, w.none(3000), [w.placement()]),
    ]);
    const e1 = await w.apply(e0.id, 0, [
      { op: "clear_performance", itemId: e0.items[0]!.id },
      { op: "set_performance", itemId: e0.items[1]!.id, placements: [], performanceBasis: null },
    ]);
    expect(e1.items.map((i) => i.performance)).toEqual([[], []]);
  });

  it("a trim or hold that would cut a placed performance is refused; the clip's own audio can be included", async () => {
    const w = world();
    const { attempt, asset } = w.clip(w.shotA.id);
    const e0 = await w.create([
      w.item(
        w.shotA.id,
        { kind: "video", attemptId: attempt.id, assetId: asset.id, sourceInMs: 0, sourceOutMs: 4000 },
        [w.placement({ startMs: 1000, takeOutMs: 2500 })],
      ),
      w.item(w.shotB.id, w.none(3000), [w.placement({ startMs: 0, takeOutMs: 3000 })]),
    ]);
    const [clipItem, still] = e0.items.map((i) => i.id);
    expect(
      await codeOf(
        w.apply(e0.id, 0, [{ op: "trim", itemId: clipItem!, sourceInMs: 1000, sourceOutMs: 4000 }]),
      ),
    ).toBe("invalid");
    expect(await codeOf(w.apply(e0.id, 0, [{ op: "set_hold", itemId: still!, durationMs: 2999 }]))).toBe(
      "invalid",
    );
    // moving the picture's in-point does not move the audio: allowed while the placement still fits
    const e1 = await w.apply(e0.id, 0, [
      { op: "trim", itemId: clipItem!, sourceInMs: 500, sourceOutMs: 4000 },
      { op: "set_source_audio", itemId: clipItem!, sourceAudio: "included" },
    ]);
    expect(e1.items[0]).toMatchObject({
      sourceAudio: "included",
      performance: [w.placement({ startMs: 1000, takeOutMs: 2500 })],
    });
  });
});

describe("Episode edit (memory): revision / optimistic concurrency", () => {
  it("a stale expectedRevision is refused and writes nothing", async () => {
    const w = world();
    const e0 = await w.create();
    await w.apply(e0.id, 0, [{ op: "set_hold", itemId: e0.items[0]!.id, durationMs: 1234 }]);
    const before = await w.svc.get(w.projectId, e0.id);
    expect(
      await codeOf(w.apply(e0.id, 0, [{ op: "set_hold", itemId: e0.items[0]!.id, durationMs: 999 }])),
    ).toBe("conflict");
    expect(await w.svc.get(w.projectId, e0.id)).toEqual(before);
  });

  it("a successful mutation (any number of ops) bumps the revision exactly once; a refused one not at all", async () => {
    const w = world();
    const e0 = await w.create();
    const [a, b] = e0.items.map((i) => i.id);
    const e1 = await w.apply(e0.id, 0, [
      { op: "set_hold", itemId: a!, durationMs: 1000 },
      { op: "set_hold", itemId: b!, durationMs: 2000 },
      { op: "reorder", itemIds: [b!, a!] },
    ]);
    expect(e1.revision).toBe(1);
    // the first op is valid, the second is not: all or nothing
    expect(
      await codeOf(
        w.apply(e0.id, 1, [
          { op: "set_hold", itemId: a!, durationMs: 5000 },
          { op: "set_hold", itemId: b!, durationMs: -5 },
        ]),
      ),
    ).toBe("invalid");
    expect(await w.svc.get(w.projectId, e0.id)).toEqual(e1);
  });

  it("two concurrent writers on the same revision: exactly one wins, the other gets a conflict, no partial state", async () => {
    const w = world();
    const e0 = await w.create();
    const [a] = e0.items.map((i) => i.id);
    const results = await Promise.allSettled([
      w.apply(e0.id, 0, [{ op: "set_hold", itemId: a!, durationMs: 1111 }]),
      w.apply(e0.id, 0, [{ op: "set_hold", itemId: a!, durationMs: 2222 }]),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(((lost[0] as PromiseRejectedResult).reason as EpisodeEditError).code).toBe("conflict");
    const stored = (await w.svc.get(w.projectId, e0.id))!;
    expect(stored).toEqual((won[0] as PromiseFulfilledResult<typeof e0>).value);
    expect(stored.revision).toBe(1);
  });

  it("deletes the edit only at the expected revision", async () => {
    const w = world();
    const e0 = await w.create();
    expect(await codeOf(w.svc.delete({ editId: e0.id, projectId: w.projectId, expectedRevision: 1 }))).toBe(
      "conflict",
    );
    await w.svc.delete({ editId: e0.id, projectId: w.projectId, expectedRevision: 0 });
    expect(await w.svc.getForEpisode(w.projectId, w.episode.id)).toBeNull();
    expect(await codeOf(w.apply(e0.id, 0, []))).toBe("not_found");
  });

  it("an edit of another project is not addressable through this project", async () => {
    const w = world();
    const e0 = await w.create();
    expect(
      await codeOf(
        w.svc.apply({
          editId: e0.id,
          projectId: w.other.project.id,
          expectedRevision: 0,
          ops: [],
          userId: null,
          now: NOW,
        }),
      ),
    ).toBe("wrong_project");
    expect(await w.svc.get(w.other.project.id, e0.id)).toBeNull();
  });
});

describe("Episode edit (memory repository): deletion semantics", () => {
  it("a Shot, take or line in the edit cannot be removed; after the item is removed the Shot can; an Episode takes its edit", async () => {
    const data = seed();
    const repo = new MemoryRepository([data]);
    const episode = data.episodes[0]!;
    const [shotA, shotB] = data.shots.filter((s) => s.episodeId === episode.id);
    const take = data.takes.find((t) => !t.archived && t.durationMs >= 2000)!;
    const edit = await repo.episodeEdits.create({
      projectId: data.project.id,
      episodeId: episode.id,
      editRate: RATE,
      items: [
        {
          shotId: shotA!.id,
          visual: { kind: "none", durationMs: 3000 },
          performance: [
            {
              dialogueLineId: take.dialogueLineId,
              takeId: take.id,
              startMs: 0,
              takeInMs: 0,
              takeOutMs: 2000,
            },
          ],
          performanceBasis: null,
        },
        {
          shotId: shotB!.id,
          visual: { kind: "none", durationMs: 3000 },
          performance: [],
          performanceBasis: null,
        },
      ],
      userId: null,
      now: NOW,
    });
    expect(await codeOf(repo.remove(data.project.id, "shots", shotA!.id))).toBe("in_use");
    expect(await codeOf(repo.remove(data.project.id, "takes", take.id))).toBe("in_use");
    expect(await codeOf(repo.remove(data.project.id, "dialogueLines", take.dialogueLineId))).toBe("in_use");
    expect((await repo.loadProject(data.project.slug))!.shots.some((s) => s.id === shotA!.id)).toBe(true);

    await repo.episodeEdits.apply({
      editId: edit.id,
      projectId: data.project.id,
      expectedRevision: 0,
      ops: [{ op: "remove", itemId: edit.items[0]!.id }],
      userId: null,
      now: NOW,
    });
    await repo.remove(data.project.id, "shots", shotA!.id);
    expect((await repo.loadProject(data.project.slug))!.shots.some((s) => s.id === shotA!.id)).toBe(false);

    await repo.remove(data.project.id, "episodes", episode.id);
    expect(await repo.episodeEdits.listForProject(data.project.id)).toEqual([]);
  });
});

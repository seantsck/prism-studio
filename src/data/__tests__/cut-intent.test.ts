import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { seed } from "@/domain/__tests__/helpers";
import { cutIntentProblem, parseCutIntent, type CutIntent } from "@/domain/continuity/cut-intent";
import { buildEpisodeCuts } from "@/domain/continuity/sequence";
import type { EditItem, EpisodeEdit } from "@/domain/edit/model";
import { buildEpisodeEditView } from "@/domain/edit/view";
import { EpisodeEditError, type EditOp } from "../episode-edit-repository";
import {
  applyEditOps,
  assertEditValid,
  CUT_INTENT_PREDECESSOR_CHANGED_MESSAGE,
  type EditSourceFacts,
} from "../episode-edit-ops";
import { MemoryRepository } from "../memory-repository";

/**
 * Phase 3A.4C predecessor-bound cut intent. The op semantics (src/data/episode-edit-ops.ts) are shared by the memory
 * and Postgres repositories; the repository tests below use memory (the Postgres repository and the database's
 * final-state rule are proven on a disposable database by scripts/db-sequence-continuity.mts).
 */

const USER = "11111111-2222-4333-8444-555555555555";
const NOW = "2026-10-29T12:00:00.000Z";
const noFacts: EditSourceFacts = {
  shots: [],
  clip: { attempts: [], assets: [] },
  media: { attempts: new Map(), bestPointers: [] },
  storyboardFrames: [],
  productionFrames: [],
  takes: [],
};

function edit(): EpisodeEdit {
  const item = (shotId: string, visual: EditItem["visual"]): EditItem => ({
    id: randomUUID(),
    shotId,
    visual,
    sourceAudio: "muted",
    performance: [],
    performanceBasis: null,
    incomingCutIntent: null,
  });
  return {
    id: randomUUID(),
    projectId: randomUUID(),
    episodeId: randomUUID(),
    editRate: { num: 24, den: 1 },
    revision: 0,
    items: [
      item("shot-a", {
        kind: "video",
        attemptId: randomUUID(),
        assetId: randomUUID(),
        sourceInMs: 0,
        sourceOutMs: 4000,
      }),
      item("shot-b", {
        kind: "video",
        attemptId: randomUUID(),
        assetId: randomUUID(),
        sourceInMs: 0,
        sourceOutMs: 4000,
      }),
      item("shot-c", { kind: "none", durationMs: 2000 }),
    ],
  };
}

const run = (e: EpisodeEdit, ops: EditOp[]) =>
  applyEditOps(e, ops, noFacts, randomUUID, { userId: USER, now: NOW });
const declare = (e: EpisodeEdit, right: number, left = right - 1): EpisodeEdit =>
  run(e, [
    {
      op: "set_cut_intent",
      itemId: e.items[right]!.id,
      expectedPredecessorId: e.items[left]!.id,
      kinds: ["time_jump"],
      scope: ["time_of_day", "lighting"],
      note: "  Hours later.  ",
    },
  ]).next;
const intentOf = (e: EpisodeEdit, id: string) => e.items.find((i) => i.id === id)!.incomingCutIntent ?? null;

describe("cut intent shape (the database's episode_cut_intent_valid, in code)", () => {
  const valid: CutIntent = {
    fromItemId: randomUUID(),
    kinds: ["jump_cut"],
    scope: [],
    note: "Deliberate.",
    declaredBy: USER,
    declaredAt: NOW,
  };
  it("accepts the 3A.4A shape and refuses malformed values", () => {
    expect(cutIntentProblem(valid)).toBeNull();
    expect(cutIntentProblem({ ...valid, declaredBy: null })).toBeNull();
    for (const [bad, why] of [
      [null, "not an object"],
      [{ ...valid, extra: 1 }, "unknown field"],
      [{ ...valid, fromItemId: "item-a" }, "fromItemId"],
      [{ ...valid, kinds: [] }, "kinds"],
      [{ ...valid, kinds: ["jump_cut", "jump_cut"] }, "kinds"],
      [{ ...valid, kinds: ["teleport"] }, "kinds"],
      [{ ...valid, scope: ["smell"] }, "scope"],
      [{ ...valid, note: "   " }, "note"],
      [{ ...valid, note: "x".repeat(2001) }, "note"],
      [{ ...valid, declaredBy: "someone" }, "declaredBy"],
      [{ ...valid, declaredAt: "yesterday" }, "declaredAt"],
    ] as const)
      expect(cutIntentProblem(bad), why).toBe(why);
    expect(() => parseCutIntent({ ...valid, kinds: [] })).toThrow(/Malformed persisted cut intent/);
    expect(parseCutIntent(null)).toBeNull();
  });
});

describe("set / clear: bound to the reviewed predecessor; who and when from the server", () => {
  it("set_cut_intent stores the reviewed predecessor, the server's user and time, a trimmed note", () => {
    const e = edit();
    const next = declare(e, 1);
    expect(intentOf(next, e.items[1]!.id)).toEqual({
      fromItemId: e.items[0]!.id,
      kinds: ["time_jump"],
      scope: ["time_of_day", "lighting"],
      note: "Hours later.",
      declaredBy: USER,
      declaredAt: NOW,
    });
    expect(() => assertEditValid({ ...run(e, []), next }, noFacts, e)).not.toThrow();
  });

  it("refuses a stale predecessor (conflict), the first item, and an empty kind list / note", () => {
    const e = edit();
    const op = (o: Partial<Extract<EditOp, { op: "set_cut_intent" }>>): EditOp => ({
      op: "set_cut_intent",
      itemId: e.items[2]!.id,
      expectedPredecessorId: e.items[1]!.id,
      kinds: ["montage"],
      scope: [],
      note: "x",
      ...o,
    });
    const refusal = (o: Parameters<typeof op>[0]) => {
      try {
        run(e, [op(o)]);
        return null;
      } catch (err) {
        return err as EpisodeEditError;
      }
    };
    expect(refusal({ expectedPredecessorId: e.items[0]!.id })).toMatchObject({
      code: "conflict",
      message: CUT_INTENT_PREDECESSOR_CHANGED_MESSAGE,
    });
    expect(refusal({ itemId: e.items[0]!.id, expectedPredecessorId: e.items[0]!.id })?.code).toBe("invalid");
    expect(refusal({ kinds: [] })?.message).toMatch(/at least one kind/);
    expect(refusal({ note: "  " })?.message).toMatch(/Say why/);
    expect(refusal({})).toBeNull();
  });

  it("clear_cut_intent removes only that item's intent", () => {
    const e = declare(declare(edit(), 1), 2);
    const next = run(e, [{ op: "clear_cut_intent", itemId: e.items[1]!.id }]).next;
    expect(intentOf(next, e.items[1]!.id)).toBeNull();
    expect(intentOf(next, e.items[2]!.id)).not.toBeNull();
  });
});

describe("an intent survives every change that keeps its predecessor", () => {
  const ops = (e: EpisodeEdit): Array<[string, EditOp]> => {
    const [a, b] = e.items;
    return [
      ["trim A", { op: "trim", itemId: a!.id, sourceInMs: 500, sourceOutMs: 3500 }],
      ["trim B", { op: "trim", itemId: b!.id, sourceInMs: 100, sourceOutMs: 3000 }],
      ["source change", { op: "set_visual", itemId: b!.id, visual: { kind: "none", durationMs: 1500 } }],
      ["source audio", { op: "set_source_audio", itemId: b!.id, sourceAudio: "included" }],
      ["performance", { op: "set_performance", itemId: b!.id, placements: [], performanceBasis: null }],
      ["clear performance", { op: "clear_performance", itemId: b!.id }],
    ];
  };
  it.each(["trim A", "trim B", "source change", "source audio", "performance", "clear performance"])(
    "%s keeps the intent",
    (name) => {
      const e = declare(edit(), 1);
      const op = ops(e).find(([n]) => n === name)![1];
      const plan = run(e, [op]);
      expect(intentOf(plan.next, e.items[1]!.id)).toEqual(intentOf(e, e.items[1]!.id));
      expect(plan.intentCleared.size).toBe(0);
    },
  );

  it("a still's hold change keeps it too", () => {
    const e = declare(edit(), 2);
    const plan = run(e, [{ op: "set_hold", itemId: e.items[2]!.id, durationMs: 4000 }]);
    expect(intentOf(plan.next, e.items[2]!.id)).not.toBeNull();
  });
});

describe("a changed predecessor clears the intent in the same unit (never retargeted)", () => {
  it("reorder so another item precedes B: B's A-bound intent is cleared", () => {
    const e = declare(edit(), 1);
    const [a, b, c] = e.items;
    const plan = run(e, [{ op: "reorder", itemIds: [c!.id, b!.id, a!.id] }]);
    expect(intentOf(plan.next, b!.id)).toBeNull();
    expect([...plan.intentCleared]).toEqual([b!.id]);
    expect(() => assertEditValid(plan, noFacts, e)).not.toThrow();
  });

  it("remove A: C does not inherit anything and B's intent is cleared", () => {
    const e = declare(edit(), 1);
    const plan = run(e, [{ op: "remove", itemId: e.items[0]!.id }]);
    expect(plan.next.items[0]!.id).toBe(e.items[1]!.id);
    expect(intentOf(plan.next, e.items[1]!.id)).toBeNull();
  });

  it("remove B (the right item): its intent goes with it; nothing is copied", () => {
    const e = declare(edit(), 1);
    const plan = run(e, [{ op: "remove", itemId: e.items[1]!.id }]);
    expect(plan.next.items.every((i) => !i.incomingCutIntent)).toBe(true);
  });

  it("an add between A and B clears B's intent", () => {
    const e = declare(edit(), 1);
    const plan = run(e, [
      {
        op: "add",
        item: {
          shotId: "shot-d",
          visual: { kind: "none", durationMs: 1000 },
          performance: [],
          performanceBasis: null,
        },
        atPosition: 1,
      },
    ]);
    expect(intentOf(plan.next, e.items[1]!.id)).toBeNull();
    expect(plan.next.items[1]!.incomingCutIntent).toBeNull();
  });

  it("moved to first: no incoming cut, the intent is cleared", () => {
    const e = declare(edit(), 1);
    const [a, b, c] = e.items;
    const plan = run(e, [{ op: "reorder", itemIds: [b!.id, a!.id, c!.id] }]);
    expect(intentOf(plan.next, b!.id)).toBeNull();
  });

  it("moving away and back does not bring a cleared intent back: it must be declared again", () => {
    const e = declare(edit(), 1);
    const [a, b, c] = e.items;
    const away = run(e, [{ op: "reorder", itemIds: [a!.id, c!.id, b!.id] }]).next;
    const back = run(away, [{ op: "reorder", itemIds: [a!.id, b!.id, c!.id] }]).next;
    expect(intentOf(back, b!.id)).toBeNull();
  });

  it("the shared validity check refuses a predecessor mismatch the ops did not clear (what the database refuses)", () => {
    const e = declare(edit(), 1);
    const [a, b, c] = e.items;
    const forged = { ...e, items: [a!, c!, b!] };
    expect(() =>
      assertEditValid(
        { next: forged, visualChanged: new Set(), performanceChanged: new Set(), intentCleared: new Set() },
        noFacts,
        e,
      ),
    ).toThrow(/immediately before it/);
  });
});

describe("memory repository: one revision per intent change; a stale revision writes nothing", () => {
  async function setup() {
    const data = seed();
    const repo = new MemoryRepository([data]);
    const episode = data.episodes[0]!;
    const shots = data.shots.filter((s) => s.episodeId === episode.id).slice(0, 3);
    const created = await repo.episodeEdits.create({
      projectId: data.project.id,
      episodeId: episode.id,
      editRate: { num: 24, den: 1 },
      items: shots.map((s) => ({
        shotId: s.id,
        visual: { kind: "none" as const, durationMs: 2000 },
        performance: [],
        performanceBasis: null,
      })),
      userId: USER,
      now: NOW,
    });
    return { data, repo, created };
  }
  const setOp = (e: EpisodeEdit, right = 1): EditOp => ({
    op: "set_cut_intent",
    itemId: e.items[right]!.id,
    expectedPredecessorId: e.items[right - 1]!.id,
    kinds: ["location_jump"],
    scope: [],
    note: "We cut to the other place on purpose.",
  });

  it("set (rev +1), reload keeps it, hold change keeps it, reorder clears it (rev +1 each), clear refuses when none", async () => {
    const { data, repo, created } = await setup();
    const apply = (expectedRevision: number, ops: EditOp[]) =>
      repo.episodeEdits.apply({
        editId: created.id,
        projectId: data.project.id,
        expectedRevision,
        ops,
        userId: USER,
        now: NOW,
      });
    const r1 = await apply(0, [setOp(created)]);
    expect(r1.revision).toBe(1);
    expect(r1.items[1]!.incomingCutIntent).toMatchObject({
      fromItemId: created.items[0]!.id,
      declaredBy: USER,
    });
    expect((await repo.episodeEdits.get(data.project.id, created.id))!.items[1]!.incomingCutIntent).toEqual(
      r1.items[1]!.incomingCutIntent,
    );
    const r2 = await apply(1, [{ op: "set_hold", itemId: created.items[1]!.id, durationMs: 3000 }]);
    expect(r2.items[1]!.incomingCutIntent).toEqual(r1.items[1]!.incomingCutIntent);
    // a stale revision writes nothing
    await expect(apply(1, [{ op: "clear_cut_intent", itemId: created.items[1]!.id }])).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await repo.episodeEdits.get(data.project.id, created.id))!.revision).toBe(2);
    const [a, b, c] = created.items;
    const r3 = await apply(2, [{ op: "reorder", itemIds: [a!.id, c!.id, b!.id] }]);
    expect(r3.revision).toBe(3);
    expect(r3.items.every((i) => !i.incomingCutIntent)).toBe(true);
    await expect(apply(3, [{ op: "clear_cut_intent", itemId: b!.id }])).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("intent is not transition freshness: setting / clearing it leaves every cut fingerprint identical", async () => {
    const { data, repo, created } = await setup();
    const media = { attempts: new Map(), bestPointers: [] };
    const truths = (e: EpisodeEdit) =>
      buildEpisodeCuts({ data, view: buildEpisodeEditView(data, e, media) }).map((c) => c.truth);
    const before = truths(created);
    const declared = await repo.episodeEdits.apply({
      editId: created.id,
      projectId: data.project.id,
      expectedRevision: 0,
      ops: [setOp(created)],
      userId: USER,
      now: NOW,
    });
    expect(truths(declared)).toEqual(before);
    const cleared = await repo.episodeEdits.apply({
      editId: created.id,
      projectId: data.project.id,
      expectedRevision: 1,
      ops: [{ op: "clear_cut_intent", itemId: created.items[1]!.id }],
      userId: USER,
      now: NOW,
    });
    expect(truths(cleared)).toEqual(before);
  });
});

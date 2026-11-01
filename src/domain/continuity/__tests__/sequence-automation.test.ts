import { describe, expect, it } from "vitest";
import { seed, shotByCode } from "@/domain/__tests__/helpers";
import { cutsOf, editOf, videoItem, world } from "./cut-fixtures";
import {
  defaultQaPolicy,
  MAX_TRANSITIONS_PER_BATCH,
  qaPolicyErrors,
  qaPolicyNeedsSequenceColumns,
  semanticPolicyBlockers,
  sequencePolicyBlockers,
  type ProjectQaPolicy,
} from "../automation";
import {
  AUTO_SEQUENCE_NONCE,
  compareCutPriority,
  cutIsCriticalCapable,
  cutSettlement,
  cutSettlementSources,
  emptySettlementClock,
  planSequenceWave,
  SEQUENCE_SETTLE_MS,
  type CutSettlementClock,
} from "../sequence-automation";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const usable = { id: "gemini", usable: true, kind: "model" as const, missingConfig: [] };

const automatic = (patch: Partial<ProjectQaPolicy> = {}): ProjectQaPolicy => ({
  ...defaultQaPolicy("p"),
  analyzer: "gemini",
  externalMediaAllowed: true,
  directVideoAllowed: true,
  maxCostPerRunUsd: 1,
  maxCostPerDayUsd: 5,
  sequenceSemanticMode: "automatic",
  ...patch,
});

describe("policy", () => {
  it("defaults: Shot off, Sequence off, batch cap 20; a save that knows nothing about cuts changes nothing", () => {
    const p = defaultQaPolicy("p");
    expect(p).toMatchObject({ semanticMode: "off", sequenceSemanticMode: "off", maxTransitionsPerBatch: 20 });
    expect(MAX_TRANSITIONS_PER_BATCH).toBe(20);
    expect(
      qaPolicyErrors({
        semanticMode: "off",
        analyzer: null,
        externalMediaAllowed: false,
        maxCostPerRunUsd: null,
        maxCostPerDayUsd: null,
      }),
    ).toEqual([]);
    expect(
      qaPolicyNeedsSequenceColumns({
        semanticMode: "automatic",
        analyzer: "g",
        externalMediaAllowed: true,
        maxCostPerRunUsd: 1,
        maxCostPerDayUsd: 2,
      }),
    ).toBe(false);
  });

  it("Shot automatic neither implies nor needs Sequence automatic, and the reverse", () => {
    const shot = automatic({
      semanticMode: "automatic",
      sequenceSemanticMode: "off",
      directVideoAllowed: false,
    });
    expect(qaPolicyErrors(shot)).toEqual([]);
    expect(shot.sequenceSemanticMode).toBe("off");
    expect(sequencePolicyBlockers(shot, usable)).toEqual([]);
    const sequence = automatic({ semanticMode: "off" });
    expect(qaPolicyErrors(sequence)).toEqual([]);
    expect(semanticPolicyBlockers(sequence, usable)).toEqual([]);
    expect(qaPolicyErrors(automatic({ semanticMode: "automatic" }))).toEqual([]);
  });

  it.each([
    ["no analyzer", { analyzer: null }, /needs an analyzer/],
    ["no external media", { externalMediaAllowed: false }, /standing consent/],
    ["no direct video", { directVideoAllowed: false }, /permission to send Shot video/],
    ["no per-run ceiling", { maxCostPerRunUsd: null }, /per-run ceiling/],
    ["no daily ceiling", { maxCostPerDayUsd: null }, /24-hour/],
    ["a NaN ceiling", { maxCostPerDayUsd: Number.NaN }, /24-hour/],
  ])("Sequence automatic with %s is refused", (_n, patch, re) => {
    const errors = qaPolicyErrors(automatic(patch as Partial<ProjectQaPolicy>));
    expect(errors.join(" ")).toMatch(re);
    expect(sequencePolicyBlockers(automatic(patch as Partial<ProjectQaPolicy>), usable)).not.toEqual([]);
  });

  it.each([0, 21, 1.5, Number.NaN])("a batch cap of %s is refused", (maxTransitionsPerBatch) => {
    expect(qaPolicyErrors(automatic({ maxTransitionsPerBatch })).join(" ")).toMatch(/1 to 20/);
  });

  it("an analyzer this server cannot run blocks the standing authorisation", () => {
    expect(sequencePolicyBlockers(automatic(), null)[0]!.code).toBe("analyzer.unavailable");
    expect(sequencePolicyBlockers(automatic(), { ...usable, usable: false })[0]!.code).toBe(
      "analyzer.not_runnable",
    );
  });
});

describe("settling", () => {
  const sources = [
    { table: "items", id: "a" },
    { table: "shots", id: "s" },
  ] as const;
  const clockAt = (ms: number): CutSettlementClock => ({
    ...emptySettlementClock(),
    items: { a: ago(ms) },
    shots: { s: ago(SEQUENCE_SETTLE_MS * 10) },
  });
  const at = (ms: number) => cutSettlement({ sources, clock: clockAt(ms), now: NOW });

  it("the window is 10 minutes: 9m59s is not settled, exactly 10m is", () => {
    expect(SEQUENCE_SETTLE_MS).toBe(600_000);
    expect(at(599_000).state).toBe("settling");
    expect(at(600_000).state).toBe("settled");
    expect(at(600_000)).toMatchObject({ changedAt: ago(600_000) });
  });

  it("the newest source is the change time, and a settling cut says when it settles", () => {
    expect(at(60_000)).toEqual({
      state: "settling",
      changedAt: ago(60_000),
      settlesAt: ago(60_000 - 600_000),
    });
  });

  it("a future timestamp is not settled: clock skew waits", () => {
    expect(at(-60_000).state).toBe("settling");
  });

  it("a missing or unreadable clock fails closed: unknown, and now is never invented", () => {
    const missing = cutSettlement({
      sources: [...sources, { table: "props", id: "x" }],
      clock: clockAt(SEQUENCE_SETTLE_MS * 2),
      now: NOW,
    });
    expect(missing).toEqual({ state: "unknown", missing: ["props:x"] });
    const bad = cutSettlement({
      sources,
      clock: { ...clockAt(0), items: { a: "not a date" } },
      now: NOW,
    });
    expect(bad.state).toBe("unknown");
    expect(cutSettlement({ sources: [], clock: emptySettlementClock(), now: NOW }).state).toBe("unknown");
  });

  it("a selection's own instant counts", () => {
    const r = cutSettlement({
      sources: [...sources, { table: "view_selection", id: "s", at: ago(1000) }],
      clock: clockAt(SEQUENCE_SETTLE_MS * 2),
      now: NOW,
    });
    expect(r.state).toBe("settling");
  });

  it("the sources are cut-local: both items and Shots and their truth, never the edit or the Project", () => {
    const w = world();
    const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2B"), videoItem(w, "2E"), videoItem(w, "3A")]));
    const s = cutSettlementSources(w.data, cut!);
    const of = (t: string) => s.filter((x) => x.table === t).map((x) => x.id);
    expect(of("items")).toEqual([cut!.left.itemId, cut!.right.itemId]);
    expect(of("shots")).toEqual([cut!.left.shotId, cut!.right.shotId]);
    expect(of("assets")).toContain((cut!.left.picture as { assetId: string }).assetId);
    expect(of("characters").length).toBeGreaterThan(0);
    expect(of("looks").length).toBeGreaterThan(0);
    // the third item is not this cut's: its Shot and item are not among the sources
    const third = cutsOf(w, editOf(w, [videoItem(w, "2B"), videoItem(w, "2E"), videoItem(w, "3A")]));
    expect(third).toHaveLength(2);
    expect(of("items")).not.toContain(third[1]!.right.itemId);
    expect(
      s.every((x) =>
        [
          "items",
          "shots",
          "characters",
          "looks",
          "locations",
          "props",
          "assets",
          "view_selection",
          "lock_selection",
        ].includes(x.table),
      ),
    ).toBe(true);
  });

  it("every assignment, Prop, Location and selection of a side has a source", () => {
    const w = world();
    const shot = shotByCode(w.data, "2B");
    const prop = w.data.props[0]!;
    shot.propIds = [prop.id];
    w.data.shotLocationViewSelections = [{ shotId: shot.id, selectedAt: ago(5) } as never];
    w.data.shotCharacterContinuitySelections = [
      { shotId: shot.id, characterId: shot.characters[0]!.characterId, selectedAt: ago(6) } as never,
    ];
    const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2B"), videoItem(w, "2E")]));
    const s = cutSettlementSources(w.data, cut!);
    expect(s).toContainEqual({ table: "props", id: prop.id });
    expect(s).toContainEqual({ table: "view_selection", id: shot.id, at: ago(5) });
    expect(s).toContainEqual({
      table: "lock_selection",
      id: shot.characters[0]!.characterId,
      at: ago(6),
    });
    if (shot.spatial.locationId)
      expect(s).toContainEqual({ table: "locations", id: shot.spatial.locationId });
  });
});

describe("priority", () => {
  const cut = (index: number, critical: boolean) =>
    ({
      index,
      criteria: [
        {
          handler: "analyzer",
          applicability: "applies",
          severity: critical ? "critical" : "major",
        },
      ],
    }) as never;

  it("critical-capable cuts first, then edit order; deterministic", () => {
    const list = [cut(0, false), cut(1, true), cut(2, false), cut(3, true)];
    const order = (xs: typeof list) => xs.sort(compareCutPriority).map((c) => (c as { index: number }).index);
    expect(order([...list])).toEqual([1, 3, 0, 2]);
    expect(order([...list].reverse())).toEqual([1, 3, 0, 2]);
  });

  it("critical means an applicable semantic criterion Prism rates critical, never a deterministic one", () => {
    const criteria = (handler: string, applicability: string, severity: string) =>
      ({ criteria: [{ handler, applicability, severity }] }) as never;
    expect(cutIsCriticalCapable(criteria("analyzer", "applies", "critical"))).toBe(true);
    expect(cutIsCriticalCapable(criteria("deterministic", "applies", "critical"))).toBe(false);
    expect(cutIsCriticalCapable(criteria("analyzer", "n_a", "critical"))).toBe(false);
    expect(cutIsCriticalCapable(criteria("analyzer", "applies", "major"))).toBe(false);
  });
});

describe("the wave", () => {
  const PAID = { enabled: true, maxUsdPerRun: 1, maxUsdPerDay: 10 };
  const due = (...usd: Array<number | null>) => usd.map((maxUsd, i) => ({ id: i, maxUsd }));
  const plan = (o: {
    due: Array<{ id: number; maxUsd: number | null }>;
    free?: number;
    policy?: Partial<ProjectQaPolicy>;
    project?: number;
    global?: number;
    costed?: boolean;
    paid?: typeof PAID;
  }) =>
    planSequenceWave({
      due: o.due,
      freeSlots: o.free ?? 20,
      policy: automatic(o.policy),
      costed: o.costed ?? true,
      paid: o.paid ?? PAID,
      projectSpentLast24hUsd: o.project ?? 0,
      spentLast24hUsd: o.global ?? 0,
    });

  it("the wave is min(batch cap, free slots)", () => {
    expect(plan({ due: due(0.1, 0.1, 0.1, 0.1), free: 2 })).toMatchObject({
      stoppedBy: "no_slots",
      totalMaxUsd: 0.2,
    });
    expect(plan({ due: due(0.1, 0.1, 0.1), policy: { maxTransitionsPerBatch: 1 } }).wave).toHaveLength(1);
    expect(plan({ due: due(0.1, 0.1, 0.1), policy: { maxTransitionsPerBatch: 1 } }).stoppedBy).toBe(
      "batch_cap",
    );
    expect(plan({ due: due(0.1, 0.1), free: 0 })).toMatchObject({ wave: [], stoppedBy: "no_slots" });
    expect(plan({ due: due(0.1), free: -3 }).wave).toEqual([]);
  });

  it("the batch cap never overrides the active-job limit", () => {
    expect(
      plan({ due: due(0.1, 0.1, 0.1), free: 1, policy: { maxTransitionsPerBatch: 20 } }).wave,
    ).toHaveLength(1);
  });

  it("the longest prefix that fits: it never reorders to fit more, and the rest stays due", () => {
    const p = plan({ due: due(0.5, 0.5, 2, 0.1), policy: { maxCostPerRunUsd: 1 } });
    expect(p.wave.map((c) => c.id)).toEqual([0, 1]);
    expect(p.remaining.map((c) => c.id)).toEqual([2, 3]);
    expect(p.stoppedBy).toBe("budget");
    expect(p.reasons.join(" ")).toMatch(/per-run ceiling/);
  });

  it("the day budget counts prior spend and this wave's own cuts", () => {
    const p = plan({ due: due(1, 1, 1), project: 3.5, policy: { maxCostPerDayUsd: 5 } });
    expect(p.wave).toHaveLength(1);
    expect(p.totalMaxUsd).toBe(1);
    expect(p.reasons.join(" ")).toMatch(/daily budget/);
    expect(plan({ due: due(1), project: 5, policy: { maxCostPerDayUsd: 5 } }).wave).toEqual([]);
  });

  it("the server's global limits apply on top, and a Project can never raise them", () => {
    const paid = { enabled: true, maxUsdPerRun: 0.5, maxUsdPerDay: 1 };
    expect(plan({ due: due(0.6), paid }).reasons.join(" ")).toMatch(/per-run analysis limit/);
    expect(plan({ due: due(0.4, 0.4, 0.4), paid }).wave).toHaveLength(2);
    expect(plan({ due: due(0.1), global: 1, paid }).wave).toEqual([]);
    expect(plan({ due: due(0.1), paid: { enabled: false, maxUsdPerRun: 1, maxUsdPerDay: 1 } }).wave).toEqual(
      [],
    );
  });

  it("an unknown estimate never auto-submits", () => {
    const p = plan({ due: due(0.1, null, 0.1) });
    expect(p.wave).toHaveLength(1);
    expect(p.stoppedBy).toBe("unknown_cost");
    expect(plan({ due: due(Number.POSITIVE_INFINITY) }).stoppedBy).toBe("unknown_cost");
  });

  it("a free analyzer spends nothing, so only slots and the cap bound it", () => {
    expect(
      plan({
        due: due(null, null),
        costed: false,
        paid: { enabled: false, maxUsdPerRun: 0, maxUsdPerDay: 0 },
      }).wave,
    ).toHaveLength(2);
  });

  it("the automatic identity is its own stable, versioned nonce", () => {
    expect(AUTO_SEQUENCE_NONCE).toBe("auto-sequence-v1");
    expect(seed).toBeTruthy();
  });
});

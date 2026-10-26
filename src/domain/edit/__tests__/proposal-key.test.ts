import { describe, expect, it } from "vitest";
import { seed } from "@/domain/__tests__/helpers";
import { NO_MEDIA_FACTS } from "../eligibility";
import { proposeEpisodeAssembly } from "../proposal";
import { proposalKey } from "../proposal-key";

describe("proposalKey: the identity of a proposal as it would be persisted", () => {
  const data = seed();
  const proposal = proposeEpisodeAssembly(data, data.episodes[0]!.id, NO_MEDIA_FACTS);

  it("is deterministic", () => {
    expect(proposalKey(proposal)).toBe(
      proposalKey(proposeEpisodeAssembly(data, data.episodes[0]!.id, NO_MEDIA_FACTS)),
    );
    expect(proposalKey(proposal)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with anything that would be persisted: order, picture, times, performance, basis, edit rate", () => {
    const key = proposalKey(proposal);
    const [a, b, ...rest] = proposal.items;
    const variants = [
      { ...proposal, items: [b!, a!, ...rest] },
      { ...proposal, items: [{ ...a!, visual: { kind: "none" as const, durationMs: 1234 } }, b!, ...rest] },
      { ...proposal, items: [{ ...a!, sourceAudio: "included" as const }, b!, ...rest] },
      { ...proposal, items: [{ ...a!, performanceBasis: { performance: "x", timing: "y" } }, b!, ...rest] },
      { ...proposal, editRate: { num: 25, den: 1 } },
    ];
    for (const v of variants) expect(proposalKey(v)).not.toBe(key);
  });

  it("ignores explanation: reasons and notes (a Best hint that proposes nothing different)", () => {
    const [a, ...rest] = proposal.items;
    const explained = {
      ...proposal,
      items: [{ ...a!, notes: [{ code: "best_not_followed" as const, attemptId: "x" }] }, ...rest],
    };
    expect(proposalKey(explained)).toBe(proposalKey(proposal));
  });
});

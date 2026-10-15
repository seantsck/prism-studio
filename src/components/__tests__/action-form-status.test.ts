import { describe, expect, it } from "vitest";
import { actionStatusVisible } from "../action-form-status";

const failed = { ok: false, error: "Only a completed generation has a clip to review." } as const;

describe("ActionForm status visibility", () => {
  it("a quiet form still shows a failed save (never a silently ignored click)", () => {
    expect(actionStatusVisible({ quiet: true, pending: false, state: failed, showSaved: false })).toBe(true);
  });

  it("a quiet form stays silent while saving and after success", () => {
    expect(actionStatusVisible({ quiet: true, pending: true, state: null, showSaved: false })).toBe(false);
    expect(actionStatusVisible({ quiet: true, pending: false, state: { ok: true }, showSaved: true })).toBe(
      false,
    );
    expect(actionStatusVisible({ quiet: true, pending: false, state: null, showSaved: false })).toBe(false);
  });

  it("a non-quiet form shows pending, success and failure", () => {
    expect(actionStatusVisible({ quiet: false, pending: true, state: null, showSaved: false })).toBe(true);
    expect(actionStatusVisible({ quiet: false, pending: false, state: { ok: true }, showSaved: true })).toBe(
      true,
    );
    expect(actionStatusVisible({ quiet: false, pending: false, state: failed, showSaved: false })).toBe(true);
    expect(actionStatusVisible({ quiet: false, pending: false, state: null, showSaved: false })).toBe(false);
  });
});

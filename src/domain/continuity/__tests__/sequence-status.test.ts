import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSequenceStatusPoller,
  SEQUENCE_STATUS_POLL_MS,
  sequenceStatusOf,
  shouldPollSequenceStatus,
} from "../sequence-status";

/** Phase 3A.4F: the Supervisor's wake-up. Only Prism's own status response is mocked; there is no provider here. */
const isActive = (s: never) => ["queued", "processing"].includes(s as string);
const status = (
  editJobs: Array<{ id: string; status: string }>,
  project: Array<{ id: string; subjectKind: "attempt" | "transition"; status: string }>,
) => sequenceStatusOf({ editJobs, projectActiveJobs: project, isActive });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function poller(initial: string, responses: Array<string | null | Error>) {
  const refresh = vi.fn();
  const fetchSignature = vi.fn(async () => {
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    if (next instanceof Error) throw next;
    return next;
  });
  const p = createSequenceStatusPoller({
    initialSignature: initial,
    fetchSignature,
    refresh,
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (h) => globalThis.clearInterval(h),
  });
  return { p, refresh, fetchSignature };
}
const tickOnce = () => vi.advanceTimersByTimeAsync(SEQUENCE_STATUS_POLL_MS);

describe("the poller", () => {
  it("first response changed since the server rendered: active at render, finished before the first poll", async () => {
    const rendered = status(
      [{ id: "j", status: "processing" }],
      [{ id: "j", subjectKind: "transition", status: "processing" }],
    );
    const finished = status([{ id: "j", status: "succeeded" }], []);
    const { refresh } = poller(rendered.signature, [finished.signature]);
    await tickOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("first response unchanged: no refresh", async () => {
    const { refresh, fetchSignature } = poller("same", ["same"]);
    await tickOnce();
    expect(fetchSignature).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a later change refreshes", async () => {
    const { refresh } = poller("a", ["a", "a", "b"]);
    await tickOnce();
    await tickOnce();
    expect(refresh).not.toHaveBeenCalled();
    await tickOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a stable terminal state cannot loop: one refresh, however many polls", async () => {
    const { refresh } = poller("processing", ["done"]);
    for (let i = 0; i < 10; i++) await tickOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("the refreshed page's signature becomes the baseline, so it does not refresh again", async () => {
    const { p, refresh } = poller("a", ["b", "c", "c"]);
    await tickOnce();
    p.rendered("c");
    await tickOnce();
    await tickOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a failed read changes nothing and polling continues", async () => {
    const { refresh, fetchSignature } = poller("a", [null, new Error("network"), "a", "b"]);
    await tickOnce();
    await tickOnce();
    await tickOnce();
    expect(refresh).not.toHaveBeenCalled();
    await tickOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchSignature).toHaveBeenCalledTimes(4);
  });

  it("capacity blocked by a Shot QA job: refreshes when that job completes", async () => {
    const blocked = status([], [{ id: "shot", subjectKind: "attempt", status: "processing" }]);
    const free = status([], []);
    const { refresh } = poller(blocked.signature, [blocked.signature, free.signature]);
    await tickOnce();
    expect(refresh).not.toHaveBeenCalled();
    await tickOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("capacity blocked by another edit's job: refreshes when that job completes", async () => {
    const blocked = status([], [{ id: "other-edit", subjectKind: "transition", status: "queued" }]);
    const { refresh } = poller(blocked.signature, [status([], []).signature]);
    await tickOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stopping ends the timer, and a response arriving late does nothing", async () => {
    let release: (v: string) => void = () => undefined;
    const refresh = vi.fn();
    const fetchSignature = vi.fn(() => new Promise<string>((r) => (release = r)));
    const p = createSequenceStatusPoller({
      initialSignature: "a",
      fetchSignature,
      refresh,
      setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
      clearInterval: (h) => globalThis.clearInterval(h),
    });
    await tickOnce();
    p.stop();
    release("b");
    await tickOnce();
    await tickOnce();
    expect(fetchSignature).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("it can only refresh: its one effect is the callback it is given", async () => {
    const { refresh, fetchSignature } = poller("a", ["b"]);
    await tickOnce();
    expect(refresh.mock.calls).toEqual([[]]);
    expect(fetchSignature.mock.calls).toEqual([[]]);
  });
});

describe("when to poll", () => {
  const base = { mode: "automatic" as const, ready: true, editActive: 0, capacityBlocked: false };

  it("settling only: no polling, so no timer exists", () => {
    expect(shouldPollSequenceStatus(base)).toBe(false);
  });
  it("off: no automatic polling, whatever else is true", () => {
    expect(shouldPollSequenceStatus({ ...base, mode: "off", editActive: 2, capacityBlocked: true })).toBe(
      false,
    );
  });
  it("before migration 0047: none", () => {
    expect(shouldPollSequenceStatus({ ...base, ready: false, editActive: 2 })).toBe(false);
  });
  it("this edit has an active job", () => {
    expect(shouldPollSequenceStatus({ ...base, editActive: 1 })).toBe(true);
    expect(shouldPollSequenceStatus({ ...base, mode: "suggest", editActive: 1 })).toBe(true);
  });
  it("automatic with due work blocked on shared capacity", () => {
    expect(shouldPollSequenceStatus({ ...base, capacityBlocked: true })).toBe(true);
  });
  it("suggest never waits on capacity: nothing would be queued", () => {
    expect(shouldPollSequenceStatus({ ...base, mode: "suggest", capacityBlocked: true })).toBe(false);
  });
});

describe("the signature", () => {
  it("is order-independent, and changes with this edit's state and the shared capacity", () => {
    const a = { id: "a", subjectKind: "attempt" as const, status: "processing" };
    const b = { id: "b", subjectKind: "transition" as const, status: "queued" };
    expect(status([], [a, b]).signature).toBe(status([], [b, a]).signature);
    expect(status([], [a]).signature).not.toBe(status([], [a, b]).signature);
    expect(status([], [a]).signature).not.toBe(status([], [{ ...a, status: "queued" }]).signature);
    expect(status([{ id: "j", status: "queued" }], []).signature).not.toBe(
      status([{ id: "j", status: "processing" }], []).signature,
    );
  });

  it("copies only the safe fields, whatever the job object holds", () => {
    const job = {
      id: "j",
      subjectKind: "transition" as const,
      status: "processing",
      inputSnapshot: { secret: "PAYLOAD" },
      providerRef: "PROVIDER-REF",
    };
    const s = sequenceStatusOf({ editJobs: [job], projectActiveJobs: [job], isActive });
    const text = JSON.stringify(s);
    expect(text).not.toMatch(/PAYLOAD|PROVIDER-REF|inputSnapshot|providerRef/);
    expect(s.edit).toEqual({ active: 1, jobs: [{ id: "j", status: "processing" }] });
    expect(s.project.jobs).toEqual([{ id: "j", subjectKind: "transition", status: "processing" }]);
  });
});

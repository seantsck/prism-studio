import { describe, expect, it } from "vitest";
import { MAX_SPLAT_BYTES } from "@/domain/previs/splat";
import { HEADERS, jobPaths, PATHS, PROTOCOL } from "@/lib/local-agent/protocol";
import type { TestAgent } from "../../__tests__/helpers";
import { handleFail, handleLease, handleProgress, handleResult, handleSource } from "../../http";
import type { IncomingRequest } from "../../service";
import { leaseJob, progress } from "../service";
import { ORIGIN, remoteWorld, spzResult } from "./world";

/** A Web Request carrying exactly what a TestAgent signed (headers + body). */
function toRequest(r: IncomingRequest, extra: Record<string, string> = {}, body?: BodyInit): Request {
  const headers = new Headers(extra);
  for (const h of Object.values(HEADERS)) {
    const v = r.header(h);
    if (v !== null) headers.set(h, v);
  }
  return new Request(r.url, {
    method: r.method,
    headers,
    body: body ?? (r.body.length ? Buffer.from(r.body) : undefined),
    // @ts-expect-error Node's fetch needs this for a streamed body
    duplex: "half",
  });
}

/** A body that fails the test if anything reads it. */
const untouchable = () =>
  new ReadableStream({
    pull() {
      throw new Error("the body must not be read");
    },
  });

async function leasedWorld() {
  const w = await remoteWorld();
  const imgs = await w.addImages(w.A, 3);
  await w.remoteJob(w.A, imgs);
  const a = await w.agent(w.A);
  const lease = (await leaseJob(w.deps, a.request("POST", PATHS.lease, { protocol: PROTOCOL }))).lease!;
  return { w, a, lease, imgs };
}

const errorCode = async (r: Response) => ((await r.json()) as { error?: { code: string } }).error?.code;

describe("remote job HTTP framing", () => {
  it("lease answers JSON, no-store", async () => {
    const w = await remoteWorld();
    const a = await w.agent(w.A);
    const r = await handleLease(
      toRequest(a.request("POST", PATHS.lease, { protocol: PROTOCOL }), {
        "content-type": "application/json",
      }),
      w.deps,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toMatchObject({ ok: true, lease: null, idle: "no_job" });
  });

  it("a source is raw bytes with its own image type, length and frozen sha256; no-store, nosniff, no file name", async () => {
    const { w, a, lease, imgs } = await leasedWorld();
    const path = jobPaths(lease.jobId, lease.leaseId).source(0);
    const r = await handleSource(toRequest(a.request("GET", path, null)), w.deps, {
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      ordinal: "0",
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe(imgs[0]!.mime);
    expect(r.headers.get("content-length")).toBe(String(imgs[0]!.byteSize));
    expect(r.headers.get("x-prism-source-sha256")).toBe(imgs[0]!.checksum);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-disposition")).toBeNull();
    expect(Buffer.from(await r.arrayBuffer())).toEqual(Buffer.from(w.objects.get(imgs[0]!.objectPath!)!));
  });

  it.each([
    ["01", "malformed_request"],
    ["-1", "malformed_request"],
    ["abc", "malformed_request"],
    ["1000", "malformed_request"],
  ])("ordinal %s is refused by grammar before any lookup", async (ordinal, codeExpected) => {
    const { w, a, lease } = await leasedWorld();
    const r = await handleSource(
      toRequest(a.request("GET", jobPaths(lease.jobId, lease.leaseId).source(0), null)),
      w.deps,
      {
        jobId: lease.jobId,
        leaseId: lease.leaseId,
        ordinal,
      },
    );
    expect(await errorCode(r)).toBe(codeExpected);
  });

  it("malformed job or lease ids are refused before any lookup", async () => {
    const { w, a, lease } = await leasedWorld();
    for (const p of [
      { jobId: "../etc", leaseId: lease.leaseId },
      { jobId: lease.jobId, leaseId: "ZZ" },
      { jobId: lease.jobId.toUpperCase(), leaseId: lease.leaseId },
    ]) {
      const r = await handleProgress(
        toRequest(a.request("POST", "/api/local-agent/v1/x", { protocol: PROTOCOL }), {
          "content-type": "application/json",
        }),
        w.deps,
        p,
      );
      expect(await errorCode(r)).toBe("malformed_request");
    }
  });

  it("result: oversize, wrong type, no declared length or no lease are refused WITHOUT reading the body", async () => {
    const { w, a, lease } = await leasedWorld();
    const { bytes, result } = spzResult();
    await progress(
      w.deps,
      a.request("POST", jobPaths(lease.jobId, lease.leaseId).progress, {
        protocol: PROTOCOL,
        stage: "uploading",
        progress: 1,
        message: "x",
        result,
      }),
      lease.jobId,
      lease.leaseId,
    );
    const put = (extra: Record<string, string>) =>
      handleResult(
        toRequest(
          a.request("PUT", jobPaths(lease.jobId, lease.leaseId).result, null, { rawBody: bytes }),
          extra,
          untouchable(),
        ),
        w.deps,
        { jobId: lease.jobId, leaseId: lease.leaseId },
      );
    expect(
      await errorCode(
        await put({ "content-type": "application/x-spz", "content-length": String(MAX_SPLAT_BYTES + 1) }),
      ),
    ).toBe("payload_too_large");
    expect(
      await errorCode(
        await put({ "content-type": "application/octet-stream", "content-length": String(bytes.length) }),
      ),
    ).toBe("malformed_request");
    expect(
      await errorCode(
        await put({ "content-type": "application/x-spz", "content-length": String(bytes.length + 5) }),
      ),
    ).toBe("result_rejected");
    expect(await errorCode(await put({ "content-type": "application/x-spz" }))).toBe("result_rejected");
    // a caller that is not the lease holder (or names no device) is refused before buffering
    const stranger = await w.agent(w.A);
    const r = await handleResult(
      toRequest(
        stranger.request("PUT", jobPaths(lease.jobId, lease.leaseId).result, null, { rawBody: bytes }),
        { "content-type": "application/x-spz", "content-length": String(bytes.length) },
        untouchable(),
      ),
      w.deps,
      { jobId: lease.jobId, leaseId: lease.leaseId },
    );
    expect(await errorCode(r)).toBe("lease_mismatch");
    expect((await w.job(lease.jobId))!.status).toBe("running");
    // and the real upload, with its exact length, goes through
    const ok = await handleResult(
      toRequest(a.request("PUT", jobPaths(lease.jobId, lease.leaseId).result, null, { rawBody: bytes }), {
        "content-type": "application/x-spz",
        "content-length": String(bytes.length),
      }),
      w.deps,
      { jobId: lease.jobId, leaseId: lease.leaseId },
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toMatchObject({ ok: true, job: { status: "succeeded" } });
  });

  it("progress and fail bodies are small JSON (oversize → payload_too_large)", async () => {
    const { w, a, lease } = await leasedWorld();
    const big = { protocol: PROTOCOL, stage: "splat_training", progress: 0.5, message: "x".repeat(20_000) };
    const r = await handleProgress(
      toRequest(a.request("POST", jobPaths(lease.jobId, lease.leaseId).progress, big), {
        "content-type": "application/json",
      }),
      w.deps,
      { jobId: lease.jobId, leaseId: lease.leaseId },
    );
    expect(await errorCode(r)).toBe("payload_too_large");
    const f = await handleFail(
      toRequest(
        a.request("POST", jobPaths(lease.jobId, lease.leaseId).fail, {
          ...big,
          code: "colmap_failed",
          stage: null,
        }),
        { "content-type": "application/json" },
      ),
      w.deps,
      { jobId: lease.jobId, leaseId: lease.leaseId },
    );
    expect(await errorCode(f)).toBe("payload_too_large");
    expect((await w.job(lease.jobId))!.status).toBe("running");
  });

  it("no route answers with a Storage URL, bucket or object path", async () => {
    const { w, a, lease } = await leasedWorld();
    const r = await handleLease(
      toRequest(a.request("POST", PATHS.lease, { protocol: PROTOCOL }), {
        "content-type": "application/json",
      }),
      w.deps,
    );
    const text = await r.text();
    expect(text).toContain(lease.leaseId);
    expect(text).not.toMatch(/https?:\/\/|objectPath|bucket|prism-assets|token=|signature=/i);
    void ORIGIN;
    void ({} as TestAgent);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ProviderOutput } from "@/domain/generation/schemas";
import { sniffUpload } from "@/lib/upload-policy";
import { deterministicOutputId, ingestOutputs, isRetryableDownloadStatus } from "../ingest";
import { silentLogger } from "../log";
import { encodeMockPng } from "../providers/mock-image";
import { LocalDiskSink, type OutputSink } from "../sink";
import { GenerationWorker } from "../worker";
import { makeHarness } from "./helpers";

const png = encodeMockPng(64, 36, 5);
const PROJECT = "11111111-1111-4111-8111-111111111111";

describe("ingestion is restart-safe", () => {
  const root = mkdtempSync(path.join(tmpdir(), "prism-crash-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  class CountingSink extends LocalDiskSink {
    puts = 0;
    removes = 0;
    override async put(p: string, b: Uint8Array) {
      this.puts += 1;
      return super.put(p, b);
    }
    override async remove(p: string) {
      this.removes += 1;
      return super.remove(p);
    }
  }

  const output = (source: ProviderOutput["source"]): ProviderOutput => ({
    role: "primary",
    position: 0,
    kind: "image",
    filename: "out.png",
    mime: "image/png",
    source,
    reported: { width: null, height: null, durationMs: null, fps: null },
  });
  const result = (out: ProviderOutput) =>
    ({
      outputs: [out],
      provenance: { providerJobId: "task-1" },
      cost: { amount: null, currency: "USD", basis: "", units: null },
    }) as never;
  const ctx = (sink: OutputSink, attemptId: string) => ({
    projectId: PROJECT,
    attemptId,
    ownerUserId: "33333333-3333-4333-8333-333333333333",
    provider: "runway",
    model: "gen4.5",
    providerJobId: "task-1",
    sink,
    allowedHosts: [] as string[],
    limits: { maxBytes: 100_000, timeoutMs: 1000, maxRedirects: 1 },
    now: () => new Date("2026-01-01T00:00:00Z"),
  });

  it("output identity is deterministic per (attempt, provider task, position)", () => {
    const a = deterministicOutputId("att-1", "task-1", 0);
    expect(a).toBe(deterministicOutputId("att-1", "task-1", 0));
    expect(a).not.toBe(deterministicOutputId("att-1", "task-1", 1));
    expect(a).not.toBe(deterministicOutputId("att-2", "task-1", 0));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("crash after upload, before the database commit: the retry reuses the object (no re-download, no duplicate)", async () => {
    const sink = new CountingSink(root);
    const attemptId = crypto.randomUUID();
    const bytes = { type: "bytes" as const, base64: Buffer.from(png).toString("base64") };

    const first = await ingestOutputs(result(output(bytes)), ctx(sink, attemptId));
    expect(sink.puts).toBe(1);
    // …the worker dies here: the Asset row was never written. The provider URL has since expired.
    const dead = { type: "url" as const, url: "https://expired.example.com/o.png?Signature=gone" };
    const second = await ingestOutputs(result(output(dead)), ctx(sink, attemptId));
    expect(sink.puts).toBe(1); // still one upload
    expect(second.outputs[0]!.asset.id).toBe(first.outputs[0]!.asset.id);
    expect(second.outputs[0]!.asset.objectPath).toBe(first.outputs[0]!.asset.objectPath);
    expect(second.outputs[0]!.asset.checksum).toBe(first.outputs[0]!.asset.checksum);
    expect(sniffUpload(await sink.get(second.outputs[0]!.asset.objectPath!).then((b) => b!))).toBeTruthy();
  });

  it("a partial/corrupt leftover object is replaced, not trusted", async () => {
    const sink = new CountingSink(root);
    const attemptId = crypto.randomUUID();
    const id = deterministicOutputId(attemptId, "task-1", 0);
    await sink.put(`${PROJECT}/${id}/out.png`, new TextEncoder().encode("<html>truncated"));
    sink.puts = 0;
    const r = await ingestOutputs(
      result(output({ type: "bytes", base64: Buffer.from(png).toString("base64") })),
      ctx(sink, attemptId),
    );
    expect(sink.removes).toBeGreaterThanOrEqual(1);
    expect(sink.puts).toBe(1);
    expect(r.outputs[0]!.asset.byteSize).toBe(png.length);
  });

  it("download status classification: deterministic 4xx is permanent, expiry-shaped statuses retry", () => {
    for (const s of [400, 401, 405, 410, 415, 422])
      expect(isRetryableDownloadStatus(s), String(s)).toBe(false);
    for (const s of [403, 404, 408, 425, 429, 500, 502, 503])
      expect(isRetryableDownloadStatus(s), String(s)).toBe(true);
    expect(isRetryableDownloadStatus(undefined)).toBe(true);
  });
});

describe("worker crash points around finalize", () => {
  it("a failed database commit after ingestion is retried and still produces exactly one asset", async () => {
    const h = makeHarness();
    const { jobId, attemptId } = await h.submit("3A");
    let failures = 1;
    const store = Object.create(h.repo.generation) as typeof h.repo.generation;
    store.finalizeSuccess = async (input) => {
      if (failures-- > 0) throw new Error("simulated crash before commit");
      return h.repo.generation.finalizeSuccess(input);
    };
    const worker = new GenerationWorker({
      store,
      registry: h.registry,
      sink: h.sink,
      config: h.config,
      logger: silentLogger,
      clock: () => h.clock.now,
      workerId: "crashy",
      retryPolicy: { baseDelayMs: 100, maxDelayMs: 1000, jitter: 0 },
      random: () => 0,
      heartbeatMs: 0,
    });
    for (let i = 0; i < 30; i++) {
      const j = (await h.repo.generation.getJob(jobId!))!;
      if (j.status === "succeeded" || j.status === "failed") break;
      await worker.tick();
      h.clock.advance(1500);
    }
    const job = (await h.repo.generation.getJob(jobId!))!;
    expect(job.status).toBe("succeeded");
    const view = (await h.repo.generation.getAttemptView(attemptId!))!;
    const paths = view.outputs.map((o) => o.asset.objectPath);
    expect(new Set(paths).size).toBe(paths.length);
    expect(view.outputs.length).toBeGreaterThanOrEqual(1);
    // asset ids are the deterministic ones for this attempt/task/position
    const primary = view.outputs.find((o) => o.output.position === 0)!;
    expect(primary.asset.id).toBe(deterministicOutputId(attemptId!, job.providerJobId!, 0));
  });
});

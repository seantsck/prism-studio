import http from "node:http";
import { createHash } from "node:crypto";
import pg from "pg";
import { PostgresGenerationData } from "../src/data/generation-postgres";
import { createOutputSink } from "../src/generation/sink";
import { FfmpegMediaProcessor } from "../src/media/ffmpeg";
import { parseAdaptationPlan } from "../src/domain/framing/adaptation";
import { derivationKey, resolveConform } from "../src/domain/framing/conform";
import { derivedAssetId } from "../src/media/delivery";
import { buildObjectPath, safeFileName } from "../src/lib/storage-paths";
import { assertProjectRef, installRedactingHandlers, printBanner } from "./lib/safety.mjs";

installRedactingHandlers();

const ATTEMPT_ID = "7ace044a-792b-485d-b1d2-e5943aa3c081";
const EXPECTED_PROVIDER = "openai-image";
const EXPECTED_MODEL = "gpt-image-2.5-flare";
const EXPECTED_SOURCE_CHECKSUM = "58df8d09966d11d8521aec14cadda76f5a9939df175d4f7c9217fc3a4f731137";
const HEALTH_PORT = 8080;

const url = process.env.PRISM_STUDIO_WORKER_DB_URL ?? "";
assertProjectRef(url, "PRISM_STUDIO_WORKER_DB_URL");
printBanner({ mode: "Phase 5B one-time Production Frame conform probe", url });

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let result: Record<string, unknown> = { ok: false, status: "starting" };

try {
  const who = await pool.query("select current_user as u");
  if (who.rows[0]?.u !== "prism_generation_worker") {
    throw new Error("Conform probe is not running as prism_generation_worker");
  }

  const store = new PostgresGenerationData(pool, "begin");
  const view = await store.getAttemptView(ATTEMPT_ID);
  if (!view) throw new Error("Acceptance attempt not found");
  if (view.attempt.status !== "succeeded") throw new Error(`Attempt status is ${view.attempt.status}, not succeeded`);
  if (view.attempt.provider !== EXPECTED_PROVIDER || view.attempt.model !== EXPECTED_MODEL) {
    throw new Error("Acceptance attempt provider/model mismatch");
  }
  if (view.attempt.inputAssetIds.length !== 6) throw new Error("Acceptance attempt does not contain six input assets");

  const original =
    view.outputs.find((o) => o.output.role === "primary")?.asset ??
    view.outputs.find((o) => o.asset.type === "image")?.asset ??
    null;
  if (!original?.objectPath || !original.checksum) throw new Error("Provider original is missing stored bytes/checksum");
  if (original.checksum !== EXPECTED_SOURCE_CHECKSUM) throw new Error("Provider original checksum changed");

  const plan = parseAdaptationPlan(view.attempt.adaptationPlan);
  if (!plan) throw new Error("Stored adaptation plan is missing or invalid");
  if (!plan.conform.required || plan.conform.framing !== "crop" || plan.conform.targetAspectRatio !== "2.39:1") {
    throw new Error("Stored conform plan is not the expected 2.39:1 crop");
  }

  const sink = await createOutputSink(process.env, "supabase");
  const input = await sink.get(original.objectPath);
  if (!input) throw new Error("Provider original is missing from private Storage");
  if (sha256(input) !== original.checksum) throw new Error("Provider original bytes do not match recorded checksum");

  const processor = new FfmpegMediaProcessor();
  const identity = await processor.identity();
  const probe = await processor.probe(input);
  if (probe.kind !== "image" || probe.width !== 1536 || probe.height !== 864) {
    throw new Error(`Unexpected provider original probe: ${probe.kind} ${probe.width}x${probe.height}`);
  }

  const resolved = resolveConform(plan.conform, {
    width: probe.width,
    height: probe.height,
    durationMs: probe.durationMs,
  });
  if (!resolved.crop || resolved.crop.x !== 0 || resolved.crop.y !== 110 || resolved.crop.width !== 1536 || resolved.crop.height !== 642) {
    throw new Error(`Unexpected resolved crop: ${JSON.stringify(resolved.crop)}`);
  }

  const parameters = {
    plan: plan.conform,
    resolved: { crop: resolved.crop, pad: resolved.pad, trimMs: resolved.trimMs },
    input: { width: probe.width, height: probe.height, durationMs: probe.durationMs },
  };
  const processorId = `${identity.name}/${identity.adapterVersion}`;
  const key = derivationKey({
    parentChecksum: original.checksum,
    operation: "conform",
    parameters,
    processorVersion: processorId,
  });
  const id = derivedAssetId(key);
  const out = await processor.conform(input, {
    crop: resolved.crop,
    pad: resolved.pad,
    trimMs: resolved.trimMs,
  });
  if (out.probe.kind !== "image" || out.probe.width !== 1536 || out.probe.height !== 642) {
    throw new Error(`Unexpected conformed output: ${out.probe.kind} ${out.probe.width}x${out.probe.height}`);
  }

  const filename = safeFileName(`3A-a${view.attempt.attemptNumber}-delivery.png`);
  const objectPath = buildObjectPath(original.projectId, id, filename);
  const outputChecksum = sha256(out.bytes);
  const existing = await sink.get(objectPath);
  if (!existing || sha256(existing) !== outputChecksum) {
    if (existing) await sink.remove(objectPath);
    await sink.put(objectPath, out.bytes, out.mime);
  }

  result = {
    ok: true,
    status: "conform_ready",
    attemptId: ATTEMPT_ID,
    original: {
      id: original.id,
      checksum: original.checksum,
      objectPath: original.objectPath,
      width: probe.width,
      height: probe.height,
    },
    asset: {
      id,
      projectId: original.projectId,
      createdBy: null,
      type: "image",
      purpose: "generation_output",
      source: "derived",
      name: filename,
      originalFilename: filename,
      storageProvider: sink.name,
      bucket: sink.bucket,
      objectPath,
      mime: out.mime,
      byteSize: out.bytes.length,
      checksum: outputChecksum,
      width: out.probe.width,
      height: out.probe.height,
      durationMs: out.probe.durationMs,
      frameRate: out.probe.fps,
      sampleRate: out.probe.audioSampleRate,
      channels: out.probe.audioChannels,
      tags: ["delivery-master", "derived"],
      notes: "",
      metadata: {
        derivedFrom: original.id,
        operation: "conform",
        derivationKey: key,
        processor: processorId,
        processorToolVersion: identity.toolVersion,
      },
    },
    derivation: {
      parentAssetId: original.id,
      operation: "conform",
      derivationKey: key,
      parameters,
      processor: identity.name,
      processorVersion: `${identity.adapterVersion} (${identity.toolVersion})`,
      attemptId: ATTEMPT_ID,
      slot: "delivery",
    },
    resolved,
    processor: identity,
  };

  console.log(JSON.stringify({ event: "phase5b.conform.ready", ...result }));
} catch (err) {
  result = {
    ok: false,
    status: "failed",
    error: err instanceof Error ? err.message : String(err),
  };
  console.error(JSON.stringify({ event: "phase5b.conform.failed", ...result }));
} finally {
  await pool.end().catch(() => undefined);
}

const server = http.createServer((req, res) => {
  if (req.url !== "/healthz") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
    return;
  }
  res.writeHead(result.ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(result));
});
server.listen(HEALTH_PORT, "0.0.0.0", () => {
  console.log(`phase5b conform probe health on :${HEALTH_PORT}`);
});

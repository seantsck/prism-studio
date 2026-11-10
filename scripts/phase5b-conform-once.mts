import http from "node:http";
import { createHash } from "node:crypto";
import { createOutputSink } from "../src/generation/sink";
import { FfmpegMediaProcessor } from "../src/media/ffmpeg";
import { derivationKey, resolveConform, type DeliveryConformPlan } from "../src/domain/framing/conform";
import { derivedAssetId } from "../src/media/delivery";
import { buildObjectPath, safeFileName } from "../src/lib/storage-paths";
import { installRedactingHandlers } from "./lib/safety.mjs";

installRedactingHandlers();

const ATTEMPT_ID = "7ace044a-792b-485d-b1d2-e5943aa3c081";
const PROJECT_ID = "aa03e5af-941f-5708-a7a3-9180f646d64d";
const ORIGINAL_ID = "e648296d-9d52-5d3f-8914-e53bead3af55";
const ORIGINAL_PATH = "aa03e5af-941f-5708-a7a3-9180f646d64d/e648296d-9d52-5d3f-8914-e53bead3af55/openai-image-61120a14-fd6.png";
const ORIGINAL_CHECKSUM = "58df8d09966d11d8521aec14cadda76f5a9939df175d4f7c9217fc3a4f731137";
const HEALTH_PORT = 8080;

const plan: DeliveryConformPlan = {
  version: 1,
  required: true,
  targetAspectRatio: "2.39:1",
  framing: "crop",
  trimToMs: null,
  steps: ["crop"],
};

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let result: Record<string, unknown> = { ok: false, status: "starting" };

try {
  const sink = await createOutputSink(process.env, "supabase");
  const input = await sink.get(ORIGINAL_PATH);
  if (!input) throw new Error("Provider original is missing from private Storage");
  if (sha256(input) !== ORIGINAL_CHECKSUM) throw new Error("Provider original bytes do not match recorded checksum");

  const processor = new FfmpegMediaProcessor();
  const identity = await processor.identity();
  const probe = await processor.probe(input);
  if (probe.kind !== "image" || probe.width !== 1536 || probe.height !== 864) {
    throw new Error(`Unexpected provider original probe: ${probe.kind} ${probe.width}x${probe.height}`);
  }

  const resolved = resolveConform(plan, {
    width: probe.width,
    height: probe.height,
    durationMs: probe.durationMs,
  });
  if (!resolved.crop || resolved.crop.x !== 0 || resolved.crop.y !== 110 || resolved.crop.width !== 1536 || resolved.crop.height !== 642) {
    throw new Error(`Unexpected resolved crop: ${JSON.stringify(resolved.crop)}`);
  }

  const parameters = {
    plan,
    resolved: { crop: resolved.crop, pad: resolved.pad, trimMs: resolved.trimMs },
    input: { width: probe.width, height: probe.height, durationMs: probe.durationMs },
  };
  const processorId = `${identity.name}/${identity.adapterVersion}`;
  const key = derivationKey({
    parentChecksum: ORIGINAL_CHECKSUM,
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

  const filename = safeFileName("3A-phase5b-delivery.png");
  const objectPath = buildObjectPath(PROJECT_ID, id, filename);
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
      id: ORIGINAL_ID,
      projectId: PROJECT_ID,
      checksum: ORIGINAL_CHECKSUM,
      objectPath: ORIGINAL_PATH,
      width: probe.width,
      height: probe.height,
    },
    asset: {
      id,
      projectId: PROJECT_ID,
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
        derivedFrom: ORIGINAL_ID,
        operation: "conform",
        derivationKey: key,
        processor: processorId,
        processorToolVersion: identity.toolVersion,
      },
    },
    derivation: {
      parentAssetId: ORIGINAL_ID,
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
  result = { ok: false, status: "failed", error: err instanceof Error ? err.message : String(err) };
  console.error(JSON.stringify({ event: "phase5b.conform.failed", ...result }));
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

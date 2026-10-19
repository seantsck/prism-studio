import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  LocalReconstructionError,
  SUPPORTED_INPUT_MIMES,
  type LocalReconstructionInput,
  type SupportedInputMime,
} from "./types";
import { inWorkspace, type Workspace } from "./workspace";

/**
 * Ordered photographs → `input/000001.<ext>`, `000002.<ext>`, … (ordinal 0 is 000001). The original file name is
 * never used for anything (it may be hostile); the content is copied byte-for-byte (never re-encoded) while its
 * sha256 is computed in the same streaming pass.
 */

export interface InputLimits {
  /** fewest photographs a reconstruction may start with */
  minImages: number;
  maxImages: number;
  maxImageBytes: number;
  maxTotalBytes: number;
}

export interface MaterializedInput {
  ordinal: number;
  fileName: string;
  mime: SupportedInputMime;
  byteSize: number;
  checksum: string;
}

const SIGNATURES: Record<SupportedInputMime, (head: Uint8Array) => boolean> = {
  "image/jpeg": (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  "image/png": (h) =>
    h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47 && h[4] === 0x0d && h[5] === 0x0a,
};

export const inputFileName = (ordinal: number, mime: SupportedInputMime) =>
  `${String(ordinal + 1).padStart(6, "0")}.${SUPPORTED_INPUT_MIMES[mime]}`;

const invalid = (message: string) => new LocalReconstructionError("invalid_inputs", message, "preparing");

/** Structural checks that need no I/O: count, order, MIME, declared checksums. */
export function validateInputList(inputs: LocalReconstructionInput[], limits: InputLimits) {
  if (inputs.length < limits.minImages)
    throw invalid(`A local reconstruction needs at least ${limits.minImages} photographs.`);
  if (inputs.length > limits.maxImages)
    throw invalid(`A local reconstruction accepts at most ${limits.maxImages} photographs.`);
  const seen = new Set<string>();
  inputs.forEach((input, i) => {
    if (input.ordinal !== i)
      throw invalid("The photographs are not in a valid order (ordinals must be 0, 1, 2, …).");
    if (!(input.mime in SUPPORTED_INPUT_MIMES))
      throw invalid(
        `Photograph ${i + 1} is ${input.mime || "of unknown type"}; only JPEG and PNG are supported.`,
      );
    if (input.checksum !== null && !/^[0-9a-f]{64}$/.test(input.checksum))
      throw invalid(`Photograph ${i + 1} has a malformed checksum.`);
    if (input.checksum) {
      if (seen.has(input.checksum)) throw invalid(`Photograph ${i + 1} is the same image as an earlier one.`);
      seen.add(input.checksum);
    }
    if (input.source.kind === "file" && !path.isAbsolute(input.source.path))
      throw invalid(`Photograph ${i + 1} must be given as an absolute local path.`);
  });
}

async function sourceSize(input: LocalReconstructionInput): Promise<number> {
  if (input.source.kind === "bytes") return input.source.bytes.length;
  const s = await stat(input.source.path).catch(() => null);
  if (!s || !s.isFile()) throw invalid(`Photograph ${input.ordinal + 1} is not a readable file.`);
  return s.size;
}

async function sourceHead(input: LocalReconstructionInput): Promise<Uint8Array> {
  if (input.source.kind === "bytes") return input.source.bytes.subarray(0, 8);
  const fh = await open(input.source.path, "r");
  try {
    const buf = new Uint8Array(8);
    await fh.read(buf, 0, 8, 0);
    return buf;
  } finally {
    await fh.close();
  }
}

/** Copies every input into the workspace in order, hashing as it goes. Refuses anything inconsistent. */
export async function materializeInputs(
  ws: Workspace,
  inputs: LocalReconstructionInput[],
  limits: InputLimits,
  signal?: AbortSignal,
): Promise<MaterializedInput[]> {
  validateInputList(inputs, limits);
  let total = 0;
  for (const input of inputs) {
    const size = await sourceSize(input);
    if (size === 0) throw invalid(`Photograph ${input.ordinal + 1} is empty.`);
    if (size > limits.maxImageBytes)
      throw invalid(`Photograph ${input.ordinal + 1} is larger than the ${limits.maxImageBytes} byte limit.`);
    total += size;
    if (total > limits.maxTotalBytes)
      throw invalid(`The photographs together exceed the ${limits.maxTotalBytes} byte limit.`);
    const mime = input.mime as SupportedInputMime;
    if (!SIGNATURES[mime](await sourceHead(input)))
      throw invalid(`Photograph ${input.ordinal + 1} is not really a ${mime} file.`);
  }

  const out: MaterializedInput[] = [];
  const checksums = new Set<string>();
  for (const input of inputs) {
    if (signal?.aborted)
      throw new LocalReconstructionError("cancelled", "The reconstruction was cancelled.", "preparing");
    const mime = input.mime as SupportedInputMime;
    const fileName = inputFileName(input.ordinal, mime);
    const dest = inWorkspace(ws, "input", fileName);
    const hash = createHash("sha256");
    let byteSize = 0;
    if (input.source.kind === "bytes") {
      hash.update(input.source.bytes);
      byteSize = input.source.bytes.length;
      await writeFile(dest, input.source.bytes, { flag: "wx" });
    } else {
      const tap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          byteSize += chunk.length;
          cb(null, chunk);
        },
      });
      await pipeline(createReadStream(input.source.path), tap, createWriteStream(dest, { flags: "wx" }), {
        signal,
      }).catch((e: unknown) => {
        if (signal?.aborted)
          throw new LocalReconstructionError("cancelled", "The reconstruction was cancelled.", "preparing");
        throw invalid(
          `Photograph ${input.ordinal + 1} could not be copied (${(e as Error).message.slice(0, 80)}).`,
        );
      });
    }
    const checksum = hash.digest("hex");
    if (input.checksum && input.checksum !== checksum)
      throw invalid(`Photograph ${input.ordinal + 1} does not match its expected checksum.`);
    if (checksums.has(checksum))
      throw invalid(`Photograph ${input.ordinal + 1} is the same image as an earlier one.`);
    checksums.add(checksum);
    out.push({ ordinal: input.ordinal, fileName, mime, byteSize, checksum });
  }
  return out;
}

/** Streaming sha256 of a file (never reads it into one buffer). */
export async function sha256File(p: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(p),
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb();
      },
    }),
  );
  return hash.digest("hex");
}

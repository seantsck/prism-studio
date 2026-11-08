import { deflateSync } from "node:zlib";
import { encodeMockPng, seedFromString } from "../mock-image";
import {
  OpenAIImageTransportError,
  type OpenAIImageCall,
  type OpenAIImageCallResult,
  type OpenAIImageTransport,
} from "./transport";

/**
 * Test double for the OpenAI Images transport. Records every call, never touches the network, and answers with a
 * deterministic PNG of the requested size (RGBA with a transparent corner when `background: "transparent"`).
 */
export class FakeOpenAIImageTransport implements OpenAIImageTransport {
  readonly calls: OpenAIImageCall[] = [];
  /** Scripted failures, consumed in order before any success. */
  failures: OpenAIImageTransportError[] = [];
  usage: OpenAIImageCallResult["usage"] = {
    inputTokens: 120,
    outputTokens: 1500,
    textInputTokens: 100,
    imageInputTokens: 20,
  };

  async call(call: OpenAIImageCall): Promise<OpenAIImageCallResult> {
    this.calls.push({ ...call, images: call.images.map((i) => ({ ...i })) });
    const failure = this.failures.shift();
    if (failure) throw failure;
    const [w, h] = call.size.split("x").map(Number) as [number, number];
    // small, real PNGs keep the tests fast; the reported size is still the requested one
    const tw = Math.max(16, Math.round(w / 32));
    const th = Math.max(16, Math.round(h / 32));
    const png =
      call.background === "transparent"
        ? encodeRgbaPng(tw, th)
        : encodeMockPng(tw, th, seedFromString(`${call.model}|${call.prompt}`));
    return {
      b64: Buffer.from(png).toString("base64"),
      size: call.size,
      outputFormat: "png",
      background: call.background,
      quality: call.quality,
      created: 1_700_000_000,
      requestId: `req_fake_${this.calls.length}`,
      usage: this.usage,
    };
  }
}

/** A tiny RGBA PNG whose top-left quarter is fully transparent (alpha 0). */
export function encodeRgbaPng(width: number, height: number): Uint8Array {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 4;
      raw[o] = 200;
      raw[o + 1] = 60;
      raw[o + 2] = 90;
      raw[o + 3] = x < width / 2 && y < height / 2 ? 0 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  let c = 0xffffffff;
  for (const b of out.subarray(4, 8 + data.length)) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

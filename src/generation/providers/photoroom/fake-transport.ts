import { composeCutout } from "../../matting/engine";
import { decodePng, encodePngRgba } from "../../matting/png";
import {
  PhotoroomTransportError,
  type PhotoroomCall,
  type PhotoroomResult,
  type PhotoroomTransport,
} from "./transport";

/**
 * Test double for Photoroom: records every call, never touches the network, and answers with a deterministic RGBA PNG
 * of the input's size (an elliptical subject matte over the source pixels when the input is a PNG Prism can decode).
 */
export class FakePhotoroomTransport implements PhotoroomTransport {
  readonly calls: PhotoroomCall[] = [];
  failures: PhotoroomTransportError[] = [];

  async segment(call: PhotoroomCall): Promise<PhotoroomResult> {
    this.calls.push({ ...call, image: { ...call.image } });
    const f = this.failures.shift();
    if (f) throw f;
    const src = decodePng(call.image.bytes);
    const alpha = new Uint8Array(src.width * src.height);
    for (let y = 0; y < src.height; y++)
      for (let x = 0; x < src.width; x++) {
        const dx = (x - src.width / 2) / (src.width * 0.35);
        const dy = (y - src.height / 2) / (src.height * 0.45);
        const d = Math.sqrt(dx * dx + dy * dy);
        alpha[y * src.width + x] = d < 0.95 ? 255 : d > 1.05 ? 0 : Math.round(((1.05 - d) / 0.1) * 255);
      }
    return {
      bytes: encodePngRgba(composeCutout(src, { alpha, kind: "soft", details: {} })),
      contentType: "image/png",
      uncertaintyScore: 0.12,
    };
  }
}

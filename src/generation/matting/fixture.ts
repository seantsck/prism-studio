import { encodePngRgba, type RgbaImage } from "./png";

/**
 * Phase 5B-I3 acceptance fixture: a deterministic, fictional character portrait on a PLAIN background, stand-in for a
 * Yumeko reference. Long dark hair with antialiased stray strands (soft-edge test), a red dress, and a collar whose
 * colour is almost the background colour but is ENCLOSED by the dress (it must stay opaque).
 */
export const FIXTURE_BACKGROUND = [236, 228, 244] as const;
export const FIXTURE_COLLAR = [232, 226, 240] as const;

export function portraitFixture(width = 256, height = 320): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  const cx = width / 2;
  const set = (x: number, y: number, rgb: readonly number[], cover = 1) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const o = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) data[o + c] = Math.round(data[o + c]! * (1 - cover) + rgb[c]! * cover);
  };
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = FIXTURE_BACKGROUND[0];
    data[i * 4 + 1] = FIXTURE_BACKGROUND[1];
    data[i * 4 + 2] = FIXTURE_BACKGROUND[2];
    data[i * 4 + 3] = 255;
  }
  const hair = [38, 28, 58];
  const skin = [240, 204, 184];
  const dress = [176, 32, 48];
  const headY = height * 0.32;
  const headR = width * 0.17;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      // hair mass (behind the head, down to the shoulders), with a soft 2 px edge
      const hx = dx / (headR * 1.5);
      const hy = (y - headY * 1.15) / (headR * 2.1);
      const hd = Math.sqrt(hx * hx + hy * hy);
      if (hd < 1.04) set(x, y, hair, Math.min(1, Math.max(0, (1.04 - hd) * 25)));
      // dress from the shoulders down, with the enclosed collar
      const shoulders = height * 0.58;
      if (y > shoulders && Math.abs(dx) < width * 0.3 + (y - shoulders) * 0.25) {
        set(x, y, dress);
        if (y < shoulders + height * 0.08 && Math.abs(dx) < width * 0.09) set(x, y, FIXTURE_COLLAR);
      }
      // face
      if (Math.hypot(dx, y - headY) < headR) set(x, y, skin);
    }
  // stray hair strands: thin antialiased arcs out into the background
  for (let s = 0; s < 9; s++) {
    const angle = -Math.PI / 2 + (s - 4) * 0.28;
    for (let t = 0; t < 1; t += 0.002) {
      const r = headR * (1.45 + t * 0.9);
      const x = cx + Math.cos(angle + t * 0.6) * r;
      const y = headY * 1.05 + Math.sin(angle + t * 0.6) * r;
      const fx = Math.floor(x);
      const fy = Math.floor(y);
      // spread over 2×2 pixels by fractional coverage, fading toward the tip
      const fade = 0.85 * (1 - t);
      set(fx, fy, hair, fade * (1 - (x - fx)) * (1 - (y - fy)));
      set(fx + 1, fy, hair, fade * (x - fx) * (1 - (y - fy)));
      set(fx, fy + 1, hair, fade * (1 - (x - fx)) * (y - fy));
      set(fx + 1, fy + 1, hair, fade * (x - fx) * (y - fy));
    }
  }
  return { width, height, data };
}

export function portraitFixturePng(width?: number, height?: number): Uint8Array {
  return encodePngRgba(portraitFixture(width, height));
}

/** A busy background (the keyer must refuse it rather than produce a bad cutout). */
export function busyFixturePng(width = 128, height = 128): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = (x * 37 + y * 11) % 256;
      data[o + 1] = (x * 13 + y * 59) % 256;
      data[o + 2] = (x * 71 + y * 29) % 256;
      data[o + 3] = 255;
    }
  return encodePngRgba({ width, height, data });
}

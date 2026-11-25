import type { CoverDesign } from "@/domain/cover-design";

/**
 * Draws a cover the way a DVD or poster is laid out: the picture, then the title treatment of the chosen style (title,
 * subtitle, tagline, cast names across the top, a credits block at the foot). One drawing for the screen and for the
 * downloaded cover, at any size: every measure is a share of the width.
 */
export interface CoverText {
  title: string;
  cast: string[];
  /** e.g. "A series in 10 episodes" */
  kindLine: string;
}

const SERIF =
  '"Playfair Display", "Didot", "Bodoni 72", "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", "Noto Serif CJK JP", Georgia, "Times New Roman", serif';
const SANS =
  '"Avenir Next", "Helvetica Neue", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", "Noto Sans CJK JP", Arial, sans-serif';
const CONDENSED =
  '"Arial Narrow", "Avenir Next Condensed", "Helvetica Neue", "Noto Sans JP", Arial, sans-serif';

/** Lines may not start with these (Japanese line-breaking). */
const NO_START = "、。，．・：；？！ー」』）〕］｝〉》…‥ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ";

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const spaced = /\s/.test(text.trim());
  const units = spaced ? text.trim().split(/\s+/) : [...text.trim()];
  const join = spaced ? " " : "";
  const lines: string[] = [];
  let line = "";
  for (const u of units) {
    const next = line ? line + join + u : u;
    if (line && ctx.measureText(next).width > max && !(!spaced && NO_START.includes(u))) {
      lines.push(line);
      line = u;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** The largest font size (from `start` down) at which `text` fits `maxLines` lines of `maxWidth`. */
function fit(
  ctx: CanvasRenderingContext2D,
  text: string,
  font: (size: number) => string,
  start: number,
  maxWidth: number,
  maxLines: number,
): { size: number; lines: string[] } {
  // a Japanese title with a comma: break after the comma if that fits within 60% of the largest size
  const t = text.trim();
  const comma = [...t].findIndex((ch, i) => i > 0 && i < [...t].length - 1 && "、，".includes(ch));
  if (!/\s/.test(t) && comma > 0 && maxLines >= 2) {
    const chars = [...t];
    const halves = [chars.slice(0, comma + 1).join(""), chars.slice(comma + 1).join("")];
    for (let size = start; size > start * 0.6; size *= 0.94) {
      ctx.font = font(size);
      if (ctx.measureText(t).width <= maxWidth) return { size, lines: [t] };
      if (halves.every((h) => ctx.measureText(h).width <= maxWidth)) return { size, lines: halves };
    }
  }
  for (let size = start; size > start * 0.35; size *= 0.94) {
    ctx.font = font(size);
    const lines = wrap(ctx, text, maxWidth);
    if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxWidth))
      return { size, lines };
  }
  const size = start * 0.35;
  ctx.font = font(size);
  return { size, lines: wrap(ctx, text, maxWidth) };
}

function spacing(ctx: CanvasRenderingContext2D, px: number) {
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${px}px`;
}

function shade(ctx: CanvasRenderingContext2D, w: number, y0: number, y1: number, from: number, to: number) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, `rgba(0,0,0,${from})`);
  g.addColorStop(1, `rgba(0,0,0,${to})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, Math.min(y0, y1), w, Math.abs(y1 - y0));
}

/** Centred text, one line per entry, from baseline `y` down (or up with `step` < 0). Returns the last baseline. */
function lines(ctx: CanvasRenderingContext2D, ls: string[], x: number, y: number, step: number) {
  ls.forEach((l, i) => {
    ctx.fillText(l, x, y + i * step);
  });
  return y + (ls.length - 1) * step;
}

export function drawCover(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  image: CanvasImageSource | null,
  design: CoverDesign,
  text: CoverText,
) {
  const u = w / 100;
  const cx = w / 2;
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#111114";
  ctx.fillRect(0, 0, w, h);
  if (image) ctx.drawImage(image, 0, 0, w, h);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  // the creator's own cast line ("Yumeko & Sean") wins over the cast's names, on top and in the credits
  const castLine = design.castText.trim()
    ? design.castText.trim().toUpperCase()
    : text.cast
        .filter(Boolean)
        .map((c) => c.toUpperCase())
        .join("   ");
  const credits = [
    castLine ? `STARRING  ${castLine}` : "",
    text.kindLine.toUpperCase(),
    "A PRISM STUDIO PRODUCTION",
  ].filter(Boolean);

  const castRow = (y: number, color: string) => {
    if (!design.showCast || !castLine) return;
    const row = design.castText.trim() ? castLine : castLine.replace(/ {3}/g, "     ");
    ctx.fillStyle = color;
    ctx.shadowColor = "rgba(0,0,0,0.7)";
    ctx.shadowBlur = 1.4 * u;
    spacing(ctx, 0.55 * u);
    const { size, lines: ls } = fit(ctx, row, (s) => `700 ${s}px ${SANS}`, 4.4 * u, 90 * u, 1);
    ctx.font = `700 ${size}px ${SANS}`;
    lines(ctx, ls, cx, y, 0);
    ctx.shadowBlur = 0;
  };
  const creditBlock = (bottom: number) => {
    if (!design.showCredits) return bottom;
    ctx.font = `500 ${1.55 * u}px ${CONDENSED}`;
    spacing(ctx, 0.25 * u);
    ctx.fillStyle = "rgba(235,235,240,0.72)";
    const step = 2.2 * u;
    const top = bottom - (credits.length - 1) * step;
    lines(ctx, credits, cx, top, step);
    return top - 3 * u;
  };

  if (design.style === "cinematic") {
    shade(ctx, w, h * 0.5, h, 0, 0.9);
    shade(ctx, w, 0, h * 0.2, 0.6, 0);
    castRow(9 * u, "rgba(255,255,255,0.95)");
    let y = creditBlock(h - 4 * u);
    if (design.subtitle) {
      ctx.font = `italic 400 ${3.4 * u}px ${SERIF}`;
      spacing(ctx, 0.35 * u);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillText(design.subtitle, cx, y);
      y -= 5.5 * u;
    }
    const t = fit(ctx, text.title, (s) => `700 ${s}px ${SERIF}`, 12 * u, 88 * u, 2);
    ctx.font = `700 ${t.size}px ${SERIF}`;
    spacing(ctx, 0.04 * t.size);
    const top = y - (t.lines.length - 1) * t.size * 1.08;
    const gold = ctx.createLinearGradient(0, top - t.size, 0, y);
    gold.addColorStop(0, "#fbf1cf");
    gold.addColorStop(0.45, "#d8b25a");
    gold.addColorStop(0.55, "#b8892e");
    gold.addColorStop(1, "#f3dfa2");
    ctx.shadowColor = "rgba(0,0,0,0.75)";
    ctx.shadowBlur = 2 * u;
    ctx.shadowOffsetY = 0.4 * u;
    ctx.fillStyle = gold;
    lines(ctx, t.lines, cx, top, t.size * 1.08);
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    if (design.tagline) {
      ctx.font = `italic 400 ${2.9 * u}px ${SERIF}`;
      spacing(ctx, 0.2 * u);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      const tl = fit(ctx, design.tagline, (s) => `italic 400 ${s}px ${SERIF}`, 2.9 * u, 80 * u, 2);
      lines(ctx, tl.lines, cx, top - t.size - 2 * u - (tl.lines.length - 1) * tl.size * 1.2, tl.size * 1.2);
    }
  } else if (design.style === "bold") {
    shade(ctx, w, 0, h * 0.5, 0.75, 0);
    shade(ctx, w, h * 0.72, h, 0, 0.85);
    const t = fit(ctx, text.title, (s) => `900 ${s}px ${SANS}`, 13 * u, 90 * u, 2);
    ctx.font = `900 ${t.size}px ${SANS}`;
    spacing(ctx, 0);
    const first = 9 * u + t.size;
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(2, t.size * 0.09);
    ctx.strokeStyle = "rgba(20,8,14,0.95)";
    t.lines.forEach((l, i) => ctx.strokeText(l, cx, first + i * t.size * 1.1));
    ctx.shadowColor = "rgba(255,70,110,0.85)";
    ctx.shadowBlur = 3 * u;
    const fill = ctx.createLinearGradient(0, first - t.size, 0, first + (t.lines.length - 1) * t.size * 1.1);
    fill.addColorStop(0, "#ffffff");
    fill.addColorStop(1, "#ffd6e2");
    ctx.fillStyle = fill;
    const last = lines(ctx, t.lines, cx, first, t.size * 1.1);
    ctx.shadowBlur = 0;
    let y = last + 4.5 * u;
    if (design.subtitle) {
      ctx.font = `700 ${3.4 * u}px ${SANS}`;
      spacing(ctx, 0.5 * u);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(design.subtitle.toUpperCase(), cx, y);
      y += 4.5 * u;
    }
    if (design.tagline) {
      ctx.font = `500 ${2.7 * u}px ${SANS}`;
      spacing(ctx, 0.1 * u);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      const tl = fit(ctx, design.tagline, (s) => `500 ${s}px ${SANS}`, 2.7 * u, 80 * u, 2);
      lines(ctx, tl.lines, cx, y, tl.size * 1.25);
    }
    const foot = creditBlock(h - 4 * u);
    castRow(foot, "rgba(255,255,255,0.95)");
  } else {
    shade(ctx, w, 0, h * 0.36, 0.7, 0);
    shade(ctx, w, h * 0.75, h, 0, 0.8);
    const t = fit(ctx, text.title, (s) => `400 ${s}px ${SERIF}`, 9 * u, 80 * u, 2);
    ctx.font = `400 ${t.size}px ${SERIF}`;
    spacing(ctx, 0.12 * t.size);
    const first = 9 * u + t.size;
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = Math.max(1, 0.18 * u);
    const rule = (y: number) => {
      ctx.beginPath();
      ctx.moveTo(cx - 18 * u, y);
      ctx.lineTo(cx + 18 * u, y);
      ctx.stroke();
    };
    rule(first - t.size - 2.5 * u);
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 1.5 * u;
    const last = lines(ctx, t.lines, cx, first, t.size * 1.15);
    ctx.shadowBlur = 0;
    let y = last + 3 * u;
    rule(y);
    if (design.subtitle) {
      y += 4.2 * u;
      ctx.font = `italic 400 ${3 * u}px ${SERIF}`;
      spacing(ctx, 0.3 * u);
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillText(design.subtitle, cx, y);
    }
    let foot = creditBlock(h - 4 * u);
    if (design.tagline) {
      ctx.font = `italic 400 ${2.8 * u}px ${SERIF}`;
      spacing(ctx, 0.15 * u);
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      const tl = fit(ctx, design.tagline, (s) => `italic 400 ${s}px ${SERIF}`, 2.8 * u, 80 * u, 2);
      lines(ctx, tl.lines, cx, foot - (tl.lines.length - 1) * tl.size * 1.2, tl.size * 1.2);
      foot -= tl.lines.length * tl.size * 1.2 + 2 * u;
    }
    castRow(foot, "rgba(255,255,255,0.9)");
  }
  ctx.restore();
}

/** Loads a picture for drawing (same-origin: the canvas stays exportable). */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The picture could not be loaded."));
    img.src = src;
  });
}

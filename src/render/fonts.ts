import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TitleStyle } from "@/domain/edit/model";
import type { TitleFonts } from "./plan";

/**
 * Phase 5B-V4 title fonts. Titles must render Japanese (Ojou-sama: お嬢様、僕と結婚してください。) WITHOUT depending
 * on whatever happens to be installed for a user, and without bundling a proprietary font. Strategy:
 *
 *   * only OPEN (SIL OFL) CJK families are ever used: Noto Serif JP / Noto Serif CJK for Film, Noto Sans JP / Noto Sans
 *     CJK for Plain. Never a proprietary system face (Yu Gothic, MS Gothic, Hiragino…), even when present;
 *   * the worker looks in an explicit directory first (`PRISM_STUDIO_RENDER_FONT_DIR`, the hosted path: install
 *     `fonts-noto-cjk` or copy the OFL files there), then the standard system locations;
 *   * FAIL CLOSED: no suitable font → the render fails with a clear error before any title is drawn (never a fallback
 *     face with missing glyphs);
 *   * the chosen file's family and sha256 are part of every title segment's cache key and of the render provenance.
 *
 * Film → serif (film-title typography), Plain → sans. Deterministic: the first candidate that exists wins, in this order.
 */

export interface ResolvedFont {
  style: TitleStyle;
  family: string;
  file: string;
  checksum: string;
}

const CANDIDATES: Record<TitleStyle, Array<{ family: string; files: string[] }>> = {
  film: [
    {
      family: "Noto Serif JP",
      files: ["NotoSerifJP-VF.ttf", "NotoSerifJP-Regular.otf", "NotoSerifJP-Regular.ttf"],
    },
    { family: "Noto Serif CJK", files: ["NotoSerifCJK-Regular.ttc", "NotoSerifCJKjp-Regular.otf"] },
  ],
  plain: [
    {
      family: "Noto Sans JP",
      files: ["NotoSansJP-VF.ttf", "NotoSansJP-Regular.otf", "NotoSansJP-Regular.ttf"],
    },
    { family: "Noto Sans CJK", files: ["NotoSansCJK-Regular.ttc", "NotoSansCJKjp-Regular.otf"] },
  ],
};

/** Where fonts are looked for, explicit directory first. */
export function fontSearchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [
    env.PRISM_STUDIO_RENDER_FONT_DIR,
    // Linux (fonts-noto-cjk / google-noto-*-cjk), macOS user + system, Windows
    "/usr/share/fonts/opentype/noto",
    "/usr/share/fonts/noto-cjk",
    "/usr/share/fonts/google-noto-serif-cjk-vf-fonts",
    "/usr/share/fonts/google-noto-sans-cjk-vf-fonts",
    "/usr/share/fonts/truetype/noto",
    "/Library/Fonts",
    env.HOME ? path.join(env.HOME, "Library/Fonts") : undefined,
    env.SystemRoot ? path.join(env.SystemRoot, "Fonts") : undefined,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Microsoft/Windows/Fonts") : undefined,
  ];
  return dirs.filter((d): d is string => Boolean(d));
}

export class TitleFontError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TitleFontError";
  }
}

async function findFont(style: TitleStyle, dirs: string[]): Promise<ResolvedFont | null> {
  for (const candidate of CANDIDATES[style])
    for (const dir of dirs)
      for (const name of candidate.files) {
        const file = path.join(dir, name);
        const bytes = await readFile(file).catch(() => null);
        if (bytes && bytes.length > 0)
          return {
            style,
            family: candidate.family,
            file,
            checksum: createHash("sha256").update(bytes).digest("hex"),
          };
      }
  return null;
}

/** Both title faces, or a `TitleFontError` naming what to install. */
export async function resolveTitleFonts(
  dirs: string[] = fontSearchDirs(),
): Promise<{ film: ResolvedFont; plain: ResolvedFont }> {
  const [film, plain] = await Promise.all([findFont("film", dirs), findFont("plain", dirs)]);
  if (!film || !plain)
    throw new TitleFontError(
      `No open CJK title font is available to the renderer (${[
        !film && "Noto Serif JP/CJK",
        !plain && "Noto Sans JP/CJK",
      ]
        .filter(Boolean)
        .join(", ")}). Install fonts-noto-cjk or set PRISM_STUDIO_RENDER_FONT_DIR.`,
    );
  return { film, plain };
}

export const titleFontIdentity = (f: { film: ResolvedFont; plain: ResolvedFont }): TitleFonts => ({
  film: { family: f.film.family, checksum: f.film.checksum },
  plain: { family: f.plain.family, checksum: f.plain.checksum },
});

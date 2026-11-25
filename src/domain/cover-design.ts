/**
 * How the title is laid over a cover (the picture itself carries no lettering): a DVD / poster-style design the creator
 * chooses and edits. Stored with the cover picture (`asset.metadata.cover.design`); drawn in the browser, on screen and
 * into the downloaded cover.
 */
export const COVER_STYLES = [
  {
    id: "cinematic",
    label: "Cinematic",
    hint: "Gold serif title at the top, the cast and credits at the foot",
  },
  { id: "bold", label: "Bold drama", hint: "Big outlined title high in the frame, with a glow" },
  { id: "elegant", label: "Elegant", hint: "Fine serif title at the top between thin rules" },
] as const;
export type CoverStyle = (typeof COVER_STYLES)[number]["id"];

/** Title colours: the style's own, or one the creator picks. */
export const COVER_TITLE_COLORS = [
  { id: "auto", label: "Style's own" },
  { id: "gold", label: "Gold" },
  { id: "white", label: "White" },
  { id: "silver", label: "Silver" },
  { id: "pink", label: "Pink" },
  { id: "red", label: "Red" },
] as const;
export type CoverTitleColor = (typeof COVER_TITLE_COLORS)[number]["id"];

/** How far the title can be resized (percent of the style's size) and moved (percent of the cover's height). */
export const COVER_TITLE_SCALE = { min: 60, max: 150 } as const;
export const COVER_TITLE_SHIFT = { min: -45, max: 45 } as const;
/** The cast line is short, so it can grow further than the title. */
export const COVER_CAST_SCALE = { min: 60, max: 200 } as const;
export const COVER_CAST_SHIFT = { min: -90, max: 90 } as const;

export interface CoverDesign {
  style: CoverStyle;
  /** A second title line, e.g. the English title of a Japanese series (may be empty). */
  subtitle: string;
  /** A short line that sells it (may be empty). */
  tagline: string;
  /** The cast line as the creator writes it, e.g. "Yumeko & Sean" (empty: the cast's names). Also the STARRING credit. */
  castText: string;
  /** Cast names across the top. */
  showCast: boolean;
  /** The title's size, percent of the style's own (100 = as designed). */
  titleScale: number;
  /** The title block moved down (+) or up (-), percent of the cover's height. */
  titleShift: number;
  titleColor: CoverTitleColor;
  /** The cast line's size, percent of the style's own. */
  castScale: number;
  /** The cast line moved down (+) or up (-), percent of the cover's height. */
  castShift: number;
  castColor: CoverTitleColor;
  /** A credits block at the foot. */
  showCredits: boolean;
}

export const COVER_TEXT_MAX = { subtitle: 80, tagline: 120, castText: 80 } as const;

export const DEFAULT_COVER_DESIGN: CoverDesign = {
  style: "cinematic",
  subtitle: "",
  tagline: "",
  castText: "",
  showCast: true,
  titleScale: 100,
  titleShift: 0,
  titleColor: "auto",
  castScale: 100,
  castShift: 0,
  castColor: "auto",
  showCredits: true,
};

/** A design read from untrusted input (a form, stored JSON): every field checked, anything else the default. */
export function coverDesignOf(raw: unknown): CoverDesign {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
  return {
    style: COVER_STYLES.some((s) => s.id === r.style) ? (r.style as CoverStyle) : DEFAULT_COVER_DESIGN.style,
    subtitle: text(r.subtitle, COVER_TEXT_MAX.subtitle),
    tagline: text(r.tagline, COVER_TEXT_MAX.tagline),
    castText: text(r.castText, COVER_TEXT_MAX.castText),
    titleScale: num(
      r.titleScale,
      COVER_TITLE_SCALE.min,
      COVER_TITLE_SCALE.max,
      DEFAULT_COVER_DESIGN.titleScale,
    ),
    titleShift: num(
      r.titleShift,
      COVER_TITLE_SHIFT.min,
      COVER_TITLE_SHIFT.max,
      DEFAULT_COVER_DESIGN.titleShift,
    ),
    titleColor: COVER_TITLE_COLORS.some((c) => c.id === r.titleColor)
      ? (r.titleColor as CoverTitleColor)
      : DEFAULT_COVER_DESIGN.titleColor,
    castScale: num(r.castScale, COVER_CAST_SCALE.min, COVER_CAST_SCALE.max, DEFAULT_COVER_DESIGN.castScale),
    castShift: num(r.castShift, COVER_CAST_SHIFT.min, COVER_CAST_SHIFT.max, DEFAULT_COVER_DESIGN.castShift),
    castColor: COVER_TITLE_COLORS.some((c) => c.id === r.castColor)
      ? (r.castColor as CoverTitleColor)
      : DEFAULT_COVER_DESIGN.castColor,
    showCast: typeof r.showCast === "boolean" ? r.showCast : DEFAULT_COVER_DESIGN.showCast,
    showCredits: typeof r.showCredits === "boolean" ? r.showCredits : DEFAULT_COVER_DESIGN.showCredits,
  };
}

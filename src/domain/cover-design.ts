/**
 * How the title is laid over a cover (the picture itself carries no lettering): a DVD / poster-style design the creator
 * chooses and edits. Stored with the cover picture (`asset.metadata.cover.design`); drawn in the browser, on screen and
 * into the downloaded cover.
 */
export const COVER_STYLES = [
  {
    id: "cinematic",
    label: "Cinematic",
    hint: "Title low in a gold serif, tagline above, credits at the foot",
  },
  { id: "bold", label: "Bold drama", hint: "Big outlined title high in the frame, with a glow" },
  { id: "elegant", label: "Elegant", hint: "Fine serif title at the top between thin rules" },
] as const;
export type CoverStyle = (typeof COVER_STYLES)[number]["id"];

export interface CoverDesign {
  style: CoverStyle;
  /** A second title line, e.g. the English title of a Japanese series (may be empty). */
  subtitle: string;
  /** A short line that sells it (may be empty). */
  tagline: string;
  /** Cast names across the top. */
  showCast: boolean;
  /** A credits block at the foot. */
  showCredits: boolean;
}

export const COVER_TEXT_MAX = { subtitle: 80, tagline: 120 } as const;

export const DEFAULT_COVER_DESIGN: CoverDesign = {
  style: "cinematic",
  subtitle: "",
  tagline: "",
  showCast: true,
  showCredits: true,
};

/** A design read from untrusted input (a form, stored JSON): every field checked, anything else the default. */
export function coverDesignOf(raw: unknown): CoverDesign {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  return {
    style: COVER_STYLES.some((s) => s.id === r.style) ? (r.style as CoverStyle) : DEFAULT_COVER_DESIGN.style,
    subtitle: text(r.subtitle, COVER_TEXT_MAX.subtitle),
    tagline: text(r.tagline, COVER_TEXT_MAX.tagline),
    showCast: typeof r.showCast === "boolean" ? r.showCast : DEFAULT_COVER_DESIGN.showCast,
    showCredits: typeof r.showCredits === "boolean" ? r.showCredits : DEFAULT_COVER_DESIGN.showCredits,
  };
}

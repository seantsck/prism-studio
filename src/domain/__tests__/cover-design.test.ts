import { describe, expect, it } from "vitest";
import { COVER_TEXT_MAX, DEFAULT_COVER_DESIGN, coverDesignOf } from "../cover-design";

describe("coverDesignOf", () => {
  it("gives the default for missing or malformed input", () => {
    expect(coverDesignOf(undefined)).toEqual(DEFAULT_COVER_DESIGN);
    expect(coverDesignOf("cinematic")).toEqual(DEFAULT_COVER_DESIGN);
    expect(coverDesignOf({ style: "neon", showCast: "yes", subtitle: 4 })).toEqual(DEFAULT_COVER_DESIGN);
  });

  it("keeps a valid design, trimming the text", () => {
    expect(
      coverDesignOf({
        style: "bold",
        subtitle: "  Will You Marry Me, My Lady?  ",
        tagline: "One proposal. No conditions.",
        castText: " Yumeko & Sean ",
        showCast: false,
        showCredits: false,
        extra: "ignored",
      }),
    ).toEqual({
      style: "bold",
      subtitle: "Will You Marry Me, My Lady?",
      tagline: "One proposal. No conditions.",
      castText: "Yumeko & Sean",
      showCast: false,
      showCredits: false,
    });
  });

  it("caps the subtitle and tagline length", () => {
    const d = coverDesignOf({ subtitle: "a".repeat(500), tagline: "b".repeat(500), castText: "c".repeat(500) });
    expect(d.castText).toHaveLength(COVER_TEXT_MAX.castText);
    expect(d.subtitle).toHaveLength(COVER_TEXT_MAX.subtitle);
    expect(d.tagline).toHaveLength(COVER_TEXT_MAX.tagline);
  });
});

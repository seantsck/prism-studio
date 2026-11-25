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
      titleScale: 100,
      titleShift: 0,
      titleColor: "auto",
    });
  });

  it("caps the subtitle and tagline length", () => {
    const d = coverDesignOf({ subtitle: "a".repeat(500), tagline: "b".repeat(500), castText: "c".repeat(500) });
    expect(d.castText).toHaveLength(COVER_TEXT_MAX.castText);
    expect(d.subtitle).toHaveLength(COVER_TEXT_MAX.subtitle);
    expect(d.tagline).toHaveLength(COVER_TEXT_MAX.tagline);
  });
});

describe("the title's size, position and colour", () => {
  it("defaults to the style's own and clamps what is out of range", () => {
    expect(coverDesignOf({})).toMatchObject({ titleScale: 100, titleShift: 0, titleColor: "auto" });
    expect(coverDesignOf({ titleScale: 999, titleShift: -999, titleColor: "red" })).toMatchObject({
      titleScale: 150,
      titleShift: -45,
      titleColor: "red",
    });
    expect(coverDesignOf({ titleScale: "big", titleShift: Number.NaN, titleColor: "plaid" })).toMatchObject({
      titleScale: 100,
      titleShift: 0,
      titleColor: "auto",
    });
  });
});

import { describe, expect, it } from "vitest";
import { paidConfirmationRefusal } from "../paid-confirmation";
import {
  CHARACTER_PRESETS,
  closestFormat,
  defaultStartingImages,
  editInstruction,
  editPresets,
  inspectReferenceImage,
  LOCATION_PRESETS,
  offersTestModels,
  opensOnStartingImages,
  preferredFormat,
  presetDirection,
  referencePreset,
  startingImagesAfterUpload,
  type StartCandidate,
  typicalCost,
  usd,
  type CostSample,
} from "../reference-studio";
import { CHARACTER_IMAGE_INTENTS, LOCATION_IMAGE_INTENTS } from "../subject-image";

/**
 * The Reference Studio's pure rules: what can be made from a reference, how one image can be changed, what a stored
 * file is good for, which picture shape suits what, and what similar images really cost.
 */
describe("what the Studio can make", () => {
  it("offers every angle a face reference is turned into, each on an existing image intent", () => {
    const intents = CHARACTER_PRESETS.map((p) => p.intent);
    for (const wanted of [
      "portrait",
      "three_quarter",
      "profile_left",
      "profile_right",
      "half_body",
      "full_body",
      "outfit_variant",
    ])
      expect(intents).toContain(wanted);
    for (const p of CHARACTER_PRESETS) expect(CHARACTER_IMAGE_INTENTS).toContain(p.intent);
    for (const p of LOCATION_PRESETS) expect(LOCATION_IMAGE_INTENTS).toContain(p.intent);
    expect(new Set(intents).size).toBe(intents.length);
  });

  it("suggests the Visual Bible slot a result naturally fills; the creator still chooses", () => {
    expect(referencePreset("character", "portrait")?.slot).toBe("front");
    expect(referencePreset("character", "three_quarter")?.slot).toBe("three_quarter");
    expect(referencePreset("character", "profile_left")?.slot).toBe("profile");
    expect(referencePreset("character", "full_body")?.slot).toBe("full_body");
    // there is one profile slot: the second profile and the half body are extra references
    expect(referencePreset("character", "profile_right")?.slot).toBe("additional");
    expect(referencePreset("character", "half_body")?.slot).toBe("additional");
    expect(referencePreset("location", "portrait")).toBeNull();
  });

  it("a preset about a value leads the direction with it; other presets pass the direction through", () => {
    const expression = referencePreset("character", "expression_variant");
    expect(presetDirection(expression, " concerned. ", "eyes down")).toBe("Expression: concerned. eyes down");
    expect(presetDirection(expression, "", "eyes down")).toBe("eyes down");
    expect(presetDirection(referencePreset("character", "portrait"), "ignored", "soft smile")).toBe(
      "soft smile",
    );
    expect(presetDirection(referencePreset("location", "time_variant"), "rainy night", "")).toBe(
      "Time or state: rainy night.",
    );
  });
});

describe("how one image can be changed", () => {
  it("offers the edits a filmmaker asks for, per kind of subject", () => {
    expect(editPresets("character").map((p) => p.id)).toEqual([
      "hair_color",
      "wardrobe",
      "lighting_quality",
      "clean_background",
      "replace_background",
      "custom",
    ]);
    expect(editPresets("location").map((p) => p.id)).toEqual(["lighting_quality", "remove_people", "custom"]);
  });

  it("names the ONE thing that changes", () => {
    expect(editInstruction("hair_color", "auburn")).toEqual({
      ok: true,
      instruction: "Change the hair colour to auburn. Keep the same hairstyle, length and hairline.",
    });
    expect(editInstruction("replace_background", "a rain-wet street at night.")).toMatchObject({
      ok: true,
      instruction: expect.stringMatching(/^Replace the background with: a rain-wet street at night\. /),
    });
    const quality = editInstruction("lighting_quality", "");
    expect(quality.ok && quality.instruction).toMatch(/Do not change the content of the picture\.$/);
    const clean = editInstruction("clean_background", "");
    expect(clean.ok && clean.instruction).toMatch(/plain light-grey studio backdrop/);
  });

  it("a wardrobe change takes typed words or one of the Character's Looks", () => {
    expect(editInstruction("wardrobe", "")).toEqual({
      ok: false,
      reason: "Describe the new clothing, or choose a Look.",
    });
    expect(editInstruction("wardrobe", "charcoal overcoat")).toMatchObject({
      ok: true,
      instruction: "Change the clothing to: charcoal overcoat. Keep the body, pose and proportions.",
    });
    const look = editInstruction("wardrobe", "", { name: "Episode 1 — Formal Black" });
    expect(look.ok && look.instruction).toMatch(/to the Look "Episode 1 — Formal Black" described below\./);
  });

  it("refuses an edit that does not say what it should be, and an unknown one", () => {
    expect(editInstruction("hair_color", "  ")).toEqual({
      ok: false,
      reason: "New hair colour: say what it should be.",
    });
    expect(editInstruction("custom", "")).toMatchObject({ ok: false });
    expect(editInstruction("nonsense", "x")).toEqual({ ok: false, reason: "Choose what to change." });
    // the creator's own words are kept in full (not cut to a short value)
    const long = "add thin gold-rimmed glasses, ".repeat(20);
    const custom = editInstruction("custom", long);
    expect(custom.ok && custom.instruction.length).toBe(long.trim().length);
  });
});

describe("picture format", () => {
  const gpt = ["1:1", "3:2", "2:3", "16:9", "9:16"];
  const mock = ["16:9", "9:16", "1:1"];

  it("a preset takes the first of its preferred shapes that the model offers", () => {
    const portrait = referencePreset("character", "portrait")!;
    expect(preferredFormat(portrait.ratios, gpt)).toBe("2:3");
    expect(preferredFormat(portrait.ratios, mock)).toBe("9:16");
    expect(preferredFormat(referencePreset("location", "location_concept")!.ratios, gpt)).toBe("16:9");
    expect(preferredFormat(["7:5"], gpt)).toBe("1:1");
    expect(preferredFormat(["7:5"], [])).toBeNull();
  });

  it("an edit comes back in the shape closest to the image it started from", () => {
    expect(closestFormat(1200, 1600, gpt)).toBe("2:3");
    expect(closestFormat(1600, 1200, gpt)).toBe("3:2");
    expect(closestFormat(1920, 1080, gpt)).toBe("16:9");
    expect(closestFormat(1000, 1000, gpt)).toBe("1:1");
    expect(closestFormat(null, null, gpt)).toBe("1:1");
  });
});

describe("what a stored file is good for (facts only: Prism does not look at the picture)", () => {
  const file = (over: Record<string, unknown>) =>
    ({ width: 1200, height: 1600, mime: "image/jpeg", byteSize: 400_000, metadata: {}, ...over }) as never;

  it("judges size by the shorter side and says what it means", () => {
    expect(inspectReferenceImage(file({}))).toMatchObject({
      verdict: "good",
      summary: "Good size",
      format: "JPEG",
      megapixels: 1.92,
      orientation: "portrait",
      shortSide: 1200,
      usableAsInput: true,
    });
    const usable = inspectReferenceImage(file({ width: 640, height: 800 }));
    expect(usable.verdict).toBe("usable");
    expect(usable.notes[0]).toMatch(/640 px.*1024 px or more/);
    const low = inspectReferenceImage(file({ width: 320, height: 400 }));
    expect(low.verdict).toBe("low");
    expect(low.notes[0]).toMatch(/320 px.*larger original/);
    expect(inspectReferenceImage(file({ width: null, height: null })).verdict).toBe("unknown");
  });

  it("a format or size a model cannot take is kept as the original and named as such", () => {
    const avif = inspectReferenceImage(file({ mime: "image/avif" }));
    expect(avif).toMatchObject({ format: "AVIF", usableAsInput: false });
    expect(avif.notes.join(" ")).toMatch(/AVIF is kept as your original.*JPEG, PNG or WebP/);
    expect(inspectReferenceImage(file({ byteSize: 30 * 1024 * 1024 })).usableAsInput).toBe(false);
    expect(inspectReferenceImage(file({ mime: "image/webp" })).usableAsInput).toBe(true);
  });

  it("a photograph its camera stored turned is described the way it is shown, and flagged", () => {
    // 4032 × 3024 in the file, flagged "turn a quarter": a portrait on screen
    const turned = inspectReferenceImage(
      file({ width: 4032, height: 3024, metadata: { exifOrientation: 6 } }),
    );
    expect(turned).toMatchObject({ width: 3024, height: 4032, orientation: "portrait", turned: true });
    expect(turned.shortSide).toBe(3024);
    expect(turned.notes.join(" ")).toMatch(/stored this photo turned.*an upright copy is uploaded/);
    // upside down: the sides stay where they are
    expect(
      inspectReferenceImage(file({ width: 4032, height: 3024, metadata: { exifOrientation: 3 } })),
    ).toMatchObject({ width: 4032, height: 3024, orientation: "landscape", turned: true });
    for (const metadata of [{}, { exifOrientation: 1 }, { exifOrientation: "6" }])
      expect(inspectReferenceImage(file({ metadata }))).toMatchObject({ width: 1200, turned: false });
  });

  it("a copy made in the browser at upload says so, with the file it was made from", () => {
    const uploadCopy = {
      name: "IMG_2041.jpg",
      bytes: 8598323,
      width: 3024,
      height: 4032,
      reasons: ["too_large"],
    };
    const copy = inspectReferenceImage(file({ width: 1536, height: 2048, metadata: { uploadCopy } }));
    expect(copy.turned).toBe(false);
    expect(copy.notes).toContain(
      "A smaller copy made in the browser when it was added: one upload here could not carry it at full size. The file chosen was IMG_2041.jpg (3024 × 4032, 8.2 MB); it was not uploaded.",
    );
    // a record that does not hold together is not repeated to the creator
    expect(
      inspectReferenceImage(file({ metadata: { uploadCopy: { name: "x" } } })).notes.join(" "),
    ).not.toMatch(/copy made in the browser/);
  });

  it("flags a very long shape, such as a full phone screenshot", () => {
    // 1080 × 2400: a phone screen
    const screenshot = inspectReferenceImage(file({ width: 1080, height: 2400, mime: "image/png" }));
    expect(screenshot).toMatchObject({ elongated: true, verdict: "good" });
    expect(screenshot.notes.join(" ")).toMatch(/very long shape/);
    expect(inspectReferenceImage(file({ width: 2400, height: 1080 })).elongated).toBe(true);
    for (const [width, height] of [
      [1080, 1286],
      [1080, 1920],
      [1200, 1600],
    ])
      expect(inspectReferenceImage(file({ width, height })).elongated, `${width}x${height}`).toBe(false);
    expect(inspectReferenceImage(file({ width: null, height: null })).elongated).toBe(false);
  });

  it("never claims to have judged the picture itself", () => {
    for (const a of [file({}), file({ width: 320, height: 400 }), file({ mime: "image/gif" })])
      expect(inspectReferenceImage(a).notes.at(-1)).toBe(
        "Sharpness, lighting and expression are not measured: judge them by eye.",
      );
    expect(inspectReferenceImage(file({ metadata: { hasAlpha: true } })).hasAlpha).toBe(true);
    expect(inspectReferenceImage(file({ width: 3000, height: 1000 })).notes.join(" ")).toMatch(
      /very long shape/,
    );
  });
});

describe("which pictures a generation starts from", () => {
  const photo = (assetId: string, over: Partial<StartCandidate> = {}): StartCandidate => ({
    assetId,
    origin: "uploaded",
    wardrobeOnly: false,
    canonical: false,
    ...over,
  });
  const generated = (assetId: string, over: Partial<StartCandidate> = {}) =>
    photo(assetId, { origin: "generated", ...over });

  it("a fresh Studio starts from ALL of the creator's own photographs, not from a generated picture beside them", () => {
    const canonical = generated("g-canonical", { canonical: true });
    expect(defaultStartingImages([canonical, photo("p1"), photo("p2"), generated("g-take")])).toEqual([
      "p1",
      "p2",
    ]);
    // a Look's wardrobe photo shows what is worn, not who the Character is
    expect(defaultStartingImages([photo("p1"), photo("gown", { wardrobeOnly: true })])).toEqual(["p1"]);
    // an uploaded photo that IS the canonical identity is simply one of the creator's photographs
    expect(defaultStartingImages([photo("p1", { canonical: true }), photo("p2")])).toEqual(["p1", "p2"]);
  });

  it("with no photograph of the creator's, it starts from the picture that stands for the subject, else from words", () => {
    expect(
      defaultStartingImages([generated("g-take"), generated("g-canonical", { canonical: true })]),
    ).toEqual(["g-canonical"]);
    expect(defaultStartingImages([generated("g-take"), photo("gown", { wardrobeOnly: true })])).toEqual([]);
    expect(defaultStartingImages([])).toEqual([]);
  });

  it("every photograph just added is selected, and a generated picture selected only by default gives way", () => {
    const images = [
      generated("g-canonical", { canonical: true }),
      photo("p1"),
      photo("p2"),
      photo("p3"),
      photo("p4"),
    ];
    expect(
      startingImagesAfterUpload({
        selected: ["g-canonical"],
        images,
        added: ["p1", "p2", "p3", "p4"],
        chosenByCreator: false,
      }),
    ).toEqual(["p1", "p2", "p3", "p4"]);
    // photographs that were already selected stay in front, in their order
    expect(
      startingImagesAfterUpload({
        selected: ["p2", "p1"],
        images,
        added: ["p3", "p4"],
        chosenByCreator: false,
      }),
    ).toEqual(["p2", "p1", "p3", "p4"]);
  });

  it("a selection the creator made themselves is kept whole when photographs are added", () => {
    const images = [generated("g-take"), photo("p1"), photo("p2")];
    expect(
      startingImagesAfterUpload({ selected: ["g-take", "p1"], images, added: ["p2"], chosenByCreator: true }),
    ).toEqual(["g-take", "p1", "p2"]);
    // nothing selected on purpose ("Words only"), then photographs added: they were added to be used
    expect(
      startingImagesAfterUpload({ selected: [], images, added: ["p1", "p2"], chosenByCreator: true }),
    ).toEqual(["p1", "p2"]);
  });

  it("only pictures that exist are selected, each once", () => {
    const images = [photo("p1"), photo("p2")];
    expect(
      startingImagesAfterUpload({
        selected: ["gone", "p1"],
        images,
        added: ["p2", "p2", "not-there"],
        chosenByCreator: true,
      }),
    ).toEqual(["p1", "p2"]);
    // nothing was actually added: the selection is left alone
    expect(
      startingImagesAfterUpload({ selected: ["p1"], images, added: ["not-there"], chosenByCreator: false }),
    ).toEqual(["p1"]);
  });

  it("the stage opens on photographs added since the newest picture was made, otherwise on that picture", () => {
    const made = "2026-11-11T08:00:00.000Z";
    // the hosted case: four photographs added nine days after the last generated picture
    const added = (id: string, addedAt: string) => photo(id, { addedAt });
    expect(
      opensOnStartingImages(
        [added("p1", "2026-11-20T19:15:02.000Z"), generated("g", { addedAt: made, canonical: true })],
        made,
      ),
    ).toBe(true);
    // Postgres writes the same instant with an offset: it is compared as a time, not as text
    expect(opensOnStartingImages([added("p1", "2026-11-11T09:00:00+01:00")], made)).toBe(false);
    expect(opensOnStartingImages([added("p1", "2026-11-11T10:00:01+01:00")], made)).toBe(true);
    // every photograph is older than the newest picture: that picture is what the creator comes back to
    expect(
      opensOnStartingImages(
        [added("p1", "2026-11-01T00:00:00.000Z"), added("p2", "2026-11-02T00:00:00.000Z")],
        made,
      ),
    ).toBe(false);
    // one photograph added since is enough
    expect(
      opensOnStartingImages(
        [added("p1", "2026-11-01T00:00:00.000Z"), added("p2", "2026-11-12T00:00:00.000Z")],
        made,
      ),
    ).toBe(true);
    // nothing made yet: the photographs are all there is to show
    expect(opensOnStartingImages([photo("p1")], null)).toBe(true);
    // a generated picture or a Look's wardrobe photo added since is not a photograph of the subject to start from
    expect(opensOnStartingImages([generated("g", { addedAt: "2026-11-20T00:00:00.000Z" })], made)).toBe(
      false,
    );
    expect(
      opensOnStartingImages(
        [photo("gown", { wardrobeOnly: true, addedAt: "2026-11-20T00:00:00.000Z" })],
        made,
      ),
    ).toBe(false);
    // a photograph whose time is unknown or unreadable never hides a result
    expect(opensOnStartingImages([photo("p1"), added("p2", "not a time")], made)).toBe(false);
    expect(opensOnStartingImages([], made)).toBe(false);
  });
});

describe("test models", () => {
  const model = (test: boolean, available: boolean) => ({ test, available });

  it("are offered only where no real model can be used, unless the deployment asks for them", () => {
    // a deployment with a usable real model: the test model, which only draws a pattern, is left out
    expect(offersTestModels([model(true, true), model(false, true)], false)).toBe(false);
    // the real model is listed but cannot be used (paid generation off, not set up): the test model is all there is
    expect(offersTestModels([model(true, true), model(false, false)], false)).toBe(true);
    expect(offersTestModels([model(true, true)], false)).toBe(true);
    expect(offersTestModels([], false)).toBe(true);
    // a test server that needs both says so
    expect(offersTestModels([model(true, true), model(false, true)], true)).toBe(true);
  });
});

describe("what similar images really cost", () => {
  // the six finished images of the hosted Ojou-sama project (OpenAI reported usage, 2026-11-09)
  const history: CostSample[] = [
    {
      provider: "openai-image",
      model: "gpt-image-2.5-flare",
      quality: "medium",
      references: 0,
      actualUsd: 0.0115,
    },
    {
      provider: "openai-image",
      model: "gpt-image-2.5-flare",
      quality: "medium",
      references: 1,
      actualUsd: 0.0243,
    },
    {
      provider: "openai-image",
      model: "gpt-image-2.5-flare",
      quality: "medium",
      references: 0,
      actualUsd: 0.0095,
    },
    {
      provider: "openai-image",
      model: "gpt-image-2.5-flare",
      quality: "medium",
      references: 1,
      actualUsd: 0.0201,
    },
    {
      provider: "openai-image",
      model: "gpt-image-2.5-flare",
      quality: "medium",
      references: 2,
      actualUsd: 0.0306,
    },
    {
      provider: "openai-image",
      model: "gpt-image-2.5-flare",
      quality: "medium",
      references: 3,
      actualUsd: 0.0411,
    },
  ];
  const want = { provider: "openai-image", model: "gpt-image-2.5-flare", quality: "medium" };

  it("is the median of what matching images were billed", () => {
    expect(typicalCost(history, { ...want, references: 1 })).toEqual({
      usd: 0.0222,
      samples: 2,
      nearest: false,
    });
    expect(typicalCost(history, { ...want, references: 0 })).toMatchObject({ usd: 0.0105, samples: 2 });
    expect(typicalCost(history, { ...want, references: 3 })).toEqual({
      usd: 0.0411,
      samples: 1,
      nearest: false,
    });
  });

  it("falls back to the nearest number of sent images, and says it is looser", () => {
    expect(typicalCost(history, { ...want, references: 5 })).toEqual({
      usd: 0.0411,
      samples: 1,
      nearest: true,
    });
  });

  it("guesses nothing: another model or quality has no comparable image", () => {
    expect(typicalCost(history, { ...want, quality: "high", references: 1 })).toBeNull();
    expect(typicalCost(history, { ...want, model: "gpt-image-2.5-sunburst", references: 1 })).toBeNull();
    expect(typicalCost([], { ...want, references: 0 })).toBeNull();
  });

  it("shows dollars: cents for ordinary amounts, more digits only below a cent", () => {
    expect(usd(0.25)).toBe("$0.25");
    expect(usd(0.1289)).toBe("$0.129");
    expect(usd(0.079)).toBe("$0.079");
    expect(usd(0.0095)).toBe("$0.0095");
    expect(usd(1.7)).toBe("$1.70");
    expect(usd(0)).toBe("$0.00");
    expect(usd(null)).toBe("unknown");
  });
});

describe("a paid image starts only after the amount shown was confirmed", () => {
  it("refuses a missing or smaller confirmation, and accepts one that covers the estimate", () => {
    expect(paidConfirmationRefusal(0.1289, "")).toMatch(
      /costs money: up to \$0\.129\. Open the Reference Studio to see the price/,
    );
    expect(paidConfirmationRefusal(0.1289, "abc")).toMatch(/costs money/);
    expect(paidConfirmationRefusal(0.1289, "0.10")).toBe(
      "The price is now up to $0.129. Confirm that amount to continue.",
    );
    expect(paidConfirmationRefusal(0.1289, "0.1289")).toBeNull();
    expect(paidConfirmationRefusal(0.1289, "0.20")).toBeNull();
    expect(paidConfirmationRefusal(null, "1")).toMatch(/no known price/);
  });
});

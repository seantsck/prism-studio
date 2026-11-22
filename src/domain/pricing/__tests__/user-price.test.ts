import { describe, expect, it } from "vitest";
import { PRICE_MULTIPLIER, priceText, userPrice } from "../user-price";
import { NOT_OFFERED_MODELS, isOffered } from "@/domain/generation/models/offered";

describe("the price a creator is charged", () => {
  it("is three times Prism's cost, in whole cents, rounded up", () => {
    expect(PRICE_MULTIPLIER).toBe(3);
    expect(userPrice(0.0711)).toBe(0.22);
    expect(userPrice(0.07)).toBe(0.21);
    expect(userPrice(0.05)).toBe(0.15);
    expect(userPrice(0.001)).toBe(0.01);
    expect(userPrice(0)).toBe(0);
    expect(userPrice(null)).toBeNull();
    expect(priceText(0.0711)).toBe("$0.22");
    expect(priceText(0)).toBe("Free");
    expect(priceText(undefined)).toBe("unknown");
  });
});

describe("the picture models offered", () => {
  it("leaves out the duplicate Flare through Runway and the unused Sunburst", () => {
    expect(isOffered("runway", "gpt_image_2_5_flare")).toBe(false);
    expect(isOffered("openai-image", "gpt-image-2.5-sunburst")).toBe(false);
    expect(isOffered("openai-image", "gpt-image-2.5-flare")).toBe(true);
    expect(isOffered("runway", "seedream5_lite")).toBe(true);
    expect(isOffered("runway", "muse_image")).toBe(true);
    expect(Object.keys(NOT_OFFERED_MODELS)).toHaveLength(2);
  });
});

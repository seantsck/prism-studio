import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { paidConfirmationRefusal } from "@/domain/generation/paid-confirmation";
import { prepareCoverArt } from "../cover-submission";
import { MockProvider } from "../providers/mock";
import { OPENAI_IMAGE_SECRET_ENV, OpenAIImageProvider } from "../providers/openai-image/adapter";
import { FakeOpenAIImageTransport } from "../providers/openai-image/fake-transport";
import { makeHarness } from "./helpers";

/**
 * Why a cover's confirmation is priced from exactly what is written (hosted, 2026-11-27: "The price is now up to
 * $0.017. Confirm that amount to continue."): GPT Image is billed for the words it is sent, so a cover with a direction
 * costs more than the price beside the button (nothing written yet). Confirming that price is refused; confirming the
 * price of the cover as written (what the confirmation now asks the server for) is accepted.
 */
const KEY = "sk-proj-TESTKEYDONOTUSE1234567890abcdefABCDEF";
const PAID = {
  PRISM_STUDIO_GENERATION_PROVIDERS: "openai-image",
  PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
  PRISM_STUDIO_MAX_GENERATION_USD: "2",
  [OPENAI_IMAGE_SECRET_ENV]: KEY,
};

describe("a cover is confirmed at the price of what is written", () => {
  it("a direction raises a GPT Image cover's price; only the price of the cover as written is accepted", async () => {
    const provider = new OpenAIImageProvider({
      env: PAID,
      transportFactory: () => new FakeOpenAIImageTransport(),
    });
    const h = makeHarness(PAID, {
      extraAdapters: [new MockProvider({ stageDelayMs: 0 }), provider],
      replaceRegistry: true,
    });
    const data = await h.data();
    const price = (direction: string) => {
      const p = prepareCoverArt({
        data,
        input: { direction },
        registry: h.registry,
        provider: "openai-image",
        modelId: "gpt-image-2.5-flare",
        aspectRatio: "2:3",
        userId: null,
        idempotencyKey: `cover-${randomUUID()}`,
        config: h.config,
      });
      if (!p.ok) throw new Error(p.reasons.join(" · "));
      return p.estimate.amount!;
    };
    const beside = price("");
    const written = price("雨のネオン街で背中合わせの二人。".repeat(60));
    expect(written).toBeGreaterThan(beside);
    expect(paidConfirmationRefusal(written, beside.toFixed(4))).toMatch(/The price is now up to/);
    expect(paidConfirmationRefusal(written, written.toFixed(4))).toBeNull();
  });
});

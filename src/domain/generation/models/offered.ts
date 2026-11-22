/**
 * Models Prism keeps in its catalog (so past pictures still show what made them) but no longer offers for new work,
 * because another offered model does the same job. Decided by the owner on 2026-11-22: for character, location and
 * Shot pictures Prism offers GPT Image 2.5 Flare (OpenAI direct), Seedream 5 Lite and Muse Image.
 */
export const NOT_OFFERED_MODELS: Readonly<Record<string, string>> = {
  // the same model as "GPT Image 2.5 Flare (OpenAI direct)", billed through Runway credits instead
  "runway/gpt_image_2_5_flare": "the same model is offered directly from OpenAI",
  // never used; Flare covers new pictures and edits
  "openai-image/gpt-image-2.5-sunburst": "GPT Image 2.5 Flare covers the same work",
};

export function isOffered(provider: string, modelId: string): boolean {
  return !(`${provider}/${modelId}` in NOT_OFFERED_MODELS);
}

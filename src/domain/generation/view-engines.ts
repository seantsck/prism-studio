/**
 * When to pick each engine for a Character's reference views, in the creator's words. Only what the catalogs state
 * (src/domain/generation/models/*-catalog.ts: references accepted, how each is priced, the model family) and what
 * Prism uses an engine for: nothing here ranks a model as "best" in general. The exact price of every view is shown
 * beside the views for the engine picked.
 */
export const VIEW_ENGINE_NOTES: Readonly<Record<string, { when: string; why: string }>> = {
  "openai-image/gpt-image-2.5-flare": {
    when: "Start here",
    why: "Prism's suggestion for reference views: it takes your photos (up to 16 images) and follows a detailed written appearance closely. It costs more per view than Muse Image.",
  },
  "runway/muse_image": {
    when: "Many takes, low cost",
    why: "Priced the same at every size and among the least expensive per view; takes up to 10 reference images. Good for trying several takes of a view before keeping one.",
  },
  "runway/seedream5_lite": {
    when: "A second opinion",
    why: "A different model family (ByteDance Seedream) that takes up to 14 reference images. Worth a try when the likeness or style from another engine is not holding.",
  },
};

export const TEST_ENGINE_NOTE = {
  when: "Testing only",
  why: "A test engine: it draws a placeholder pattern, never a real picture.",
};

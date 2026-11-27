/**
 * A Character made on its own (the home page's "Create a character"), outside any story: it lives in the account's one
 * project of purpose `library` and goes straight into the library, from where any project adds a copy.
 */

export const CHARACTER_PROMPT_MAX = 1200;
export const CHARACTER_NAME_MAX = 80;
/** The account's one project for Characters and Locations made outside any story. */
export const CHARACTER_STUDIO_TITLE = "Your library";
export const CHARACTER_STUDIO_SLUG = "your-library";

/**
 * The name a description gives, when none is typed: "…named Yumeko…", "…called Kaito…", "Name: Aria", else the
 * description's first words. Deterministic (no AI, nothing spent); renamed any time on the character's page.
 */
export function nameFromPrompt(prompt: string): string {
  const text = prompt.trim().replace(/\s+/g, " ");
  const named = text.match(
    /\b(?:[Nn]amed|[Cc]alled|[Nn]ame is|[Nn]ame:)\s+["“]?([\p{Lu}\p{Lo}][\p{L}\p{M}'’-]*(?:\s+[\p{Lu}][\p{L}\p{M}'’-]*)?)/u,
  );
  if (named) return named[1]!.slice(0, CHARACTER_NAME_MAX);
  const words = text
    .split(" ")
    .slice(0, 4)
    .join(" ")
    .replace(/[.,;:!?。、]+$/, "");
  return (words || "New actor").slice(0, CHARACTER_NAME_MAX);
}

export const LOCATION_PROMPT_MAX = 1200;
export const LOCATION_NAME_MAX = 80;

/**
 * The name a location description gives, when none is typed: "…called The Gilded Room…", "Name: Harbor Market", else
 * the description's first words without a leading article ("A rain-soaked alley in Shinjuku" → "Rain-soaked alley in
 * Shinjuku"). Deterministic; renamed any time on the location's page.
 */
export function locationNameFromPrompt(prompt: string): string {
  const text = prompt.trim().replace(/\s+/g, " ");
  const named = text.match(/\b(?:[Nn]amed|[Cc]alled|[Nn]ame is|[Nn]ame:)\s+["“]?([^,.;:!?"”。、]{1,60})/u);
  if (named) return named[1]!.trim().slice(0, LOCATION_NAME_MAX);
  const words = text
    .replace(/^(?:an?|the)\s+/i, "")
    .split(" ")
    .slice(0, 5)
    .join(" ")
    .replace(/[.,;:!?。、]+$/, "");
  const name = words ? words[0]!.toUpperCase() + words.slice(1) : "";
  return (name || "New location").slice(0, LOCATION_NAME_MAX);
}

/** Photos chosen in a create box at once (each uploads on its own). */
export const CREATE_PHOTOS_MAX = 12;

/**
 * How many photos to give, shown where they are chosen. A character's likeness comes from the creator's own photos
 * (see REFERENCE_SET_GUIDANCE in the Reference Studio): 4 to 8 good ones; past that, more pictures blur it.
 */
export const PHOTO_ADVICE = {
  character: {
    best: [4, 8] as const,
    text: "Best likeness: 4 to 8 photos. Face large, sharp and evenly lit; front, 3/4 and side; one full body. No sunglasses, filters or group shots. More than 8 blurs the likeness.",
  },
  location: {
    best: [3, 6] as const,
    text: "3 to 6 photos: a wide view, the reverse angle and a few details, all at the same time of day.",
  },
} as const;

/** What the count of chosen photos means, beside the advice. */
export function photoCountNote(
  kind: "character" | "location",
  count: number,
): { tone: "pass" | "warn" | "muted"; text: string } {
  const [low, high] = PHOTO_ADVICE[kind].best;
  if (count === 0) return { tone: "muted", text: "Optional: you can add photos later too." };
  if (count < low)
    return {
      tone: "warn",
      text: `${count} chosen: ${low} or more give a steadier ${kind === "character" ? "likeness" : "place"}.`,
    };
  if (count > high) return { tone: "warn", text: `${count} chosen: ${high} good ones beat more.` };
  return { tone: "pass", text: `${count} chosen: a good set.` };
}

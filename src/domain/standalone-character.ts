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
  return (words || "New character").slice(0, CHARACTER_NAME_MAX);
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

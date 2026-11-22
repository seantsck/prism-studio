/**
 * A Character made on its own (the home page's "Create a character"), outside any story: it lives in the account's one
 * project of purpose `library` and goes straight into the library, from where any project adds a copy.
 */

export const CHARACTER_PROMPT_MAX = 1200;
export const CHARACTER_NAME_MAX = 80;
export const CHARACTER_STUDIO_TITLE = "Your characters";

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

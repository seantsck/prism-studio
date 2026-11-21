import type { ProjectData } from "@/domain/schemas";
import { LIMITS } from "@/domain/story/writing";

/**
 * Starting a series from a prompt. The pure parts: how long a premise may be, and what the writing assistant is asked
 * to write for Episode 1 (its "Continue" on the empty Episode, so it reaches the creator as a proposal to review).
 */

/** The longest premise kept (the rest of the writing instruction must still fit the assistant's limit). */
export const PREMISE_MAX = 3000;

/** What the writing assistant is asked to write for Episode 1. */
export function episodeOneInstruction(data: ProjectData, premise: string): string {
  const language = data.project.defaultLanguage;
  return [
    `Write the complete screenplay of Episode 1 of this ${data.project.projectType} from the premise below.`,
    "Standard screenplay format: scene headings (INT./EXT. PLACE - TIME), short action lines, CHARACTER NAMES in capitals above their dialogue.",
    "Introduce the main characters with a short visual description the first time each appears.",
    `Dialogue in the project's language (${language}); everything else in English.`,
    "Keep it compact: about five short scenes (around five pages), ending on a hook for the next episode.",
    "",
    `Premise: ${premise.trim().slice(0, PREMISE_MAX)}`,
  ]
    .join("\n")
    .slice(0, LIMITS.instruction);
}

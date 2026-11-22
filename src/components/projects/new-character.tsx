import { ActionForm } from "@/components/action-form";
import type { ActionResult } from "@/server/action-result";
import {
  CHARACTER_NAME_MAX,
  CHARACTER_PROMPT_MAX,
  LOCATION_NAME_MAX,
  LOCATION_PROMPT_MAX,
} from "@/domain/standalone-character";
import { createStandaloneCharacter, createStandaloneLocation } from "@/server/library-actions";

/**
 * The home page's smaller boxes beside the series box: make a character or a location on its own, outside any story.
 * Each goes into the library (ready to add to any project) and opens on its page, ready for pictures.
 */
function SubjectBox({
  kind,
  title,
  hint,
  placeholder,
  namePlaceholder,
  action,
  promptMax,
  nameMax,
}: {
  kind: "character" | "location";
  title: string;
  hint: string;
  placeholder: string;
  namePlaceholder: string;
  action: (form: FormData) => Promise<ActionResult>;
  promptMax: number;
  nameMax: number;
}) {
  return (
    <ActionForm action={action} successMessage="" className="w-full" data-testid={`new-${kind}`}>
      <div className="new-subject-card rounded-xl border border-line2 bg-panel/90 backdrop-blur transition-colors focus-within:border-accent/60">
        <label
          htmlFor={`new-${kind}-prompt`}
          className="block px-4 pt-3 text-[14px] font-semibold tracking-tight"
        >
          {title}
        </label>
        <p className="px-4 pt-0.5 text-[11.5px] leading-snug text-muted">{hint}</p>
        <textarea
          id={`new-${kind}-prompt`}
          name="prompt"
          rows={3}
          required
          maxLength={promptMax}
          placeholder={placeholder}
          className="block w-full resize-none text-[13.5px] leading-relaxed placeholder:text-faint"
          data-testid={`new-${kind}-prompt`}
        />
        <div className="flex items-center gap-2 px-3 pb-3 pt-1">
          <input
            name="name"
            maxLength={nameMax}
            placeholder={namePlaceholder}
            aria-label={namePlaceholder}
            className="min-w-0 flex-1 text-[12px] placeholder:text-faint"
            data-testid={`new-${kind}-name`}
          />
          <button
            type="submit"
            className="inline-flex h-8 shrink-0 items-center rounded-full bg-accent px-4 text-[12.5px] font-semibold text-accentfg transition-[filter] hover:brightness-110 disabled:opacity-40"
            data-testid={`new-${kind}-create`}
          >
            Create
          </button>
        </div>
      </div>
    </ActionForm>
  );
}

export function NewCharacter() {
  return (
    <SubjectBox
      kind="character"
      title="Create a character"
      hint="Who they are and how they look. Their role is set in each project you add them to."
      placeholder="A woman in her early 30s, short black bob, long charcoal coat, sharp eyes, always carrying a battered notebook."
      namePlaceholder="Name (optional)"
      action={createStandaloneCharacter}
      promptMax={CHARACTER_PROMPT_MAX}
      nameMax={CHARACTER_NAME_MAX}
    />
  );
}

export function NewLocation() {
  return (
    <SubjectBox
      kind="location"
      title="Create a location"
      hint="What the place looks and feels like. Use it in any project."
      placeholder="A rain-soaked alley in Shinjuku at night, neon signs reflected in puddles, steam rising from a ramen stall."
      namePlaceholder="Name (optional)"
      action={createStandaloneLocation}
      promptMax={LOCATION_PROMPT_MAX}
      nameMax={LOCATION_NAME_MAX}
    />
  );
}

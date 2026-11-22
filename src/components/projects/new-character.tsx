import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { CHARACTER_NAME_MAX, CHARACTER_PROMPT_MAX } from "@/domain/standalone-character";
import { createStandaloneCharacter } from "@/server/library-actions";

/**
 * Create a character on its own, outside any story: a description (and a name, or one taken from the description).
 * It opens on its page, ready for pictures in the Reference Studio, and is in the library for any project to add.
 */
export function NewCharacter() {
  return (
    <ActionForm
      action={createStandaloneCharacter}
      successMessage=""
      className="mb-5 rounded-xl border border-line bg-panel p-4"
      data-testid="new-character"
    >
      <label className="block text-[13px] font-medium" htmlFor="new-character-prompt">
        Create a character
      </label>
      <p className="mt-0.5 text-[12px] text-muted">
        Describe who they are and how they look. They go into your library, ready to add to any project, and
        you can make their pictures in the Reference Studio.
      </p>
      <textarea
        id="new-character-prompt"
        name="prompt"
        rows={3}
        required
        maxLength={CHARACTER_PROMPT_MAX}
        placeholder="A sharp-witted detective named Aiko Mori, early 30s, short black bob, long charcoal coat, always carrying a battered notebook."
        className="mt-2 w-full"
        data-testid="new-character-prompt"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          name="name"
          maxLength={CHARACTER_NAME_MAX}
          placeholder="Name (optional)"
          aria-label="Name (optional)"
          className="w-48"
          data-testid="new-character-name"
        />
        <Button type="submit" variant="primary" data-testid="new-character-create">
          Create character
        </Button>
      </div>
    </ActionForm>
  );
}

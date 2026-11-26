import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { MAX_SUBJECT_DIRECTION_CHARS } from "@/domain/generation/subject-image";
import { createProject } from "@/server/actions";

/**
 * The front page's cover box, under the main prompt: a title and what the cover shows. It starts a new project and opens
 * its Cover art page with the description filled in; nothing is made until the creator sees the price there.
 */
export function NewCover() {
  return (
    <ActionForm action={createProject} successMessage="" className="w-full" data-testid="new-cover">
      <input type="hidden" name="then" value="cover" />
      <div className="rounded-xl border border-line bg-panel/80 transition-colors focus-within:border-accent/60">
        <div className="flex items-baseline justify-between gap-2 px-4 pt-3">
          <span className="text-[13px] font-medium">Create cover art</span>
          <span className="text-[11.5px] text-faint">Starts a new project; you see the price before it is made</span>
        </div>
        <label htmlFor="new-cover-title" className="sr-only">
          Title
        </label>
        <input
          id="new-cover-title"
          name="title"
          required
          maxLength={120}
          placeholder="Title"
          className="block w-full px-4 pt-2 text-[14px] font-medium placeholder:font-normal placeholder:text-faint"
          data-testid="new-cover-title"
        />
        <label htmlFor="new-cover-direction" className="sr-only">
          Describe the cover
        </label>
        <textarea
          id="new-cover-direction"
          name="coverDirection"
          rows={2}
          maxLength={MAX_SUBJECT_DIRECTION_CHARS}
          placeholder="Describe the cover: two leads back to back under a rainy neon sky…"
          className="block w-full resize-none px-4 pb-2 pt-1 text-[13px] leading-relaxed placeholder:text-faint"
          data-testid="new-cover-direction"
        />
        <div className="flex justify-end px-3 pb-3">
          <Button type="submit" size="sm" variant="primary" data-testid="new-cover-go">
            Go to Cover art
          </Button>
        </div>
      </div>
    </ActionForm>
  );
}

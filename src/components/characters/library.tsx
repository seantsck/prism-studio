import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button, Panel } from "@/components/ui";
import type { LibraryCharacter } from "@/server/character-library";
import { addFromLibrary, setCharacterInLibrary } from "@/server/library-actions";

/** On a Character's page: save it to the account library (to use in other projects), or take it out. */
export function LibraryToggle({
  slug,
  characterId,
  saved,
  available,
}: {
  slug: string;
  characterId: string;
  saved: boolean;
  available: boolean;
}) {
  if (!available)
    return (
      <span className="text-[12px] text-faint" data-testid="library-unavailable">
        Library needs a database update
      </span>
    );
  return (
    <ActionForm
      action={setCharacterInLibrary}
      successMessage=""
      quiet
      className="flex items-center gap-2"
      data-testid="library-toggle"
      data-saved={saved ? "1" : "0"}
    >
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="characterId" value={characterId} />
      <input type="hidden" name="saved" value={saved ? "0" : "1"} />
      {saved ? <span className="text-[12px] text-pass">In your library</span> : null}
      <Button type="submit" variant={saved ? "ghost" : "secondary"} data-testid="library-toggle-go">
        {saved ? "Remove from library" : "Save to library"}
      </Button>
    </ActionForm>
  );
}

/**
 * On a project's Characters page: the Characters saved in the account library from the creator's other projects,
 * each added here as a copy (with its pictures, Looks and voices) in one click.
 */
export function LibraryPanel({
  slug,
  projectId,
  characters,
  available,
}: {
  slug: string;
  projectId: string;
  characters: LibraryCharacter[];
  available: boolean;
}) {
  const others = characters.filter((c) => c.projectId !== projectId);
  return (
    <Panel title="From your library">
      <div className="space-y-3" data-testid="library-panel">
        {!available ? (
          <p className="text-[13px] text-warn">
            The character library needs a one-time database update (migration 0062) that has not been applied
            yet.
          </p>
        ) : others.length === 0 ? (
          <p className="text-[13px] text-muted">
            Save a character to your library from its page (&ldquo;Save to library&rdquo;), then add it to any
            other project from here. Each project gets its own copy.
          </p>
        ) : (
          <>
            <p className="text-[12px] text-muted">
              Adding makes a copy in this project, with its pictures, Looks and voices. Changes here never
              change the original.
            </p>
            <ul className="space-y-2">
              {others.map((c) => (
                <li
                  key={c.characterId}
                  className="flex gap-3 rounded-[3px] border border-line p-2"
                  data-testid="library-character"
                  data-name={c.name}
                >
                  {c.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.thumbUrl} alt="" className="h-14 w-14 shrink-0 rounded-[2px] object-cover" />
                  ) : (
                    <div className="h-14 w-14 shrink-0 rounded-[2px] bg-panel2" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="text-[13px] font-medium">{c.name}</div>
                    <div className="text-[11.5px] text-muted">
                      {c.role ? `${c.role} · ` : ""}from{" "}
                      <Link
                        href={`/projects/${c.projectSlug}/characters/${c.characterId}`}
                        className="hover:underline"
                      >
                        {c.projectTitle}
                      </Link>
                      {` · ${c.pictures} picture${c.pictures === 1 ? "" : "s"}, ${c.looks} Look${c.looks === 1 ? "" : "s"}`}
                    </div>
                    <ActionForm action={addFromLibrary} successMessage="Added" className="pt-0.5">
                      <input type="hidden" name="projectSlug" value={slug} />
                      <input type="hidden" name="characterId" value={c.characterId} />
                      <Button type="submit" data-testid="library-add">
                        Add to this project
                      </Button>
                    </ActionForm>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Panel>
  );
}

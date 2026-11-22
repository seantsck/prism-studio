import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button, Panel } from "@/components/ui";
import type { LibraryLocation } from "@/server/character-library";
import { addLocationFromLibrary, setLocationInLibrary } from "@/server/library-actions";

/** On a Location: save it to the account library (to use in other projects), or take it out. */
export function LocationLibraryToggle({
  slug,
  locationId,
  saved,
  available,
}: {
  slug: string;
  locationId: string;
  saved: boolean;
  available: boolean;
}) {
  if (!available)
    return (
      <span className="text-[12px] text-faint" data-testid="location-library-unavailable">
        Library needs a database update
      </span>
    );
  return (
    <ActionForm
      action={setLocationInLibrary}
      successMessage=""
      quiet
      className="flex items-center gap-2"
      data-testid="location-library-toggle"
      data-saved={saved ? "1" : "0"}
    >
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="locationId" value={locationId} />
      <input type="hidden" name="saved" value={saved ? "0" : "1"} />
      {saved ? <span className="text-[12px] text-pass">In your library</span> : null}
      <Button type="submit" variant={saved ? "ghost" : "secondary"} data-testid="location-library-toggle-go">
        {saved ? "Remove from library" : "Save to library"}
      </Button>
    </ActionForm>
  );
}

/**
 * On a project's Locations page: the Locations saved in the account library from the creator's other projects, each
 * added here as a copy (with its pictures) in one click.
 */
export function LocationLibraryPanel({
  slug,
  projectId,
  locations,
  available,
}: {
  slug: string;
  projectId: string;
  locations: LibraryLocation[];
  available: boolean;
}) {
  const others = locations.filter((l) => l.projectId !== projectId);
  return (
    <Panel title="From your library">
      <div className="space-y-3" data-testid="location-library-panel">
        {!available ? (
          <p className="text-[13px] text-warn">
            The location library needs a one-time database update (migration 0066) that has not been applied
            yet.
          </p>
        ) : others.length === 0 ? (
          <p className="text-[13px] text-muted">
            Save a location to your library (&ldquo;Save to library&rdquo;), or create one on the home page,
            then add it to any other project from here. Each project gets its own copy.
          </p>
        ) : (
          <>
            <p className="text-[12px] text-muted">
              Adding makes a copy in this project, with its pictures. Changes here never change the original.
            </p>
            <ul className="space-y-2">
              {others.map((l) => (
                <li
                  key={l.locationId}
                  className="flex gap-3 rounded-[3px] border border-line p-2"
                  data-testid="library-location"
                  data-name={l.name}
                >
                  {l.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.thumbUrl} alt="" className="h-14 w-20 shrink-0 rounded-[2px] object-cover" />
                  ) : (
                    <div className="h-14 w-20 shrink-0 rounded-[2px] bg-panel2" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="text-[13px] font-medium">{l.name}</div>
                    <div className="text-[11.5px] text-muted">
                      from{" "}
                      <Link
                        href={`/projects/${l.projectSlug}/locations?open=${l.locationId}`}
                        className="hover:underline"
                      >
                        {l.projectTitle}
                      </Link>
                      {` · ${l.pictures} picture${l.pictures === 1 ? "" : "s"}`}
                    </div>
                    <ActionForm action={addLocationFromLibrary} successMessage="Added" className="pt-0.5">
                      <input type="hidden" name="projectSlug" value={slug} />
                      <input type="hidden" name="locationId" value={l.locationId} />
                      <Button type="submit" data-testid="library-location-add">
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

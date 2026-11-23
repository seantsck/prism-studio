import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { addFromLibrary, addLocationFromLibrary } from "@/server/library-actions";

/**
 * On a library Character or Location (made on its own, in no project): start a new project with it, or add a copy of
 * it to one of the creator's projects, which then opens there.
 */
export function UseInProject({
  kind,
  id,
  name,
  projects,
  saved,
  fresh = false,
}: {
  kind: "character" | "location";
  id: string;
  name: string;
  projects: Array<{ slug: string; title: string }>;
  /** In the library (adding a copy reads it from there). */
  saved: boolean;
  /** Just created: say what comes next. */
  fresh?: boolean;
}) {
  const start = `/?${kind === "character" ? "cast" : "place"}=${encodeURIComponent(id)}#new-series`;
  return (
    <section
      className="rounded-xl border border-accent/40 bg-accent/[0.06] p-4"
      data-testid="use-in-project"
      aria-label={`Use ${name} in a project`}
    >
      <h2 className="text-[14px] font-semibold tracking-tight">
        {fresh
          ? `${name} is ready. Next, use ${kind === "character" ? "them" : "it"} in a project`
          : "Use in a project"}
      </h2>
      <p className="mt-0.5 text-[12px] text-muted">
        {kind === "character"
          ? "This character belongs to no project yet. Each project gets its own copy, where you give them a role."
          : "This location belongs to no project yet. Each project gets its own copy."}
        {fresh ? " You can add photos and make pictures first, or any time later." : ""}
      </p>
      {!saved ? (
        <p className="mt-2 text-[12px] text-warn">Save it to your library first to add it to a project.</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {/* the usual step first: put it in a project you already have (it opens there) */}
          {projects.length ? (
            <ActionForm
              action={kind === "character" ? addFromLibrary : addLocationFromLibrary}
              successMessage="Added"
              className="flex flex-wrap items-center gap-2"
            >
              <span className="text-[12.5px]">Add to</span>
              <input type="hidden" name={kind === "character" ? "characterId" : "locationId"} value={id} />
              <input type="hidden" name="open" value="1" />
              <label className="sr-only" htmlFor={`use-in-${id}`}>
                Project
              </label>
              <select
                id={`use-in-${id}`}
                name="projectSlug"
                className="h-8 w-auto max-w-[16rem]"
                data-testid="use-in-project-select"
              >
                {projects.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.title}
                  </option>
                ))}
              </select>
              <Button type="submit" variant="primary" data-testid="use-in-project-add">
                Add to this project
              </Button>
            </ActionForm>
          ) : null}
          <Link
            href={start}
            className={
              projects.length
                ? "text-[12.5px] text-accent hover:underline"
                : "inline-flex h-8 items-center rounded-full bg-accent px-4 text-[12.5px] font-semibold text-accentfg hover:brightness-110"
            }
            data-testid="use-in-new-project"
          >
            {projects.length
              ? `or start a new project with ${name} (on the home page)`
              : `Start a new project with ${name}`}
          </Link>
        </div>
      )}
    </section>
  );
}

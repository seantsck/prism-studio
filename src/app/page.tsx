import Link from "next/link";
import { Badge, Button, Field, Panel } from "@/components/ui";
import { PROJECT_TYPES } from "@/domain/schemas";
import { PREMISE_MAX } from "@/domain/series-start";
import { createProject } from "@/server/actions";
import { UserMenu } from "@/components/user-menu";
import { requireUser } from "@/server/auth";
import { getRepo } from "@/server/repo";
import { ActionForm } from "@/components/action-form";
import { ProjectActions } from "@/components/projects/project-actions";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await requireUser();
  const repo = await getRepo();
  const all = await repo.listProjects();
  const archive = await repo.archivedProjectIds();
  const projects = all.filter((p) => !archive.ids.has(p.id));
  const archived = all.filter((p) => archive.ids.has(p.id));
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-8 flex items-baseline justify-between border-b border-line pb-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-accent">Prism Studio</div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Projects</h1>
        </div>
        <div className="w-56">
          <UserMenu user={user} />
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-[1fr_320px]">
        <div className="space-y-2">
          {projects.length === 0 ? (
            <p className="border border-dashed border-line px-4 py-6 text-center text-muted">
              No projects yet. Start one on the right.
            </p>
          ) : null}
          {projects.map((p) => (
            <div
              key={p.id}
              className="flex items-start justify-between gap-3 border border-line bg-panel px-4 py-3 transition-colors hover:border-line2"
              data-testid="project-row"
              data-slug={p.slug}
            >
              <Link href={`/projects/${p.slug}`} className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium hover:underline">{p.title}</div>
                <div className="mt-0.5 truncate text-muted">{p.description || "No description"}</div>
                <div className="mt-1.5 flex gap-2">
                  <Badge>{p.projectType}</Badge>
                  <Badge tone="info">{p.productionStatus.replace("_", " ")}</Badge>
                </div>
              </Link>
              <ProjectActions
                slug={p.slug}
                title={p.title}
                archived={false}
                archiveAvailable={archive.available}
              />
            </div>
          ))}

          {archived.length > 0 ? (
            <details className="pt-4" data-testid="projects-archived">
              <summary className="cursor-pointer text-muted hover:text-fg">
                Archived ({archived.length})
              </summary>
              <div className="mt-2 space-y-2">
                {archived.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-start justify-between gap-3 border border-line px-4 py-3 opacity-80"
                    data-testid="project-row"
                    data-slug={p.slug}
                    data-archived="true"
                  >
                    <Link href={`/projects/${p.slug}`} className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium hover:underline">{p.title}</div>
                      <div className="mt-0.5 truncate text-muted">{p.description || "No description"}</div>
                    </Link>
                    <ProjectActions
                      slug={p.slug}
                      title={p.title}
                      archived
                      archiveAvailable={archive.available}
                    />
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>

        <Panel title="New project">
          <ActionForm action={createProject} className="space-y-3">
            <Field label="Title">
              <input name="title" required placeholder="Working title" />
            </Field>
            <Field
              label="Describe your series (optional)"
              hint="A few lines is enough. Prism then helps you draft Episode 1, the Bible, the cast and the places — you review each step."
            >
              <textarea name="premise" rows={4} maxLength={PREMISE_MAX} data-testid="new-project-premise" />
            </Field>
            <Field label="Type">
              <select name="projectType" defaultValue="series">
                {PROJECT_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
            <Field label="Genre">
              <input name="genre" />
            </Field>
            <Field label="Tone">
              <input name="tone" />
            </Field>
            <Field label="Default language">
              <input name="defaultLanguage" defaultValue="en" />
            </Field>
            <Field label="Description">
              <textarea name="description" rows={3} />
            </Field>
            <Button variant="primary" type="submit">
              Create project
            </Button>
          </ActionForm>
        </Panel>
      </div>
    </main>
  );
}

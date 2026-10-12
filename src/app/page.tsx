import Link from "next/link";
import { Badge, Button, Field, Panel } from "@/components/ui";
import { PROJECT_TYPES } from "@/domain/schemas";
import { createProject } from "@/server/actions";
import { UserMenu } from "@/components/user-menu";
import { requireUser } from "@/server/auth";
import { getRepo } from "@/server/repo";
import { ActionForm } from "@/components/action-form";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await requireUser();
  const projects = await (await getRepo()).listProjects();
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
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.slug}`}
              className="flex items-center justify-between border border-line bg-panel px-4 py-3 transition-colors hover:border-line2 hover:bg-panel2"
            >
              <div className="min-w-0">
                <div className="truncate text-[14px] font-medium">{p.title}</div>
                <div className="mt-0.5 truncate text-muted">{p.description || "No description"}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge>{p.projectType}</Badge>
                <Badge tone="info">{p.productionStatus.replace("_", " ")}</Badge>
              </div>
            </Link>
          ))}
        </div>

        <Panel title="New project">
          <ActionForm action={createProject} className="space-y-3">
            <Field label="Title">
              <input name="title" required placeholder="Working title" />
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

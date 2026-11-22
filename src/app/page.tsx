import Link from "next/link";
import { ProjectActions } from "@/components/projects/project-actions";
import { NewSeries } from "@/components/projects/new-series";
import { UserMenu } from "@/components/user-menu";
import { PREMISE_MAX } from "@/domain/series-start";
import type { Project } from "@/domain/schemas";
import { requireUser } from "@/server/auth";
import { getRepo } from "@/server/repo";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<Project["projectType"], string> = { series: "Series", film: "Film", short: "Short" };

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * The Projects page: one centered box to describe a new series (Prism can write Episode 1 straight after, at the price
 * shown), then every project as a card with Archive and Delete.
 */
export default async function HomePage() {
  const user = await requireUser();
  const repo = await getRepo();
  const all = [...(await repo.listProjects())].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const archive = await repo.archivedProjectIds();
  const projects = all.filter((p) => !archive.ids.has(p.id));
  const archived = all.filter((p) => archive.ids.has(p.id));
  return (
    <main className="relative min-h-screen overflow-hidden">
      {/* a projector's warm light falling on the box: the page's one flourish */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(ellipse_60%_55%_at_50%_0%,rgba(214,162,74,0.16),transparent_70%)]"
      />

      <header className="relative mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <span className="text-[13px] font-semibold tracking-tight">Prism Studio</span>
        <div className="w-56">
          <UserMenu user={user} />
        </div>
      </header>

      <section className="relative mx-auto flex max-w-3xl flex-col items-center px-6 pb-16 pt-14 text-center sm:pt-20">
        <h1 className="text-balance text-[34px] font-semibold leading-[1.1] tracking-tight sm:text-[44px]">
          What&apos;s your series about?
        </h1>
        <p className="mt-3 max-w-xl text-[14px] text-muted">
          Describe it in a few lines. Prism plans it, writes it, then turns it into your Bible, cast, places
          and Shots. You see the price before anything runs and review every step.
        </p>
        <div className="mt-8 w-full text-left">
          <NewSeries premiseMax={PREMISE_MAX} />
        </div>
      </section>

      <section className="relative mx-auto max-w-6xl px-6 pb-20" data-testid="projects">
        <div className="mb-4 flex items-baseline justify-between border-b border-line pb-3">
          <h2 className="text-[15px] font-semibold tracking-tight">Your projects</h2>
          <span className="text-[12px] text-muted">{projects.length}</span>
        </div>
        {projects.length === 0 ? (
          <p className="py-10 text-center text-muted">Your first project will appear here.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} archiveAvailable={archive.available} />
            ))}
          </ul>
        )}

        {archived.length > 0 ? (
          <details className="mt-8" data-testid="projects-archived">
            <summary className="cursor-pointer text-[12px] text-muted hover:text-fg">
              Archived ({archived.length})
            </summary>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {archived.map((p) => (
                <ProjectCard key={p.id} project={p} archived archiveAvailable={archive.available} />
              ))}
            </ul>
          </details>
        ) : null}
      </section>
    </main>
  );
}

function ProjectCard({
  project: p,
  archived = false,
  archiveAvailable,
}: {
  project: Project;
  archived?: boolean;
  archiveAvailable: boolean;
}) {
  return (
    <li
      className="group flex flex-col justify-between gap-3 rounded-xl border border-line bg-panel p-4 transition-colors hover:border-line2"
      data-testid="project-row"
      data-slug={p.slug}
      data-archived={archived ? "true" : undefined}
    >
      <Link href={`/projects/${p.slug}`} className="block min-w-0">
        <div className="truncate text-[15px] font-medium group-hover:text-accent">{p.title}</div>
        <div className="mt-1 line-clamp-2 min-h-[2.5em] text-[12.5px] text-muted">
          {p.description || `${TYPE_LABEL[p.projectType]} in ${p.productionStatus.replace("_", " ")}`}
        </div>
        <div className="mt-2 text-[11.5px] text-faint">
          {TYPE_LABEL[p.projectType]} · started {day(p.createdAt)}
        </div>
      </Link>
      <ProjectActions slug={p.slug} title={p.title} archived={archived} archiveAvailable={archiveAvailable} />
    </li>
  );
}

import Link from "next/link";
import { ProjectActions } from "@/components/projects/project-actions";
import { loadLibrary, loadLocationLibrary } from "@/server/character-library";
import { purgeExpiredProjects } from "@/server/trash";
import { TrashedProjectActions } from "@/components/projects/project-actions";
import { trashDaysLeft } from "@/domain/trash";
import { NewSeries, type SeriesCast } from "@/components/projects/new-series";
import { NewCover } from "@/components/projects/new-cover";
import { singleUploadLimit } from "@/lib/upload-policy";
import { quoteNewFill } from "@/server/series-start";
import { NewCharacter, NewLocation } from "@/components/projects/new-character";
import { UserMenu } from "@/components/user-menu";
import { RotatingWord } from "@/components/projects/rotating-word";
import { PREMISE_MAX } from "@/domain/series-start";
import type { Project } from "@/domain/schemas";
import { requireUser } from "@/server/auth";
import { getRepo } from "@/server/repo";
import { CoverFinal } from "@/components/projects/cover-art";
import { coverCardOf, pickCover, type CoverCard } from "@/server/cover-art";

export const dynamic = "force-dynamic";

/** The heading's changing word: what a creator might start from. */
const HEADING_WORDS = ["series", "story", "scene", "film", "movie", "character", "location"] as const;

const TYPE_LABEL: Record<Project["projectType"], string> = { series: "Series", film: "Film", short: "Short" };

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * The Projects page: the box to describe a new series (Prism can write Episode 1 straight after, at the price shown),
 * with smaller boxes beside it to create a character or a location on its own; then every project as a card with
 * Archive and Delete, and the library's characters and locations.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ cast?: string | string[]; place?: string | string[] }>;
}) {
  const user = await requireUser();
  const wanted = await searchParams;
  const ids = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
  const maxUploadBytes = singleUploadLimit(process.env);
  const repo = await getRepo();
  // the account's own characters project (purpose `library`) is not one of their projects: its Characters show below
  const all = [...(await repo.listProjects())]
    .filter((p) => p.purpose !== "library")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // projects 30 days in the Trash are deleted for good when this page is opened (in the owner's own request)
  await purgeExpiredProjects();
  const trashed = await repo.trashedProjects();
  const trash = { ...trashed, projects: trashed.projects.filter((t) => t.project.purpose !== "library") };
  const archive = await repo.archivedProjectIds();
  // which of each project's Characters are in the library (deleting the project takes them out)
  const library = await loadLibrary();
  const places = await loadLocationLibrary();
  // "Start a new project with …" from the library: who and where the new series starts with
  const cast: SeriesCast[] = [
    ...ids(wanted.cast).flatMap((id) => {
      const c = library.characters.find((x) => x.characterId === id);
      return c ? [{ kind: "cast" as const, id, name: c.name, thumbUrl: c.thumbUrl }] : [];
    }),
    ...ids(wanted.place).flatMap((id) => {
      const l = places.locations.find((x) => x.locationId === id);
      return l ? [{ kind: "place" as const, id, name: l.name, thumbUrl: l.thumbUrl }] : [];
    }),
  ];
  const libraryNamesOf = (projectId: string) =>
    library.characters.filter((c) => c.projectId === projectId).map((c) => c.name);
  const projects = all.filter((p) => !archive.ids.has(p.id));
  // each project's finished cover (the picture with its title design) on its card
  const pictures = await repo.coverPictures();
  const coverOf = (p: Project) => {
    const asset = pickCover(pictures.filter((a) => a.projectId === p.id));
    return asset ? coverCardOf(p, asset) : null;
  };
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

      <section className="relative mx-auto grid max-w-[1320px] gap-6 px-6 pb-16 pt-10 sm:grid-cols-2 sm:pt-14 xl:grid-cols-[270px_minmax(0,1fr)_270px] xl:items-start xl:gap-8">
        <div className="flex flex-col items-center text-center sm:col-span-2 xl:order-2 xl:col-span-1">
          <h1 className="text-balance text-[34px] font-semibold leading-[1.1] tracking-tight sm:text-[44px]">
            What&apos;s your <RotatingWord words={HEADING_WORDS} /> about?
          </h1>
          <p className="mt-3 max-w-xl text-[14px] text-muted">
            Describe it in a few lines. Prism plans it, writes it, then turns it into your Bible, cast, places
            and Shots. You see the price before anything runs and review every step.
          </p>
          <div className="mt-8 w-full max-w-3xl text-left" id="new-series">
            <NewSeries premiseMax={PREMISE_MAX} cast={cast} />
          </div>
          <div className="mt-5 w-full max-w-xl text-left" id="new-cover">
            <NewCover />
          </div>
        </div>
        <div className="xl:order-1 xl:pt-[10.75rem]" data-testid="home-create-character">
          <NewCharacter maxUploadBytes={maxUploadBytes} fill={quoteNewFill("character")} />
        </div>
        <div className="xl:order-3 xl:pt-[10.75rem]" data-testid="home-create-location">
          <NewLocation maxUploadBytes={maxUploadBytes} fill={quoteNewFill("location")} />
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
              <ProjectCard
                key={p.id}
                project={p}
                cover={coverOf(p)}
                archiveAvailable={archive.available}
                libraryNames={libraryNamesOf(p.id)}
              />
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
                <ProjectCard
                  key={p.id}
                  project={p}
                  cover={coverOf(p)}
                  archived
                  archiveAvailable={archive.available}
                  libraryNames={libraryNamesOf(p.id)}
                />
              ))}
            </ul>
          </details>
        ) : null}

        {trash.projects.length > 0 ? (
          <details className="mt-8" data-testid="projects-trash">
            <summary className="cursor-pointer text-[12px] text-muted hover:text-fg">
              Trash ({trash.projects.length})
            </summary>
            <p className="mt-1 text-[11.5px] text-muted">
              Deleted projects stay here for 30 days, then they are deleted for good. Restore brings one back
              whole.
            </p>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {trash.projects.map(({ project: p, trashedAt }) => {
                const left = trashDaysLeft(trashedAt, new Date().toISOString());
                return (
                  <li
                    key={p.id}
                    className="flex flex-col justify-between gap-3 rounded-xl border border-line bg-panel/60 p-4"
                    data-testid="project-trash-row"
                    data-slug={p.slug}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[15px] font-medium text-muted">{p.title}</div>
                      <div className="mt-1 text-[11.5px] text-faint">
                        {TYPE_LABEL[p.projectType]} ·{" "}
                        {left === 0 ? "deleted today" : `${left} day${left === 1 ? "" : "s"} left`}
                      </div>
                    </div>
                    <TrashedProjectActions id={p.id} title={p.title} />
                  </li>
                );
              })}
            </ul>
          </details>
        ) : null}
      </section>

      <section className="relative mx-auto max-w-6xl px-6 pb-20" data-testid="home-characters">
        <div className="mb-4 flex items-baseline justify-between border-b border-line pb-3">
          <h2 className="text-[15px] font-semibold tracking-tight">Your characters</h2>
          <span className="text-[12px] text-muted">{library.characters.length}</span>
        </div>
        {!library.available ? (
          <p className="py-6 text-center text-[13px] text-muted">
            Your character library needs a one-time database update (migration 0062).
          </p>
        ) : library.characters.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-muted" data-testid="home-characters-empty">
            Every character you create appears here, ready for any project.
          </p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {library.characters.map((c) => (
              <li key={c.characterId} data-testid="home-character" data-name={c.name}>
                <Link
                  href={`/projects/${c.projectSlug}/characters/${c.characterId}`}
                  className="group block overflow-hidden rounded-xl border border-line bg-panel transition-colors hover:border-line2"
                >
                  <div className="aspect-[3/4] bg-[#232326]">
                    {c.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.thumbUrl} alt="" className="h-full w-full object-cover" />
                    ) : null}
                  </div>
                  <div className="space-y-0.5 p-2.5">
                    <div className="truncate text-[13.5px] font-medium group-hover:text-accent">{c.name}</div>
                    <div className="truncate text-[11px] text-faint" title={c.projectTitle}>
                      {c.projectTitle} · {c.pictures} picture{c.pictures === 1 ? "" : "s"}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {library.characters.length > 0 ? (
          <p className="mt-3 text-[12px] text-muted">
            Add one to another project from that project&apos;s Characters page (&ldquo;From your
            library&rdquo;).
          </p>
        ) : null}
      </section>
      <section className="relative mx-auto max-w-6xl px-6 pb-20" data-testid="home-locations">
        <div className="mb-4 flex items-baseline justify-between border-b border-line pb-3">
          <h2 className="text-[15px] font-semibold tracking-tight">Your locations</h2>
          <span className="text-[12px] text-muted">{places.locations.length}</span>
        </div>
        {!places.available ? (
          <p className="py-6 text-center text-[13px] text-muted">
            Your location library needs a one-time database update (migration 0066).
          </p>
        ) : places.locations.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-muted" data-testid="home-locations-empty">
            Locations you create or save to your library appear here, ready for any project.
          </p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {places.locations.map((l) => (
              <li key={l.locationId} data-testid="home-location" data-name={l.name}>
                <Link
                  href={`/projects/${l.projectSlug}/locations?open=${l.locationId}`}
                  className="group block overflow-hidden rounded-xl border border-line bg-panel transition-colors hover:border-line2"
                >
                  <div className="aspect-video bg-[#232326]">
                    {l.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={l.thumbUrl} alt="" className="h-full w-full object-cover" />
                    ) : null}
                  </div>
                  <div className="space-y-0.5 p-2.5">
                    <div className="truncate text-[13.5px] font-medium group-hover:text-accent">{l.name}</div>
                    <div className="truncate text-[11px] text-faint" title={l.projectTitle}>
                      {l.projectTitle} · {l.pictures} picture{l.pictures === 1 ? "" : "s"}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {places.locations.length > 0 ? (
          <p className="mt-3 text-[12px] text-muted">
            Add one to another project from that project&apos;s Locations page (&ldquo;From your
            library&rdquo;).
          </p>
        ) : null}
      </section>
    </main>
  );
}

function ProjectCard({
  project: p,
  cover,
  archived = false,
  archiveAvailable,
  libraryNames,
}: {
  project: Project;
  cover: CoverCard | null;
  archived?: boolean;
  archiveAvailable: boolean;
  libraryNames: string[];
}) {
  return (
    <li
      className="group flex flex-col justify-between gap-3 rounded-xl border border-line bg-panel p-4 transition-colors hover:border-line2"
      data-testid="project-row"
      data-slug={p.slug}
      data-archived={archived ? "true" : undefined}
    >
      <Link href={`/projects/${p.slug}`} className="flex min-w-0 gap-3">
        {cover ? (
          <div className="w-[92px] shrink-0" data-testid="project-cover">
            <CoverFinal cover={cover} enlarge={false} className="w-full" />
          </div>
        ) : null}
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium group-hover:text-accent">{p.title}</div>
          <div className="mt-1 line-clamp-2 min-h-[2.5em] text-[12.5px] text-muted">
            {p.description || `${TYPE_LABEL[p.projectType]} in ${p.productionStatus.replace("_", " ")}`}
          </div>
          <div className="mt-2 text-[11.5px] text-faint">
            {TYPE_LABEL[p.projectType]} · started {day(p.createdAt)}
          </div>
        </div>
      </Link>
      <ProjectActions
        slug={p.slug}
        title={p.title}
        archived={archived}
        archiveAvailable={archiveAvailable}
        libraryNames={libraryNames}
      />
    </li>
  );
}

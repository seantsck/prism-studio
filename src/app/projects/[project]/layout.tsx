import Link from "next/link";
import { notFound } from "next/navigation";
import { MoreTools, NavLink } from "@/components/nav";
import { UserMenu } from "@/components/user-menu";
import { getCurrentUser } from "@/server/auth";
import { loadProjectCached } from "@/server/repo";

export const dynamic = "force-dynamic";

/**
 * The project's four areas, in the order a film is usually made but usable in any order, then every specialist page
 * under "More tools". The Home page says what each area still needs.
 */
const AREAS = [
  {
    title: "Story",
    items: [
      ["/story", "Import Story"],
      ["/bible", "Bible"],
      ["/script", "Script"],
      ["/episodes", "Episodes"],
    ],
  },
  {
    title: "Cast",
    items: [
      ["/characters", "Characters"],
      ["/studio", "Reference Studio"],
    ],
  },
  { title: "World", items: [["/locations", "Locations"]] },
  {
    title: "Shots",
    items: [
      ["/storyboard", "Storyboard"],
      ["/sequence", "Sequence"],
      ["/animatic", "Animatic"],
    ],
  },
] as const;

const MORE = [
  ["/checklist", "Production checklist"],
  ["/breakdown", "Breakdown"],
  ["/perform", "Perform"],
  ["/generations", "Generations"],
  ["/qa", "Shot QA"],
  ["/candidates", "Experiments"],
  ["/models", "Models"],
  ["/assets", "Assets"],
  ["/agents", "Local agents"],
] as const;

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ project: string }>;
}) {
  const { project: slug } = await params;
  const [data, user] = await Promise.all([loadProjectCached(slug), getCurrentUser()]);
  if (!data) notFound();
  const base = `/projects/${slug}`;

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-52 shrink-0 flex-col border-r border-line bg-panel">
        <Link href="/" className="border-b border-line px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.2em] text-accent">Prism Studio</div>
        </Link>
        <div className="border-b border-line px-4 py-3">
          <div className="truncate text-[13px] font-medium" title={data.project.title}>
            {data.project.title}
          </div>
          <div className="mt-0.5 text-[11px] text-muted">
            {data.project.projectType} · {data.project.defaultLanguage}
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          <NavLink href={base} exact>
            Home
          </NavLink>
          {AREAS.map((area) => (
            <div key={area.title} className="pt-2">
              <div className="px-2.5 pb-0.5 text-[11px] text-faint">{area.title}</div>
              {area.items.map(([href, label]) => (
                <NavLink key={label} href={`${base}${href}`}>
                  {label}
                </NavLink>
              ))}
            </div>
          ))}
          <MoreTools base={base} items={MORE} />
        </nav>
        <div className="border-t border-line px-4 py-2">{user ? <UserMenu user={user} /> : null}</div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

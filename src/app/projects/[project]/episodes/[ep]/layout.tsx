import { notFound } from "next/navigation";
import { NavLink } from "@/components/nav";
import { requireProject } from "@/server/repo";

const TABS = [
  ["script", "Script"],
  ["scenes", "Scenes"],
  ["shots", "Shots"],
  ["perform", "Perform"],
  ["storyboard", "Storyboard"],
  ["animatic", "Animatic"],
  ["assets", "Assets"],
  ["generations", "Generations"],
] as const;

export default async function EpisodeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ project: string; ep: string }>;
}) {
  const { project: slug, ep } = await params;
  const data = await requireProject(slug);
  const episode = data.episodes.find((e) => e.slug === ep);
  if (!episode) notFound();
  const base = `/projects/${slug}/episodes/${ep}`;

  return (
    <div>
      <div className="flex items-center gap-4 border-b border-line bg-panel px-6">
        <div className="py-2 text-[12px]">
          <span className="font-mono text-muted">EP {episode.number}</span>
          <span className="ml-2 font-medium">{episode.title}</span>
        </div>
        <nav className="flex">
          {TABS.map(([path, label]) => (
            <NavLink key={path} href={`${base}/${path}`} variant="tab">
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
      {children}
    </div>
  );
}

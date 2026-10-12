import type { Episode, ProjectData } from "@/domain/schemas";

export const projectPath = (slug: string, sub = "") => `/projects/${slug}${sub}`;
export const episodePath = (slug: string, epSlug: string, sub = "") =>
  `/projects/${slug}/episodes/${epSlug}${sub}`;
export const shotPath = (slug: string, epSlug: string, shotId: string, section?: string) =>
  `/projects/${slug}/episodes/${epSlug}/shots/${shotId}${section ? `?section=${section}` : ""}`;

export function pickEpisode(data: ProjectData, epSlug?: string | null): Episode | null {
  const sorted = [...data.episodes].sort((a, b) => a.order - b.order);
  return sorted.find((e) => e.slug === epSlug) ?? sorted[0] ?? null;
}

/**
 * A creator-friendly download name for a final render: project + Episode number + Episode title, lowercase ASCII,
 * hyphenated, no path or unsafe characters (e.g. `ojousama-episode-1-the-arrangement.mp4`).
 */
export function renderFileName(projectSlug: string, episode: { number: number; title: string }): string {
  const slug = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const parts = [slug(projectSlug), `episode-${episode.number}`, slug(episode.title)].filter(Boolean);
  return `${parts.join("-").slice(0, 120).replace(/-+$/, "") || "episode"}.mp4`;
}

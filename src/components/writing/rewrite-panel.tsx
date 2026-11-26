import Link from "next/link";
import { Panel } from "@/components/ui";
import { RedraftEpisode, type RedraftQuote } from "@/components/writing/redraft-episode";
import type { Episode, ProjectData } from "@/domain/schemas";
import { estimateScreenMinutes } from "@/domain/story/writing";
import { episodePath } from "@/lib/paths";
import { quoteRedraft, recommendedWriter, writers } from "@/server/series-start";

/**
 * Rewrite an Episode wherever its script is shown: the whole Episode with a note (priced and confirmed; it opens on the
 * Episode's Write page as a proposal, and the script changes only when it is accepted), or a part, highlighted on the
 * Write page.
 */
export function RewritePanel({ data, episode }: { data: ProjectData; episode: Episode }) {
  if (!episode.scriptText.trim()) return null;
  const all = writers();
  const quotes: Record<string, RedraftQuote> = {};
  const freshQuotes: Record<string, RedraftQuote> = {};
  for (const w of all.filter((x) => x.available)) {
    const r = quoteRedraft(data, episode, w.value);
    quotes[w.value] = r.ok ? { ok: true, paid: r.paid, label: r.label, usd: r.usd } : r;
    const f = quoteRedraft(data, episode, w.value, true);
    freshQuotes[w.value] = f.ok ? { ok: true, paid: f.paid, label: f.label, usd: f.usd } : f;
  }
  const write = episodePath(data.project.slug, episode.slug, "/write");
  return (
    <Panel title="Rewrite this episode">
      <div id="rewrite" className="space-y-3" data-testid="rewrite-panel">
        <RedraftEpisode
          slug={data.project.slug}
          episodeId={episode.id}
          sessionId={null}
          minutes={episode.targetMinutes ?? null}
          writers={all}
          recommended={recommendedWriter()?.value ?? ""}
          quotes={quotes}
          freshQuotes={freshQuotes}
          runsMinutes={estimateScreenMinutes(episode.scriptText)}
          busy={false}
          opensOnWritePage
        />
        <p className="border-t border-line pt-2 text-[12px] text-muted">
          Only part of it?{" "}
          <Link href={write} className="text-accent hover:underline" data-testid="rewrite-part">
            Rewrite a part on the Write page
          </Link>{" "}
          — highlight a passage or pick a scene and say what to change.
        </p>
      </div>
    </Panel>
  );
}

import Link from "next/link";
import { Badge, Button, PageHeader, Panel } from "@/components/ui";
import { buildEpisodeCoverage } from "@/domain/coverage";
import type { Episode, ProjectData } from "@/domain/schemas";
import { parseScreenplay, syncScript } from "@/domain/script";
import { saveScript } from "@/server/actions";
import { ActionForm } from "@/components/action-form";

export function ScriptView({ data, episode }: { data: ProjectData; episode: Episode }) {
  const parsed = parseScreenplay(episode.scriptText);
  const coverage = buildEpisodeCoverage(data, episode.id);
  const scenes = data.scenes.filter((s) => s.episodeId === episode.id);
  const lines = data.dialogueLines.filter((l) => l.episodeId === episode.id);
  const sync = syncScript(parsed, scenes, lines, (l) =>
    l.characterId
      ? (data.characters.find((c) => c.id === l.characterId)?.name.toUpperCase() ?? l.speakerLabel)
      : l.speakerLabel,
  );

  return (
    <div>
      <PageHeader
        title={`Script — ${episode.title}`}
        subtitle="Scene headings, action and dialogue become stable structured records. Locked dialogue is never rewritten by a script edit."
        actions={
          <>
            <Badge tone={coverage.percent === 100 ? "pass" : "warn"}>
              {coverage.percent}% covered by shots
            </Badge>
            <Link
              href={`/projects/${data.project.slug}/episodes/${episode.slug}/breakdown`}
              className="rounded-[3px] border border-line2 px-2 py-1 text-[12px] text-accent hover:bg-panel2"
            >
              Breakdown &amp; link shots →
            </Link>
          </>
        }
      />
      <div className="grid gap-4 p-6 xl:grid-cols-2">
        <Panel title="Screenplay text">
          <ActionForm action={saveScript} className="space-y-3">
            <input type="hidden" name="projectSlug" value={data.project.slug} />
            <input type="hidden" name="episodeId" value={episode.id} />
            <textarea
              name="scriptText"
              rows={28}
              defaultValue={episode.scriptText}
              spellCheck={false}
              className="font-mono !text-[12.5px] leading-relaxed"
            />
            <div className="flex items-center justify-between">
              <Button type="submit" variant="primary">
                Save & sync structure
              </Button>
              <span className="text-[11px] text-muted">
                Format: <code className="font-mono">INT. LOCATION - TIME</code>, then CHARACTER cue line +
                dialogue
              </span>
            </div>
          </ActionForm>
        </Panel>

        <div className="space-y-4">
          {sync.lockedConflicts.length > 0 ? (
            <Panel title="Locked dialogue conflicts" className="border-warn/40">
              <ul className="space-y-2">
                {sync.lockedConflicts.map((c) => (
                  <li key={c.lineId} className="text-[12px]">
                    <div className="text-warn">Script text differs from locked line — stored text kept.</div>
                    <div className="mt-0.5 font-mono text-muted">stored: {c.storedText}</div>
                    <div className="font-mono text-muted">script: {c.scriptText}</div>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          <Panel title={`Structure — ${parsed.length} scenes`}>
            <div className="space-y-4">
              {sync.scenes.map((s, i) => {
                const existing = scenes.find((x) => x.id === s.existingId);
                return (
                  <div key={i} className="border-l-2 border-line2 pl-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-muted">
                        {existing?.sceneNumber ?? "new"}
                      </span>
                      <span className="font-medium">{s.parsed.slugline}</span>
                      {!s.existingId ? <Badge tone="info">new</Badge> : null}
                    </div>
                    <div className="mt-1 space-y-1">
                      {s.parsed.blocks.map((b, j) =>
                        b.kind === "action" ? (
                          <p key={j} className="text-[12px] text-muted">
                            {b.text}
                          </p>
                        ) : (
                          <div key={j} className="flex items-baseline gap-2 text-[12px]">
                            <span className="w-28 shrink-0 font-mono text-[10.5px] uppercase text-accent">
                              {b.speaker}
                            </span>
                            <span>{b.text}</span>
                            {s.lines.find((l) => l.parsed === b)?.existingId ? (
                              data.dialogueLines.find(
                                (l) => l.id === s.lines.find((x) => x.parsed === b)?.existingId,
                              )?.locked ? (
                                <Badge tone="pass">locked</Badge>
                              ) : null
                            ) : (
                              <Badge tone="info">new</Badge>
                            )}
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

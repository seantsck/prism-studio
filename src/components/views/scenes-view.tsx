import { Badge, Button, Field, PageHeader, Panel } from "@/components/ui";
import type { Episode, ProjectData } from "@/domain/schemas";
import { saveScene } from "@/server/actions";
import { ActionForm } from "@/components/action-form";

export function ScenesView({ data, episode }: { data: ProjectData; episode: Episode }) {
  const scenes = data.scenes.filter((s) => s.episodeId === episode.id).sort((a, b) => a.order - b.order);
  const hidden = <input type="hidden" name="projectSlug" value={data.project.slug} />;

  return (
    <div>
      <PageHeader
        title={`Scenes — ${episode.title}`}
        subtitle="Dramatic purpose and emotional arc per scene."
      />
      <div className="space-y-3 p-6">
        {scenes.map((s) => {
          const shots = data.shots.filter((x) => x.sceneId === s.id);
          const lines = data.dialogueLines.filter((l) => l.sceneId === s.id);
          const loc = data.locations.find((l) => l.id === s.locationId);
          return (
            <details key={s.id} className="border border-line bg-panel">
              <summary className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="flex items-baseline gap-3">
                  <span className="font-mono text-muted">{s.sceneNumber}</span>
                  <span className="font-medium">{s.slugline}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  {s.emotionEntering ? (
                    <span className="text-[11px] text-muted">
                      {s.emotionEntering} → {s.emotionLeaving}
                    </span>
                  ) : null}
                  <Badge>{shots.length} shots</Badge>
                  <Badge>{lines.length} lines</Badge>
                  <Badge tone={loc ? "neutral" : "warn"}>{loc?.name ?? "no location"}</Badge>
                </span>
              </summary>
              <ActionForm action={saveScene} className="grid max-w-4xl grid-cols-2 gap-3 border-t border-line p-4">
                {hidden}
                <input type="hidden" name="id" value={s.id} />
                <Field label="Summary" className="col-span-2">
                  <textarea name="summary" rows={2} defaultValue={s.summary} />
                </Field>
                <Field label="Dramatic purpose" className="col-span-2">
                  <textarea name="dramaticPurpose" rows={2} defaultValue={s.dramaticPurpose} />
                </Field>
                <Field label="Emotional state entering">
                  <input name="emotionEntering" defaultValue={s.emotionEntering} />
                </Field>
                <Field label="Emotional state leaving">
                  <input name="emotionLeaving" defaultValue={s.emotionLeaving} />
                </Field>
                <Field label="Location">
                  <select name="locationId" defaultValue={s.locationId ?? ""}>
                    <option value="">—</option>
                    {data.locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Time of day">
                  <input name="timeOfDay" defaultValue={s.timeOfDay} />
                </Field>
                <div>
                  <div className="mb-1 text-[11px] text-muted">Characters</div>
                  {data.characters.map((c) => (
                    <label key={c.id} className="mr-3 inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        name="characterIds"
                        value={c.id}
                        defaultChecked={s.characterIds.includes(c.id)}
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
                <div>
                  <div className="mb-1 text-[11px] text-muted">Props</div>
                  {data.props.map((p) => (
                    <label key={p.id} className="mr-3 inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        name="propIds"
                        value={p.id}
                        defaultChecked={s.propIds.includes(p.id)}
                      />
                      {p.name}
                    </label>
                  ))}
                </div>
                <Field label="Continuity notes" className="col-span-2">
                  <textarea name="continuityNotes" rows={2} defaultValue={s.continuityNotes} />
                </Field>
                <div className="col-span-2 flex items-center justify-between">
                  <Button type="submit" variant="primary">
                    Save scene
                  </Button>
                  <span className="text-[11px] text-faint">
                    Script lines {s.scriptRange?.startLine ?? "–"}–{s.scriptRange?.endLine ?? "–"}
                  </span>
                </div>
              </ActionForm>
            </details>
          );
        })}
        {scenes.length === 0 ? (
          <Panel>
            <p className="text-muted">
              No scenes yet — write scene headings in the Script and save to create them.
            </p>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}

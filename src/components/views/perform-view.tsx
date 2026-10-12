import Link from "next/link";
import { AudioFileInput } from "@/components/audio-file-input";
import { Badge, Button, Field, PageHeader } from "@/components/ui";
import { formatSeconds } from "@/domain/duration";
import {
  PACES,
  TAKE_SOURCES,
  VOLUMES,
  type DialogueLine,
  type Episode,
  type ProjectData,
} from "@/domain/schemas";
import { shotPath } from "@/lib/paths";
import { assetUrl } from "@/lib/utils";
import {
  addTake,
  rateTake,
  saveDialogueLine,
  saveDirection,
  selectTake,
  setLineLocked,
} from "@/server/actions";

function LineCard({ data, episode, line }: { data: ProjectData; episode: Episode; line: DialogueLine }) {
  const slug = data.project.slug;
  const hidden = <input type="hidden" name="projectSlug" value={slug} />;
  const character = data.characters.find((c) => c.id === line.characterId);
  const direction = data.directions.find((d) => d.dialogueLineId === line.id);
  const takes = data.takes
    .filter((t) => t.dialogueLineId === line.id)
    .sort((a, b) => a.takeNumber - b.takeNumber);
  const selected = takes.find((t) => t.selected);
  const voices = data.voiceProfiles.filter((v) => v.characterId === line.characterId);
  const shots = data.shots.filter((s) => s.audio.dialogueLineIds.includes(line.id));

  return (
    <article className="border border-line bg-panel">
      <header className="flex items-start gap-3 border-b border-line px-4 py-3">
        <div className="w-24 shrink-0">
          <div className="font-mono text-[11px] uppercase text-accent">
            {character?.name ?? line.speakerLabel}
          </div>
          <div className="text-[10.5px] text-muted">{line.language}</div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] leading-snug">{line.originalText}</div>
          {line.translation ? <div className="mt-0.5 text-muted">{line.translation}</div> : null}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={line.locked ? "pass" : "warn"}>{line.locked ? "text locked" : "text open"}</Badge>
            <Badge tone={selected ? "pass" : "fail"}>
              {selected
                ? `canonical: take ${selected.takeNumber} · ${formatSeconds(selected.durationMs)}`
                : "no canonical take"}
            </Badge>
            {shots.map((s) => (
              <Link key={s.id} href={shotPath(slug, episode.slug, s.id, "performance")}>
                <Badge tone="info">shot {s.shotCode}</Badge>
              </Link>
            ))}
          </div>
        </div>
        <form action={setLineLocked}>
          {hidden}
          <input type="hidden" name="lineId" value={line.id} />
          <input type="hidden" name="locked" value={String(!line.locked)} />
          <Button size="sm" type="submit">
            {line.locked ? "Unlock text" : "Lock text"}
          </Button>
        </form>
      </header>

      <div className="grid gap-4 p-4 lg:grid-cols-[1fr_1.2fr]">
        <div className="space-y-3">
          <details>
            <summary className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
              Performance direction ▾
            </summary>
            <form action={saveDirection} className="grid grid-cols-2 gap-2">
              {hidden}
              <input type="hidden" name="lineId" value={line.id} />
              <Field label="Emotion">
                <input name="emotion" defaultValue={direction?.emotion ?? ""} />
              </Field>
              <Field label="Objective">
                <input name="objective" defaultValue={direction?.objective ?? ""} />
              </Field>
              <Field label="Subtext" className="col-span-2">
                <input name="subtext" defaultValue={direction?.subtext ?? line.subtext} />
              </Field>
              <Field label="Intensity (0–100)">
                <input
                  name="intensity"
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={direction?.intensity ?? 40}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Pace">
                  <select name="pace" defaultValue={direction?.pace ?? "natural"}>
                    {PACES.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Volume">
                  <select name="volume" defaultValue={direction?.volume ?? "normal"}>
                    {VOLUMES.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Pauses">
                <input name="pauses" defaultValue={direction?.pauses ?? ""} />
              </Field>
              <Field label="Breaths">
                <input name="breaths" defaultValue={direction?.breaths ?? ""} />
              </Field>
              <Field label="Emphasis" className="col-span-2">
                <input name="emphasisNotes" defaultValue={direction?.emphasisNotes ?? ""} />
              </Field>
              <Field label="Physical behavior" className="col-span-2">
                <input name="physicalBehaviorNotes" defaultValue={direction?.physicalBehaviorNotes ?? ""} />
              </Field>
              <div className="col-span-2">
                <Button size="sm" variant="primary" type="submit">
                  Save direction
                </Button>
              </div>
            </form>
          </details>
          {direction ? (
            <div className="text-[12px] text-muted">
              <span className="text-fg">{direction.emotion || "—"}</span> · wants:{" "}
              {direction.objective || "—"} · intensity{" "}
              <span className="font-mono">{direction.intensity}</span> · {direction.pace} · {direction.volume}
            </div>
          ) : null}

          <details>
            <summary className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Line details ▾
            </summary>
            <form action={saveDialogueLine} className="mt-2 space-y-2">
              {hidden}
              <input type="hidden" name="lineId" value={line.id} />
              <Field label="Text" hint={line.locked ? "Locked — unlock to edit" : undefined}>
                <textarea
                  name="originalText"
                  rows={2}
                  defaultValue={line.originalText}
                  readOnly={line.locked}
                />
              </Field>
              <Field label="Translation">
                <input name="translation" defaultValue={line.translation ?? ""} />
              </Field>
              <Field label="Pronunciation notes">
                <input name="pronunciationNotes" defaultValue={line.pronunciationNotes} />
              </Field>
              <Field label="Dramatic context">
                <input name="dramaticContext" defaultValue={line.dramaticContext} />
              </Field>
              <Field label="Subtext">
                <input name="subtext" defaultValue={line.subtext} />
              </Field>
              <Button size="sm" type="submit">
                Save line
              </Button>
            </form>
          </details>
        </div>

        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Takes ({takes.length})
          </div>
          <div className="space-y-1.5">
            {takes.map((t) => {
              const asset = data.assets.find((a) => a.id === t.audioAssetId);
              const url = assetUrl(asset);
              return (
                <div
                  key={t.id}
                  className={`flex items-center gap-3 border px-2.5 py-1.5 ${t.selected ? "border-accent/60 bg-accent/5" : "border-line"}`}
                >
                  <span className="w-6 font-mono text-[11px] text-muted">#{t.takeNumber}</span>
                  <span className="w-12 font-mono text-[12px]">{formatSeconds(t.durationMs)}</span>
                  <Badge>{t.sourceType.replace("_", " ")}</Badge>
                  <span className="min-w-0 flex-1 truncate text-muted">{t.notes}</span>
                  {url ? (
                    <audio controls src={url} className="h-6 w-40" preload="none" />
                  ) : (
                    <span className="text-[10.5px] text-faint">no audio file</span>
                  )}
                  <form action={rateTake} className="flex items-center gap-1">
                    {hidden}
                    <input type="hidden" name="takeId" value={t.id} />
                    <select name="rating" defaultValue={t.rating} className="!w-12 !px-1 !py-0.5">
                      {[0, 1, 2, 3, 4, 5].map((r) => (
                        <option key={r} value={r}>
                          {r ? "★".repeat(r) : "–"}
                        </option>
                      ))}
                    </select>
                    <Button size="sm" variant="ghost" type="submit">
                      Rate
                    </Button>
                  </form>
                  {t.selected ? (
                    <Badge tone="accent">canonical</Badge>
                  ) : (
                    <form action={selectTake}>
                      {hidden}
                      <input type="hidden" name="takeId" value={t.id} />
                      <Button size="sm" type="submit">
                        Select
                      </Button>
                    </form>
                  )}
                </div>
              );
            })}
            {takes.length === 0 ? (
              <div className="border border-dashed border-line2 p-3 text-muted">No takes yet.</div>
            ) : null}
          </div>

          <details className="mt-3">
            <summary className="text-[11px] font-semibold uppercase tracking-wide text-accent">
              + Add take ▾
            </summary>
            <form action={addTake} className="mt-2 grid grid-cols-2 gap-2">
              {hidden}
              <input type="hidden" name="lineId" value={line.id} />
              <Field label="Source">
                <select name="sourceType" defaultValue="temp_voice">
                  {TAKE_SOURCES.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <Field label="Voice profile">
                <select name="voiceProfileId" defaultValue="">
                  <option value="">—</option>
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </Field>
              <AudioFileInput />
              <Field label="Rating">
                <select name="rating" defaultValue={0}>
                  {[0, 1, 2, 3, 4, 5].map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </Field>
              <Field label="Transcript">
                <input name="transcript" />
              </Field>
              <Field label="Notes" className="col-span-2">
                <input name="notes" />
              </Field>
              <div className="col-span-2">
                <Button size="sm" variant="primary" type="submit">
                  Add take
                </Button>
              </div>
            </form>
          </details>
        </div>
      </div>
    </article>
  );
}

export function PerformView({ data, episode }: { data: ProjectData; episode: Episode }) {
  const scenes = data.scenes.filter((s) => s.episodeId === episode.id).sort((a, b) => a.order - b.order);
  const lines = data.dialogueLines.filter((l) => l.episodeId === episode.id);
  const withTake = lines.filter((l) =>
    data.takes.some((t) => t.dialogueLineId === l.id && t.selected),
  ).length;
  const lockedLines = lines.filter((l) => l.locked).length;

  return (
    <div>
      <PageHeader
        title={`Perform — ${episode.title}`}
        subtitle="Dialogue → direction → takes. The selected take drives shot timing and the animatic."
        actions={
          <>
            <Badge tone={withTake === lines.length ? "pass" : "warn"}>
              {withTake}/{lines.length} canonical takes
            </Badge>
            <Badge>{lockedLines} locked</Badge>
          </>
        }
      />
      <div className="space-y-8 p-6">
        {scenes.map((scene) => {
          const sceneLines = lines.filter((l) => l.sceneId === scene.id).sort((a, b) => a.order - b.order);
          if (sceneLines.length === 0) return null;
          return (
            <section key={scene.id}>
              <h2 className="mb-2 text-[12px] font-semibold">
                <span className="mr-2 font-mono text-muted">{scene.sceneNumber}</span>
                {scene.slugline}
              </h2>
              <div className="space-y-3">
                {sceneLines.map((l) => (
                  <LineCard key={l.id} data={data} episode={episode} line={l} />
                ))}
              </div>
            </section>
          );
        })}
        {lines.length === 0 ? (
          <div className="border border-dashed border-line2 p-6 text-center text-muted">
            No dialogue yet. Add dialogue in the Script and it will appear here as structured lines.
          </div>
        ) : null}
      </div>
    </div>
  );
}

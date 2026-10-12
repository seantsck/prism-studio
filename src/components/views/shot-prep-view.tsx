import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { AudioPlayer } from "@/components/audio-player";
import { FramePlaceholder, PreflightList, ReadinessBadge, ScoreBar } from "@/components/shared";
import { Badge, Button, Field, STATUS_TONE } from "@/components/ui";
import { shotOrder, buildShotContext, type ShotContext } from "@/domain/context";
import { shotSourceContent } from "@/domain/coverage";
import { formatSeconds } from "@/domain/duration";
import { PART_LABELS, storyboardFreshness } from "@/domain/fingerprint";
import { assembleGenerationPackage, renderGenerationBrief } from "@/domain/generation-package";
import {
  itemsBySection,
  runPreflight,
  type PreflightReport,
  type PreflightSection,
} from "@/domain/preflight";
import {
  CONTINUITY_DIMENSIONS,
  FRAME_SOURCES,
  type Episode,
  type ProjectData,
  type Shot,
} from "@/domain/schemas";
import { SHOT_SECTION_SPECS, getByPath, type EditableSectionKey, type FieldSpec } from "@/domain/shot-fields";
import { shortFingerprint } from "@/domain/hash";
import { timelineFromContext } from "@/domain/timeline";
import { episodePath, shotPath } from "@/lib/paths";
import { assetUrl, cn } from "@/lib/utils";
import {
  addStoryboardFrame,
  saveContinuityCheck,
  saveShotBeats,
  saveShotCharacters,
  saveShotDialogue,
  saveShotProps,
  saveShotSection,
  setFrameApproved,
  setShotApproval,
  setShotSource,
} from "@/server/actions";

// ───────────────────────── Field renderer ─────────────────────────

function FieldInput({ spec, shot, data }: { spec: FieldSpec; shot: Shot; data: ProjectData }) {
  const value = getByPath(shot, spec.path);
  const common = { name: spec.path, id: spec.path };
  let control: React.ReactNode;
  switch (spec.kind) {
    case "textarea":
      control = <textarea {...common} rows={2} defaultValue={String(value ?? "")} />;
      break;
    case "lines":
      control = <textarea {...common} rows={3} defaultValue={((value as string[]) ?? []).join("\n")} />;
      break;
    case "number":
      control = <input {...common} type="number" defaultValue={value == null ? "" : String(value)} />;
      break;
    case "seconds":
      control = (
        <input
          {...common}
          type="number"
          step="0.1"
          min="0"
          defaultValue={value == null ? "" : String((value as number) / 1000)}
        />
      );
      break;
    case "bool":
      control = (
        <label className="flex h-[30px] items-center gap-2">
          <input type="checkbox" {...common} defaultChecked={Boolean(value)} />
          <span className="text-muted">Yes</span>
        </label>
      );
      break;
    case "select":
      control = (
        <select {...common} defaultValue={String(value ?? "")}>
          {spec.options?.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      );
      break;
    case "ref:location":
      control = (
        <select {...common} defaultValue={String(value ?? "")}>
          <option value="">— none —</option>
          {data.locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
              {l.locked ? " 🔒" : ""}
            </option>
          ))}
        </select>
      );
      break;
    case "ref:shot":
      control = (
        <select {...common} defaultValue={String(value ?? "")}>
          <option value="">— none —</option>
          {data.shots
            .filter((s) => s.episodeId === shot.episodeId && s.id !== shot.id)
            .sort(shotOrder(data))
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.shotCode} — {s.title}
              </option>
            ))}
        </select>
      );
      break;
    default:
      control = <input {...common} defaultValue={String(value ?? "")} />;
  }
  return (
    <Field label={spec.label} hint={spec.hint} className={spec.wide ? "col-span-2" : undefined}>
      {control}
    </Field>
  );
}

function SectionForm({
  sectionKey,
  shot,
  data,
  extra,
}: {
  sectionKey: EditableSectionKey;
  shot: Shot;
  data: ProjectData;
  extra?: React.ReactNode;
}) {
  const spec = SHOT_SECTION_SPECS.find((s) => s.key === sectionKey)!;
  return (
    <ActionForm action={saveShotSection} className="grid grid-cols-2 gap-3">
      <input type="hidden" name="projectSlug" value={data.project.slug} />
      <input type="hidden" name="shotId" value={shot.id} />
      <input type="hidden" name="section" value={sectionKey} />
      {spec.fields.map((f) => (
        <FieldInput key={f.path} spec={f} shot={shot} data={data} />
      ))}
      {extra}
      <div className="col-span-2">
        <Button type="submit" variant="primary" size="sm">
          Save {spec.label.toLowerCase()}
        </Button>
      </div>
    </ActionForm>
  );
}

// ───────────────────────── Section frame ─────────────────────────

const SECTION_ORDER: Array<{ key: string; label: string; preflight: PreflightSection[] }> = [
  { key: "story", label: "1 · Story", preflight: ["story"] },
  { key: "source", label: "2 · Source script", preflight: [] },
  { key: "performance", label: "3 · Performance", preflight: ["performance"] },
  { key: "character", label: "4 · Character", preflight: ["character"] },
  { key: "look", label: "5 · Look", preflight: [] },
  { key: "set", label: "6 · Location / set", preflight: ["set"] },
  { key: "camera", label: "7 · Camera", preflight: ["camera"] },
  { key: "composition", label: "8 · Composition", preflight: [] },
  { key: "blocking", label: "9 · Blocking", preflight: ["blocking"] },
  { key: "action", label: "10 · Action timing", preflight: [] },
  { key: "continuity", label: "11 · Continuity", preflight: ["continuity"] },
  { key: "props", label: "12 · Props", preflight: [] },
  { key: "lighting", label: "13 · Lighting", preflight: [] },
  { key: "audio", label: "14 · Audio", preflight: ["audio"] },
  { key: "storyboard", label: "15 · Storyboard / keyframes", preflight: ["storyboard"] },
  { key: "generation", label: "16 · Generation intent", preflight: ["generation"] },
  { key: "preflight", label: "17 · Preflight", preflight: [] },
  { key: "brief", label: "18 · Generation brief", preflight: [] },
];

function SectionChrome({
  id,
  label,
  report,
  preflight,
  open,
  children,
}: {
  id: string;
  label: string;
  report: PreflightReport;
  preflight: PreflightSection[];
  open: boolean;
  children: React.ReactNode;
}) {
  const items = preflight.flatMap((s) => itemsBySection(report, s));
  const fails = items.filter((i) => i.status === "fail").length;
  const warns = items.filter((i) => i.status === "warn").length;
  const passes = items.filter((i) => i.status === "pass").length;
  return (
    <details id={id} open={open} className="scroll-mt-4 border border-line bg-panel">
      <summary className="flex items-center justify-between px-4 py-2.5 hover:bg-panel2">
        <span className="text-[12.5px] font-semibold">{label}</span>
        <span className="flex items-center gap-1.5">
          {fails > 0 ? <Badge tone="fail">{fails} ✕</Badge> : null}
          {warns > 0 ? <Badge tone="warn">{warns} ⚠</Badge> : null}
          {fails === 0 && warns === 0 && passes > 0 ? <Badge tone="pass">✓</Badge> : null}
        </span>
      </summary>
      <div className="space-y-4 border-t border-line p-4">{children}</div>
    </details>
  );
}

function Gate({
  data,
  shot,
  gate,
  label,
  note,
}: {
  data: ProjectData;
  shot: Shot;
  gate: keyof Shot["approval"];
  label: string;
  note?: string;
}) {
  const on = shot.approval[gate];
  return (
    <ActionForm
      action={setShotApproval}
      className="flex items-center justify-between border border-line px-3 py-2"
    >
      <input type="hidden" name="projectSlug" value={data.project.slug} />
      <input type="hidden" name="shotId" value={shot.id} />
      <input type="hidden" name="gate" value={gate} />
      <input type="hidden" name="value" value={String(!on)} />
      <span>
        {label}
        {note ? <span className="block text-[10.5px] text-faint">{note}</span> : null}
      </span>
      <Button size="sm" variant={on ? "primary" : "secondary"} type="submit">
        {on ? "Approved ✓ (revoke)" : "Approve"}
      </Button>
    </ActionForm>
  );
}

// ───────────────────────── Page ─────────────────────────

export function ShotPrepView({
  data,
  episode,
  shotId,
  openSection,
}: {
  data: ProjectData;
  episode: Episode;
  shotId: string;
  openSection?: string;
}) {
  const ctx: ShotContext = buildShotContext(data, shotId);
  const { shot } = ctx;
  const report = runPreflight(ctx);
  const slug = data.project.slug;
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="shotId" value={shot.id} />
    </>
  );

  const ordered = data.shots.filter((s) => s.episodeId === episode.id).sort(shotOrder(data));
  const idx = ordered.findIndex((s) => s.id === shot.id);
  const prev = ordered[idx - 1];
  const next = ordered[idx + 1];

  const firstFailing = SECTION_ORDER.find((s) =>
    s.preflight.some((p) => itemsBySection(report, p).some((i) => i.status === "fail")),
  );
  const openKey =
    openSection && SECTION_ORDER.some((s) => s.key === openSection)
      ? openSection
      : (firstFailing?.key ?? "story");

  const sceneLines = data.dialogueLines
    .filter((l) => l.sceneId === shot.sceneId)
    .sort((a, b) => a.order - b.order);
  const sceneActions = data.actionBlocks
    .filter((b) => b.sceneId === shot.sceneId)
    .sort((a, b) => a.order - b.order);
  const source = shotSourceContent(data, shot);
  const pkg = assembleGenerationPackage(ctx);
  const brief = renderGenerationBrief(pkg);
  const timeline = timelineFromContext(ctx);
  const freshness = storyboardFreshness(ctx, ctx.approvedFrame);
  const frame = ctx.approvedFrame ?? ctx.frames[0];
  const frameUrl = frame?.assetId ? assetUrl(ctx.assets.get(frame.assetId)) : null;
  const checks = data.continuityChecks
    .filter((c) => c.shotId === shot.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const lastAttempt = data.attempts
    .filter((a) => a.shotId === shot.id)
    .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
  const changedSinceAttempt =
    lastAttempt &&
    lastAttempt.packageFingerprint &&
    lastAttempt.packageFingerprint !== pkg.provenance.fingerprint;

  const sectionProps = (key: string) => {
    const meta = SECTION_ORDER.find((s) => s.key === key)!;
    return { id: key, label: meta.label, report, preflight: meta.preflight, open: openKey === key };
  };

  const warnings = [
    ...freshness.messages,
    ...(changedSinceAttempt
      ? [
          `This shot has changed since generation attempt ${lastAttempt!.attemptNumber} (package ${shortFingerprint(lastAttempt!.packageFingerprint)} → ${shortFingerprint(pkg.provenance.fingerprint)}). The attempt itself is unchanged and stays interpretable.`,
        ]
      : []),
  ];

  return (
    <div>
      <div className="flex items-center justify-between gap-4 border-b border-line px-6 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <Link href={episodePath(slug, episode.slug, "/shots")} className="hover:text-fg">
              Ep {episode.number} · Shots
            </Link>
            <span>/</span>
            <span>Scene {ctx.scene.sceneNumber}</span>
          </div>
          <h1 className="truncate text-[17px] font-semibold tracking-tight">
            <span className="mr-2 font-mono text-accent">{shot.shotCode}</span>
            {shot.title}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={STATUS_TONE[shot.status]}>{shot.status}</Badge>
          <ReadinessBadge report={report} />
          <div className="flex gap-1">
            {prev ? (
              <Link
                className="rounded-[3px] border border-line2 px-2 py-0.5 hover:bg-panel2"
                href={shotPath(slug, episode.slug, prev.id)}
              >
                ← {prev.shotCode}
              </Link>
            ) : null}
            {next ? (
              <Link
                className="rounded-[3px] border border-line2 px-2 py-0.5 hover:bg-panel2"
                href={shotPath(slug, episode.slug, next.id)}
              >
                {next.shotCode} →
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      {warnings.length > 0 ? (
        <div role="status" className="border-b border-warn/30 bg-warn/10 px-6 py-2 text-[12px] text-warn">
          <ul className="space-y-0.5">
            {warnings.map((w) => (
              <li key={w}>⚠ {w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-4 p-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-2">
          {/* 1 Story */}
          <SectionChrome {...sectionProps("story")}>
            <SectionForm sectionKey="story" shot={shot} data={data} />
            <div className="border-t border-line pt-3 text-[12px] text-muted">
              Effective duration{" "}
              <span className="font-mono text-fg">{formatSeconds(ctx.duration.durationMs)}</span>{" "}
              {ctx.duration.source === "performance" && ctx.duration.breakdown ? (
                <>
                  = pre {formatSeconds(ctx.duration.breakdown.preRollMs)} + performance{" "}
                  {formatSeconds(ctx.duration.breakdown.performanceMs)}
                  {ctx.duration.breakdown.gapsMs
                    ? ` + gaps ${formatSeconds(ctx.duration.breakdown.gapsMs)}`
                    : ""}{" "}
                  + post {formatSeconds(ctx.duration.breakdown.postRollMs)}
                </>
              ) : ctx.duration.source === "manual_fallback" ? (
                <span className="text-warn">
                  (manual fallback — {ctx.duration.missingTakeLineIds.length} line(s) lack a canonical take)
                </span>
              ) : (
                <>({ctx.duration.source})</>
              )}
            </div>
          </SectionChrome>

          {/* 2 Source script */}
          <SectionChrome {...sectionProps("source")}>
            {source.empty ? (
              <div className="text-warn">
                This shot is not linked to any script content. Link action or dialogue below, or create shots
                from the Breakdown view, so coverage can be traced.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {source.actions.map((a) => (
                  <li key={a.id} className="flex items-start gap-2 border border-line p-2">
                    <Badge>action</Badge>
                    <div className="min-w-0 flex-1">
                      {a.startLine != null ? (
                        <span className="mr-2 font-mono text-[10.5px] text-faint">L{a.startLine}</span>
                      ) : null}
                      {a.text}
                    </div>
                    <ActionForm action={setShotSource} quiet>
                      {hidden}
                      <input type="hidden" name="kind" value="action" />
                      <input type="hidden" name="sourceId" value={a.id} />
                      <input type="hidden" name="link" value="false" />
                      <Button size="sm" variant="ghost" type="submit">
                        Unlink
                      </Button>
                    </ActionForm>
                  </li>
                ))}
                {source.dialogue.map((l) => (
                  <li key={l.id} className="flex items-start gap-2 border border-line p-2">
                    <Badge tone="info">dialogue</Badge>
                    <div className="min-w-0 flex-1">
                      <span className="mr-2 font-mono text-[10.5px] uppercase text-accent">
                        {data.characters.find((c) => c.id === l.characterId)?.name ?? l.speakerLabel}
                      </span>
                      「{l.originalText}」
                      {l.sourceStartLine != null ? (
                        <span className="ml-2 font-mono text-[10.5px] text-faint">L{l.sourceStartLine}</span>
                      ) : null}
                    </div>
                    {shot.scriptSources.dialogueLineIds.includes(l.id) ? (
                      <ActionForm action={setShotSource} quiet>
                        {hidden}
                        <input type="hidden" name="kind" value="dialogue" />
                        <input type="hidden" name="sourceId" value={l.id} />
                        <input type="hidden" name="link" value="false" />
                        <Button size="sm" variant="ghost" type="submit">
                          Unlink
                        </Button>
                      </ActionForm>
                    ) : (
                      <span className="text-[10.5px] text-faint">via performance</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {(() => {
              const linkedA = new Set(shot.scriptSources.actionBlockIds);
              const linkedD = new Set([...shot.scriptSources.dialogueLineIds, ...shot.audio.dialogueLineIds]);
              const freeA = sceneActions.filter((a) => !linkedA.has(a.id));
              const freeD = sceneLines.filter((l) => !linkedD.has(l.id));
              if (freeA.length + freeD.length === 0) return null;
              return (
                <div className="border-t border-line pt-3">
                  <div className="mb-1.5 text-[11px] text-muted">
                    Other content in scene {ctx.scene.sceneNumber}
                  </div>
                  <ul className="space-y-1">
                    {freeA.map((a) => (
                      <li key={a.id} className="flex items-start gap-2 text-[12px]">
                        <span className="min-w-0 flex-1 text-muted">{a.text}</span>
                        <ActionForm action={setShotSource} quiet>
                          {hidden}
                          <input type="hidden" name="kind" value="action" />
                          <input type="hidden" name="sourceId" value={a.id} />
                          <Button size="sm" type="submit">
                            Link
                          </Button>
                        </ActionForm>
                      </li>
                    ))}
                    {freeD.map((l) => (
                      <li key={l.id} className="flex items-start gap-2 text-[12px]">
                        <span className="min-w-0 flex-1 text-muted">
                          {l.speakerLabel}: 「{l.originalText}」
                        </span>
                        <ActionForm action={setShotSource} quiet>
                          {hidden}
                          <input type="hidden" name="kind" value="dialogue" />
                          <input type="hidden" name="sourceId" value={l.id} />
                          <Button size="sm" type="submit">
                            Link
                          </Button>
                        </ActionForm>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
            <Link
              className="text-[12px] text-accent hover:underline"
              href={episodePath(slug, episode.slug, "/breakdown")}
            >
              Open Breakdown →
            </Link>
          </SectionChrome>

          {/* 3 Performance */}
          <SectionChrome {...sectionProps("performance")}>
            <div className="space-y-2">
              {ctx.lines.length === 0 ? (
                <div className="text-muted">No dialogue linked — no performance required.</div>
              ) : null}
              {ctx.lines.map((l) => (
                <div key={l.line.id} className="border border-line p-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="font-mono text-[11px] uppercase text-accent">
                        {l.character?.name ?? l.line.speakerLabel}
                      </span>
                      <div className="text-[14px]">{l.line.originalText}</div>
                      {l.direction ? (
                        <div className="text-[11.5px] text-muted">
                          {l.direction.emotion} · intensity {l.direction.intensity} · {l.direction.pace}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Badge tone={l.line.locked ? "pass" : "warn"}>
                        {l.line.locked ? "text locked" : "text open"}
                      </Badge>
                      {l.selectedTake ? (
                        <Badge tone="pass">
                          take {l.selectedTake.takeNumber} · {formatSeconds(l.selectedTake.durationMs)}
                        </Badge>
                      ) : (
                        <Badge tone="fail">no canonical take</Badge>
                      )}
                    </div>
                  </div>
                  {l.selectedTake ? (
                    <div className="mt-2">
                      <AudioPlayer
                        src={assetUrl(l.selectedAudioAsset)}
                        waveform={l.selectedTake.waveform}
                        durationMs={l.selectedTake.durationMs}
                        label={`take ${l.selectedTake.takeNumber}`}
                        selected
                        compact
                      />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <ActionForm action={saveShotDialogue} className="space-y-1.5 border-t border-line pt-3">
              {hidden}
              <div className="text-[11px] text-muted">
                Dialogue in this shot (from scene {ctx.scene.sceneNumber})
              </div>
              {sceneLines.map((l) => (
                <label key={l.id} className="flex items-baseline gap-2">
                  <input
                    type="checkbox"
                    name="lineId"
                    value={l.id}
                    defaultChecked={shot.audio.dialogueLineIds.includes(l.id)}
                  />
                  <span className="font-mono text-[10.5px] uppercase text-accent">{l.speakerLabel}</span>
                  <span>{l.originalText}</span>
                </label>
              ))}
              {sceneLines.length === 0 ? (
                <div className="text-muted">This scene has no dialogue lines.</div>
              ) : null}
              <Button size="sm" type="submit">
                Save dialogue links
              </Button>
            </ActionForm>
            <Gate
              data={data}
              shot={shot}
              gate="performanceApproved"
              label="Performance approved"
              note="Required when the shot has dialogue"
            />
            <Link
              className="text-[12px] text-accent hover:underline"
              href={episodePath(slug, episode.slug, "/perform")}
            >
              Open Perform workspace →
            </Link>
          </SectionChrome>

          {/* 4 Character */}
          <SectionChrome {...sectionProps("character")}>
            <ActionForm action={saveShotCharacters} className="space-y-3">
              {hidden}
              {data.characters.map((c) => {
                const a = shot.characters.find((x) => x.characterId === c.id);
                const looks = data.looks.filter(
                  (l) => l.characterId === c.id && (!l.episodeId || l.episodeId === shot.episodeId),
                );
                return (
                  <div
                    key={c.id}
                    className={cn("border p-2.5", a ? "border-line2" : "border-line opacity-70")}
                  >
                    <label className="flex items-center gap-2 font-medium">
                      <input type="checkbox" name="characterId" value={c.id} defaultChecked={Boolean(a)} />
                      {c.name}
                      <span className="text-[11px] font-normal text-muted">{c.role}</span>
                    </label>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <Field label="Look (by id — wardrobe is never copied)" className="col-span-2">
                        <select name={`look:${c.id}`} defaultValue={a?.lookId ?? ""}>
                          <option value="">— none —</option>
                          {looks.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.name}
                              {l.locked ? " 🔒" : ""}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Expression">
                        <input name={`expression:${c.id}`} defaultValue={a?.expression ?? ""} />
                      </Field>
                      <Field label="Posture">
                        <input name={`posture:${c.id}`} defaultValue={a?.posture ?? ""} />
                      </Field>
                      <Field label="Gestures">
                        <input name={`gestures:${c.id}`} defaultValue={a?.gestures ?? ""} />
                      </Field>
                      <Field label="Physical interactions">
                        <input name={`interactions:${c.id}`} defaultValue={a?.physicalInteractions ?? ""} />
                      </Field>
                      <Field label="Performance notes" className="col-span-2">
                        <input name={`notes:${c.id}`} defaultValue={a?.performanceNotes ?? ""} />
                      </Field>
                    </div>
                  </div>
                );
              })}
              <label className="flex items-center gap-2 text-muted">
                <input type="checkbox" name="syncCount" defaultChecked />
                Set continuity character count to the number assigned
              </label>
              <Button size="sm" variant="primary" type="submit">
                Save characters
              </Button>
            </ActionForm>
          </SectionChrome>

          {/* 5 Look (resolved, read-only) */}
          <SectionChrome {...sectionProps("look")}>
            {ctx.characters.length === 0 ? (
              <div className="text-muted">No characters assigned.</div>
            ) : (
              ctx.characters.map((c) => (
                <div key={c.assignment.characterId} className="border border-line p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{c.character?.name ?? "Unknown character"}</span>
                    {c.look ? (
                      <Badge tone={c.look.locked ? "pass" : "warn"}>
                        {c.look.locked ? "locked" : "unlocked"}
                      </Badge>
                    ) : (
                      <Badge tone="fail">no Look assigned</Badge>
                    )}
                  </div>
                  {c.look ? (
                    <dl className="mt-1.5 grid grid-cols-[90px_1fr] gap-x-3 gap-y-0.5 text-[12px]">
                      <dt className="text-muted">Look</dt>
                      <dd>{c.look.name}</dd>
                      {(
                        [
                          ["Wardrobe", c.look.wardrobe],
                          ["Shoes", c.look.shoes],
                          ["Jewelry", c.look.jewelry],
                          ["Hair", c.look.hair],
                          ["Makeup", c.look.makeup],
                          ["Accessories", c.look.accessories],
                        ] as const
                      )
                        .filter(([, v]) => v)
                        .map(([k, v]) => (
                          <div key={k} className="contents">
                            <dt className="text-muted">{k}</dt>
                            <dd>{v}</dd>
                          </div>
                        ))}
                      <dt className="text-muted">References</dt>
                      <dd>
                        {c.look.referenceAssetIds.length} Look image(s) ·{" "}
                        {c.identityRefs.filter((r) => r.assetId).length} identity image(s)
                      </dd>
                    </dl>
                  ) : null}
                  {c.character ? (
                    <Link
                      className="mt-1.5 inline-block text-[11.5px] text-accent hover:underline"
                      href={`/projects/${slug}/characters/${c.character.id}`}
                    >
                      Edit Looks →
                    </Link>
                  ) : null}
                </div>
              ))
            )}
            <p className="text-[11px] text-faint">
              Wardrobe text is read from the Look when the generation package is built — it is never copied
              into the shot, so it cannot drift.
            </p>
          </SectionChrome>

          {/* 6 Location / set */}
          <SectionChrome {...sectionProps("set")}>
            <SectionForm sectionKey="set" shot={shot} data={data} />
            {ctx.location ? (
              <div className="border-t border-line pt-3 text-[12px] text-muted">
                <div className="font-medium text-fg">
                  {ctx.location.name} {ctx.location.locked ? <Badge tone="pass">locked</Badge> : null}
                </div>
                <div>{ctx.location.geography}</div>
                {ctx.location.zones.length ? (
                  <div>Zones: {ctx.location.zones.map((z) => z.name).join(" · ")}</div>
                ) : null}
              </div>
            ) : null}
          </SectionChrome>

          {/* 7 Camera, 8 Composition */}
          <SectionChrome {...sectionProps("camera")}>
            <SectionForm sectionKey="camera" shot={shot} data={data} />
          </SectionChrome>
          <SectionChrome {...sectionProps("composition")}>
            <SectionForm sectionKey="composition" shot={shot} data={data} />
          </SectionChrome>

          {/* 9 Blocking */}
          <SectionChrome {...sectionProps("blocking")}>
            <SectionForm sectionKey="blocking" shot={shot} data={data} />
            <ActionForm action={saveShotBeats} className="grid grid-cols-2 gap-3 border-t border-line pt-3">
              {hidden}
              <Field
                label="Subject marks"
                hint="label | x 0–1 | y 0–1 | notes — one per line"
                className="col-span-2"
              >
                <textarea
                  name="marks"
                  rows={3}
                  defaultValue={shot.spatial.marks
                    .map((m) => `${m.label} | ${m.x} | ${m.y} | ${m.notes}`)
                    .join("\n")}
                />
              </Field>
              <div className="col-span-2">
                <Button size="sm" type="submit">
                  Save marks
                </Button>
              </div>
            </ActionForm>
          </SectionChrome>

          {/* 10 Action timing */}
          <SectionChrome {...sectionProps("action")}>
            <SectionForm sectionKey="action" shot={shot} data={data} />
            <ActionForm action={saveShotBeats} className="grid grid-cols-2 gap-3 border-t border-line pt-3">
              {hidden}
              <Field label="Action beats" hint="seconds | description — one per line" className="col-span-2">
                <textarea
                  name="beats"
                  rows={4}
                  defaultValue={[...shot.action.beats]
                    .sort((a, b) => a.order - b.order)
                    .map((b) => `${(b.atMs / 1000).toFixed(1)} | ${b.description}`)
                    .join("\n")}
                />
              </Field>
              <div className="col-span-2">
                <Button size="sm" type="submit">
                  Save beats
                </Button>
              </div>
            </ActionForm>
            <div className="border-t border-line pt-3">
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                Timing breakdown
              </h3>
              <TimingList timeline={timeline} />
            </div>
          </SectionChrome>

          {/* 11 Continuity */}
          <SectionChrome {...sectionProps("continuity")}>
            <SectionForm sectionKey="continuity" shot={shot} data={data} />
            <Gate data={data} shot={shot} gate="continuityApproved" label="Continuity approved" />
          </SectionChrome>

          {/* 12 Props */}
          <SectionChrome {...sectionProps("props")}>
            {data.props.length === 0 ? (
              <div className="text-muted">The project has no props yet.</div>
            ) : (
              <ActionForm action={saveShotProps} className="space-y-1.5">
                {hidden}
                {data.props.map((p) => (
                  <label key={p.id} className="flex items-baseline gap-2">
                    <input
                      type="checkbox"
                      name="propId"
                      value={p.id}
                      defaultChecked={shot.propIds.includes(p.id)}
                    />
                    <span className="font-medium">{p.name}</span>
                    <span className="text-muted">{p.description}</span>
                  </label>
                ))}
                <Button size="sm" type="submit">
                  Save props
                </Button>
              </ActionForm>
            )}
          </SectionChrome>

          {/* 13 Lighting */}
          <SectionChrome {...sectionProps("lighting")}>
            <SectionForm sectionKey="lighting" shot={shot} data={data} />
          </SectionChrome>

          {/* 14 Audio */}
          <SectionChrome {...sectionProps("audio")}>
            <SectionForm sectionKey="audio" shot={shot} data={data} />
          </SectionChrome>

          {/* 15 Storyboard */}
          <SectionChrome {...sectionProps("storyboard")}>
            {freshness.status === "stale" || freshness.timingChange ? (
              <div className="border border-warn/40 bg-warn/10 p-2.5 text-[12px] text-warn">
                <div className="font-medium">Storyboard may be stale — the shot changed since approval.</div>
                <ul className="mt-1 list-disc pl-4">
                  {freshness.changedParts.map((p) => (
                    <li key={p}>{PART_LABELS[p]} changed</li>
                  ))}
                  {freshness.timingChange ? (
                    <li>
                      Derived duration {formatSeconds(freshness.timingChange.fromMs)} →{" "}
                      {formatSeconds(freshness.timingChange.toMs)}
                    </li>
                  ) : null}
                </ul>
                <div className="mt-1 text-[11px] text-warn/80">
                  Re-approve the frame to accept the change.
                </div>
              </div>
            ) : freshness.status === "fresh" ? (
              <div className="text-[12px] text-pass">
                Approved frame is current (fingerprint{" "}
                {shortFingerprint(ctx.approvedFrame?.approvedFingerprint)}).
              </div>
            ) : null}
            <div className="space-y-1.5">
              {ctx.frames.map((f) => (
                <ActionForm
                  key={f.id}
                  action={setFrameApproved}
                  className="flex items-center justify-between border border-line px-2.5 py-1.5"
                >
                  {hidden}
                  <input type="hidden" name="frameId" value={f.id} />
                  <input type="hidden" name="approved" value={String(!f.approved)} />
                  <span>
                    v{f.version} <span className="text-muted">· {f.source}</span>
                    {f.notes ? <span className="ml-2 text-faint">{f.notes}</span> : null}
                  </span>
                  <Button size="sm" variant={f.approved ? "primary" : "secondary"} type="submit">
                    {f.approved ? "Approved ✓" : "Approve"}
                  </Button>
                </ActionForm>
              ))}
              {ctx.frames.length === 0 ? <div className="text-fail">No storyboard frame yet.</div> : null}
            </div>
            <ActionForm
              action={addStoryboardFrame}
              resetOnSuccess
              className="grid grid-cols-3 items-end gap-2 border-t border-line pt-3"
            >
              {hidden}
              <Field label="Image">
                <input type="file" name="file" accept="image/*" className="!p-0.5" />
              </Field>
              <Field label="Source">
                <select name="source">
                  {FRAME_SOURCES.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <Field label="Notes">
                <input name="notes" />
              </Field>
              <div className="col-span-3">
                <Button size="sm" type="submit">
                  Add frame version
                </Button>
              </div>
            </ActionForm>
          </SectionChrome>

          {/* 16 Generation intent */}
          <SectionChrome {...sectionProps("generation")}>
            <SectionForm sectionKey="generation" shot={shot} data={data} />
          </SectionChrome>

          {/* 17 Preflight */}
          <SectionChrome {...sectionProps("preflight")}>
            <div>
              <div className="mb-2 flex items-center gap-3">
                <span
                  className={cn(
                    "text-[13px] font-semibold tracking-wide",
                    report.ready ? "text-pass" : "text-fail",
                  )}
                >
                  {report.ready ? "READY TO GENERATE" : "NOT READY TO GENERATE"}
                </span>
                <ScoreBar score={report.score} />
              </div>
              <PreflightList report={report} />
            </div>

            <div className="border-t border-line pt-3">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                Manual continuity review
              </h3>
              {checks[0] ? (
                <div className="mb-3 border border-line p-2.5 text-[12px]">
                  <div className="flex items-center gap-2">
                    <Badge tone={(checks[0].overallScore ?? 0) >= 85 ? "pass" : "warn"}>
                      score {checks[0].overallScore ?? "—"}
                    </Badge>
                    <span className="text-muted">
                      {checks[0].reviewer} · {checks[0].kind}
                    </span>
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-x-6 font-mono text-[11px] text-muted md:grid-cols-3">
                    {CONTINUITY_DIMENSIONS.map((d) => (
                      <div key={d}>
                        {d}: {checks[0].scores[d] ?? "—"}
                      </div>
                    ))}
                  </div>
                  {checks[0].issues.map((i, n) => (
                    <div key={n} className="mt-1 text-warn">
                      [{i.severity}] {i.dimension}: {i.description}
                    </div>
                  ))}
                </div>
              ) : null}
              <details>
                <summary className="text-[11px] text-accent">+ Record review ▾</summary>
                <ActionForm
                  action={saveContinuityCheck}
                  resetOnSuccess
                  className="mt-2 grid grid-cols-3 gap-2"
                >
                  {hidden}
                  {CONTINUITY_DIMENSIONS.map((d) => (
                    <Field label={d} key={d}>
                      <input name={`score:${d}`} type="number" min={0} max={100} placeholder="0–100" />
                    </Field>
                  ))}
                  <Field label="Reviewer">
                    <input name="reviewer" />
                  </Field>
                  <Field
                    label="Issues"
                    hint="dimension | minor/major/blocker | description"
                    className="col-span-3"
                  >
                    <textarea name="issues" rows={2} />
                  </Field>
                  <div className="col-span-3">
                    <Button size="sm" type="submit">
                      Save review
                    </Button>
                  </div>
                </ActionForm>
              </details>
              <p className="mt-2 text-[10.5px] text-faint">
                Automated visual QA arrives in Phase 3; checks of kind “automated” will appear here.
              </p>
            </div>
          </SectionChrome>

          {/* 18 Generation brief */}
          <SectionChrome {...sectionProps("brief")}>
            <div className="flex flex-wrap items-center gap-3 text-[12px]">
              <a
                className="rounded-[3px] border border-line2 px-2 py-1 text-accent hover:bg-panel2"
                href={`/api/projects/${slug}/shots/${shot.id}/package?format=brief`}
              >
                Download brief (.txt)
              </a>
              <a
                className="rounded-[3px] border border-line2 px-2 py-1 text-accent hover:bg-panel2"
                href={`/api/projects/${slug}/shots/${shot.id}/package?format=json`}
              >
                Download package (.json)
              </a>
              <span className="text-faint">
                package {shortFingerprint(pkg.provenance.fingerprint)} · schema v{pkg.packageSchemaVersion}
              </span>
            </div>
            <div className="space-y-2 border border-line bg-bg p-3" data-testid="generation-brief">
              {brief.map((s) => (
                <div key={s.title}>
                  <div className="text-[10.5px] font-semibold uppercase tracking-wide text-accent">
                    {s.title}
                  </div>
                  {s.lines.map((l, i) => (
                    <div key={i} className="whitespace-pre-wrap text-[12px] text-muted">
                      {l}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </SectionChrome>
        </div>

        {/* Right rail */}
        <aside className="space-y-3 xl:sticky xl:top-4 xl:self-start">
          <div className="border border-line bg-panel">
            {frameUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={frameUrl} alt={shot.title} className="aspect-[2.39/1] w-full object-cover" />
            ) : (
              <FramePlaceholder
                code={shot.shotCode}
                label={[shot.composition.shotSize, shot.composition.framing].filter(Boolean).join(" · ")}
                hint={frame ? `v${frame.version} ${frame.approved ? "approved" : "unapproved"}` : "no frame"}
              />
            )}
            {ctx.approvedFrame ? (
              <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[11px]">
                <span className="text-muted">Storyboard v{ctx.approvedFrame.version}</span>
                <Badge
                  tone={
                    freshness.status === "fresh" && !freshness.timingChange
                      ? "pass"
                      : freshness.status === "unknown"
                        ? "neutral"
                        : "warn"
                  }
                >
                  {freshness.status === "fresh" && !freshness.timingChange
                    ? "fresh"
                    : freshness.status === "unknown"
                      ? "untracked"
                      : "may be stale"}
                </Badge>
              </div>
            ) : null}
          </div>

          <div className="border border-line bg-panel">
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Timing</span>
              <span className="font-mono text-[11px]">{formatSeconds(timeline.totalMs)}</span>
            </div>
            <div className="p-3">
              <TimingList timeline={timeline} />
            </div>
          </div>

          <div className="border border-line bg-panel">
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Preflight</span>
              <ScoreBar score={report.score} />
            </div>
            <div className="p-3">
              <div
                className={cn(
                  "mb-2 text-[12px] font-semibold tracking-wide",
                  report.ready ? "text-pass" : "text-fail",
                )}
              >
                {report.ready ? "READY TO GENERATE" : "NOT READY TO GENERATE"}
              </div>
              <PreflightList report={report} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function TimingList({ timeline }: { timeline: ReturnType<typeof timelineFromContext> }) {
  if (timeline.segments.length === 0)
    return (
      <div className="text-[12px] text-warn">No duration set (manual target missing, no performance).</div>
    );
  return (
    <ol className="space-y-0.5 font-mono text-[11.5px]" data-testid="timing-list">
      {timeline.segments.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span className="w-[96px] shrink-0 text-muted">
            {(s.startMs / 1000).toFixed(2)}–{(s.endMs / 1000).toFixed(2)}
          </span>
          <span className="font-sans text-[12px]">{s.label}</span>
        </li>
      ))}
      <li className="flex gap-3 border-t border-line pt-0.5">
        <span className="w-[96px] shrink-0 text-muted">Total</span>
        <span>{(timeline.totalMs / 1000).toFixed(2)}s</span>
      </li>
    </ol>
  );
}

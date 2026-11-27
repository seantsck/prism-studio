import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { RefreshWhileActive } from "@/components/images/refresh-while-active";
import { Badge, Button, PageHeader, Panel } from "@/components/ui";
import type { ShotDirectionProposal } from "@/data/shot-direction-repository";
import {
  CAMERA_HEIGHTS,
  defaultDirectionReview,
  effectiveDirection,
  MOVEMENTS,
  SECTION_LABEL,
  shotSnapshot,
  type DirectionSection,
  type EditablePath,
  type ShotDirection,
} from "@/domain/story/shot-direction";
import { CAMERA_ANGLES, label, SHOT_SIZES } from "@/domain/story/shot-list";
import { requireProject } from "@/server/repo";
import { directShotWithPrism, submitDirectionReview } from "@/server/shot-direction-actions";
import { getShotDirectionRepo, getStoryRegistry, openStoryChangeFor } from "@/server/story";

/**
 * Phase 5B-S5: approved Shot → Direct with Prism → a reviewed Storyboard Direction. Nothing changes the Shot until
 * Apply Direction; applying writes into the Shot's existing fields, which the I6 Production Frame Inputs read.
 */
export const dynamic = "force-dynamic";

const SELECTS: Partial<Record<EditablePath, readonly string[]>> = {
  "framing.shotSize": SHOT_SIZES,
  "camera.height": CAMERA_HEIGHTS,
  "camera.angle": CAMERA_ANGLES,
  "camera.movement": MOVEMENTS,
};
const SECTION_FIELDS: Record<DirectionSection, Array<[EditablePath, string]>> = {
  camera: [
    ["framing.shotSize", "Shot size"],
    ["lens.focalRange", "Lens"],
    ["lens.intent", "Lens intent"],
    ["camera.height", "Height"],
    ["camera.angle", "Angle"],
    ["camera.position", "Position"],
    ["camera.perspective", "Perspective"],
    ["camera.movement", "Movement"],
  ],
  blocking: [],
  lighting: [
    ["lighting.key", "Key"],
    ["lighting.practicals", "Practicals"],
    ["lighting.contrast", "Contrast"],
    ["lighting.mood", "Mood"],
  ],
  composition: [
    ["framing.composition", "Composition"],
    ["framing.subjectPlacement", "Subject placement"],
    ["framing.headroom", "Headroom / negative space"],
    ["depth.foreground", "Foreground"],
    ["depth.midground", "Midground"],
    ["depth.background", "Background"],
    ["emotionalIntent", "Emotional intent"],
  ],
  continuity: [
    ["continuity.screenDirection", "Screen direction"],
    ["continuity.eyelines", "Eyelines"],
  ],
  storyboard: [["storyboardDescription", "Storyboard description"]],
};
const value = (d: ShotDirection, path: EditablePath) => {
  const [a, b] = path.split(".") as [keyof ShotDirection, string?];
  return String(b ? (d[a] as Record<string, unknown>)[b] : d[a]);
};

export default async function DirectShotPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string; ep: string; shotId: string }>;
  searchParams: Promise<{ proposal?: string; compare?: string }>;
}) {
  const { project: slug, ep, shotId } = await params;
  const q = await searchParams;
  const data = await requireProject(slug);
  const episode = data.episodes.find((e) => e.slug === ep);
  const shot = data.shots.find((s) => s.id === shotId && s.episodeId === episode?.id);
  if (!episode || !shot) notFound();
  const pid = data.project.id;
  const snap = shotSnapshot(data, shot.id);
  const repo = await getShotDirectionRepo();
  const versions = await repo.listForShot(pid, shot.id);
  const record = (q.proposal ? versions.find((v) => v.id === q.proposal) : versions[0]) ?? null;
  const compare = q.compare ? (versions.find((v) => v.id === q.compare) ?? null) : null;
  const review = record?.review ?? defaultDirectionReview();
  const d = record?.direction ? effectiveDirection(record.direction, review) : null;
  const stale = (v: ShotDirectionProposal) =>
    !snap || v.sceneFingerprint !== snap.sceneFingerprint || v.shotFingerprint !== snap.shotFingerprint;
  const applied = versions.find((v) => v.status === "applied") ?? null;
  const appliedAfter = applied?.appliedSummary?.shotFingerprintAfter as string | undefined;
  const needsReview =
    applied != null &&
    (!snap ||
      appliedAfter !== snap.shotFingerprint ||
      applied.sceneFingerprint !== snap.sceneFingerprint ||
      (await openStoryChangeFor(pid, shot.sceneId)));
  const models = getStoryRegistry().models();
  const first = models.find((m) => m.available);
  const paidOffered = models.some((m) => m.paid && m.available);
  const active = versions.some((v) => v.status === "queued" || v.status === "running");
  const ctx = record?.context ?? snap?.context ?? null;
  const nameOf = (k: string) => ctx?.characters.find((c) => c.key === k)?.name ?? k;
  const editable = record?.status === "ready" && !stale(record);
  const shotUrl = `/projects/${slug}/episodes/${ep}/shots/${shot.id}`;

  const field = (path: EditablePath, title: string) => {
    if (!d) return null;
    const v = value(d, path);
    const opts = SELECTS[path];
    return (
      <label key={path} className="flex flex-col gap-0.5 text-[12px]">
        <span className="text-muted">{title}</span>
        {!editable ? (
          <span data-testid={`dir-${path}`}>{opts ? label(v) : v}</span>
        ) : opts ? (
          <select name={`edit:${path}`} defaultValue={v} data-testid={`dir-${path}`}>
            {opts.map((o) => (
              <option key={o} value={o}>
                {label(o)}
              </option>
            ))}
          </select>
        ) : path === "storyboardDescription" || path === "emotionalIntent" ? (
          <textarea name={`edit:${path}`} defaultValue={v} rows={3} data-testid={`dir-${path}`} />
        ) : (
          <input name={`edit:${path}`} defaultValue={v} data-testid={`dir-${path}`} />
        )}
      </label>
    );
  };

  return (
    <div>
      <RefreshWhileActive active={active} intervalMs={1000} />
      <PageHeader
        title={`Direct with Prism — ${shot.shotCode} ${shot.title}`}
        subtitle="Prism proposes how this Shot plays. Nothing changes the Shot until you Apply Direction."
        actions={
          <Link className="text-[12px] text-accent" href={shotUrl}>
            ← Shot {shot.shotCode}
          </Link>
        }
      />
      <div className="grid gap-4 p-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="min-w-0 space-y-4">
          {needsReview ? (
            <div
              className="rounded-[3px] border border-warn/40 bg-warn/5 px-3 py-2 text-[12px] text-warn"
              data-testid="dir-needs-review"
            >
              Direction needs review: the Shot or its screenplay changed after direction v{applied!.version}{" "}
              was applied. Nothing was re-run; Direct with Prism again when you are ready.
            </div>
          ) : null}
          <Panel title="Direct with Prism">
            <ActionForm action={directShotWithPrism} className="space-y-2" quiet>
              <input type="hidden" name="projectSlug" value={slug} />
              <input type="hidden" name="shotId" value={shot.id} />
              <input
                name="instruction"
                aria-label="Direction note"
                placeholder="Optional: more intimate, make Yumeko feel isolated…"
                className="w-full"
              />
              <Button type="submit" variant="primary" data-testid="dir-direct">
                Direct with Prism
              </Button>
              <details className="text-[12px]">
                <summary className="cursor-pointer text-muted">Advanced</summary>
                <div className="mt-2 space-y-2">
                  <label className="flex items-center gap-2">
                    Model
                    <select name="model" defaultValue={first ? `${first.provider}/${first.modelId}` : ""}>
                      {models.map((m) => (
                        <option
                          key={`${m.provider}/${m.modelId}`}
                          value={`${m.provider}/${m.modelId}`}
                          disabled={!m.available}
                        >
                          {m.label} — {m.provider}/{m.modelId}
                          {m.available ? "" : ` (${m.reason})`}
                        </option>
                      ))}
                    </select>
                  </label>
                  {paidOffered ? (
                    <label className="flex items-center gap-2">
                      Confirm total ($)
                      <input
                        name="confirmedTotalUsd"
                        inputMode="decimal"
                        className="w-28"
                        placeholder="0.0000"
                      />
                    </label>
                  ) : null}
                </div>
              </details>
            </ActionForm>
          </Panel>

          <Panel title="What Prism reads (text only)">
            <dl className="space-y-1 text-[12px]" data-testid="dir-context">
              <div>
                <dt className="inline text-muted">Shot: </dt>
                <dd className="inline">
                  {shot.shotCode} — {shot.title} · {shot.storyBeat}
                </dd>
              </div>
              <div>
                <dt className="inline text-muted">Characters: </dt>
                <dd className="inline">
                  {(snap?.context.characters ?? [])
                    .map((c) => `${c.name}${c.look ? ` (${c.look})` : ""}`)
                    .join(", ") || "none"}
                </dd>
              </div>
              <div>
                <dt className="inline text-muted">Location: </dt>
                <dd className="inline">{snap?.context.location?.name ?? "none"}</dd>
              </div>
              <div data-testid="dir-context-view">
                <dt className="inline text-muted">Location View: </dt>
                <dd className="inline">
                  {snap?.context.locationView
                    ? `${snap.context.locationView.name} (a hard constraint)`
                    : "none selected"}
                </dd>
              </div>
              <div data-testid="dir-context-adjacent">
                <dt className="inline text-muted">Adjacent Shots: </dt>
                <dd className="inline">
                  {(snap?.context.adjacent ?? []).map((a) => `${a.code} ${a.title}`).join(" · ") || "none"}
                </dd>
              </div>
              <div>
                <dt className="inline text-muted">Established sides: </dt>
                <dd className="inline">
                  {Object.entries(snap?.context.established ?? {})
                    .map(([n, s]) => `${n} screen-${s}`)
                    .join(", ") || "none yet"}
                </dd>
              </div>
            </dl>
          </Panel>

          <Panel title="Versions">
            {versions.length === 0 ? (
              <p className="text-[12px] text-muted">No direction yet.</p>
            ) : (
              <ul className="space-y-1 text-[12px]" data-testid="dir-versions">
                {versions.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center gap-2">
                    <Link
                      className={v.id === record?.id ? "text-accent" : "text-muted"}
                      href={`?proposal=${v.id}`}
                    >
                      v{v.version}
                    </Link>
                    <Badge
                      tone={v.status === "applied" ? "pass" : v.status === "failed" ? "fail" : "neutral"}
                    >
                      {v.status}
                    </Badge>
                    {v.instruction ? <span className="text-muted">“{v.instruction}”</span> : null}
                    {v.review?.rejected ? <Badge tone="fail">rejected</Badge> : null}
                    {v.review?.savedAlternate ? <Badge tone="info">alternate</Badge> : null}
                    {v.status !== "applied" && stale(v) ? <Badge tone="warn">stale</Badge> : null}
                    {record && v.id !== record.id && v.direction ? (
                      <Link className="text-accent" href={`?proposal=${record.id}&compare=${v.id}`}>
                        compare
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="min-w-0 space-y-4">
          {!record ? (
            <Panel title="Storyboard Direction">
              <p className="text-[12px] text-muted">Direct with Prism to see a proposal for this Shot.</p>
            </Panel>
          ) : (
            <Panel title={`Storyboard Direction v${record.version}`}>
              <div
                className="mb-2 flex flex-wrap items-center gap-2 text-[12px]"
                data-testid="dir-status"
                data-status={record.status}
              >
                <Badge
                  tone={record.status === "applied" ? "pass" : record.status === "failed" ? "fail" : "info"}
                >
                  {record.status}
                </Badge>
                {record.status === "queued" || record.status === "running" ? (
                  <span className="text-muted">Prism is directing…</span>
                ) : null}
                {record.error ? <span className="text-fail">{record.error.message}</span> : null}
                {record.status === "ready" && stale(record) ? (
                  <Badge tone="warn">
                    The Shot or screenplay changed — this direction can no longer be applied
                  </Badge>
                ) : null}
                {d ? <span className="text-muted">{d.summary}</span> : null}
              </div>
              {compare?.direction && d ? (
                <div
                  className="mb-3 overflow-auto rounded-[3px] border border-line p-2 text-[11.5px]"
                  data-testid="dir-compare"
                >
                  <div className="mb-1 font-medium">
                    v{record.version} vs v{compare.version}
                  </div>
                  <table className="w-full">
                    <tbody>
                      {(
                        [
                          "framing.shotSize",
                          "lens.focalRange",
                          "camera.angle",
                          "camera.movement",
                          "framing.composition",
                          "lighting.mood",
                          "storyboardDescription",
                        ] as EditablePath[]
                      ).map((p) => (
                        <tr key={p} className="align-top">
                          <td className="pr-2 text-muted">{p}</td>
                          <td className="pr-2">{value(d, p)}</td>
                          <td
                            className={
                              value(d, p) === value(compare.direction!, p) ? "text-muted" : "text-warn"
                            }
                          >
                            {value(compare.direction!, p)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {record.status === "applied" ? (
                <p className="mb-2 text-[12px] text-pass" data-testid="dir-applied">
                  Applied to {shot.shotCode} (
                  {((record.appliedSummary?.sections as string[]) ?? []).join(", ")}).{" "}
                  <Link className="text-accent" href={`${shotUrl}?section=production_frame`}>
                    Production Frame Inputs →
                  </Link>
                </p>
              ) : null}
              {d ? (
                <ActionForm action={submitDirectionReview} className="space-y-3">
                  <input type="hidden" name="projectSlug" value={slug} />
                  <input type="hidden" name="proposalId" value={record.id} />
                  <input type="hidden" name="reviewPresent" value="1" />
                  {(Object.keys(SECTION_FIELDS) as DirectionSection[]).map((s) => (
                    <section
                      key={s}
                      className="rounded-[3px] border border-line p-2"
                      data-testid={`dir-section-${s}`}
                    >
                      <div className="mb-1.5 flex items-center justify-between">
                        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">
                          {SECTION_LABEL[s]}
                        </h3>
                        {editable ? (
                          <label className="flex items-center gap-1 text-[12px]">
                            <input
                              type="checkbox"
                              name={`section:${s}`}
                              defaultChecked={review.sections[s]}
                              aria-label={`Accept ${SECTION_LABEL[s]}`}
                            />{" "}
                            Accept
                          </label>
                        ) : (
                          <Badge tone={review.sections[s] ? "pass" : "neutral"}>
                            {review.sections[s] ? "accepted" : "not applied"}
                          </Badge>
                        )}
                      </div>
                      {s === "blocking" ? (
                        <ul className="space-y-1.5 text-[12px]">
                          {d.blocking.map((b) => (
                            <li key={b.characterKey} data-testid="dir-blocking">
                              <div className="font-medium">
                                {nameOf(b.characterKey)} — screen {b.screenSide}, {b.depth}
                              </div>
                              {editable ? (
                                <div className="grid gap-1 md:grid-cols-3">
                                  {(["position", "facing", "eyeline"] as const).map((f) => (
                                    <input
                                      key={f}
                                      name={`block:${b.characterKey}:${f}`}
                                      defaultValue={b[f]}
                                      aria-label={`${nameOf(b.characterKey)} ${f}`}
                                    />
                                  ))}
                                </div>
                              ) : (
                                <div className="text-muted">
                                  {b.position} · {b.facing} · {b.eyeline}
                                </div>
                              )}
                              <div className="text-muted">{b.relation}</div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="grid gap-1.5 md:grid-cols-2">
                          {SECTION_FIELDS[s].map(([p, t]) => field(p, t))}
                        </div>
                      )}
                      {s === "camera" ? (
                        <p className="mt-1 text-[11.5px] text-muted">
                          {d.lens.rationale} {d.camera.movementRationale}
                          {d.locationView.usesSelectedView && ctx?.locationView
                            ? ` Uses the selected "${ctx.locationView.name}" view.`
                            : ""}
                          {d.locationView.conflict ? (
                            <span className="text-warn"> View conflict: {d.locationView.conflict}</span>
                          ) : null}
                          {d.locationView.suggestedNewView ? (
                            <span data-testid="dir-suggested-view">
                              {" "}
                              {d.locationView.suggestedNewView} (not created).
                            </span>
                          ) : null}
                        </p>
                      ) : null}
                      {s === "lighting" ? (
                        <p className="mt-1 text-[11.5px] text-muted">
                          {d.lighting.timeOfDay} · {d.lighting.motivatedSources}
                        </p>
                      ) : null}
                      {s === "continuity" ? (
                        <ul className="mt-1 list-disc pl-4 text-[11.5px] text-muted">
                          {d.continuity.constraints.map((c) => (
                            <li key={c}>{c}</li>
                          ))}
                          {d.continuity.breaksPattern ? (
                            <li className="text-warn">
                              Breaks the pattern: {d.continuity.breakJustification}
                            </li>
                          ) : null}
                        </ul>
                      ) : null}
                    </section>
                  ))}
                  {editable ? (
                    <div className="flex flex-wrap gap-1.5 border-t border-line pt-2">
                      <Button
                        type="submit"
                        name="intent"
                        value="apply"
                        variant="primary"
                        data-testid="dir-apply"
                        disabled={review.rejected}
                      >
                        Apply Direction
                      </Button>
                      <Button type="submit" name="intent" value="save" size="sm">
                        Save review
                      </Button>
                      <Button
                        type="submit"
                        name="intent"
                        value={review.rejected ? "unreject" : "reject"}
                        size="sm"
                        variant={review.rejected ? "secondary" : "danger"}
                      >
                        {review.rejected ? "Un-reject" : "Reject"}
                      </Button>
                      <Button type="submit" name="intent" value="save_alternate" size="sm">
                        Save as alternate
                      </Button>
                      <Button type="submit" name="intent" value="regenerate" size="sm">
                        Regenerate
                      </Button>
                      <span className="flex gap-1">
                        <input
                          name="variantNote"
                          aria-label="Another approach"
                          placeholder="Another approach: more intimate…"
                          className="w-56"
                        />
                        <Button type="submit" name="intent" value="variant" size="sm">
                          Ask for another approach
                        </Button>
                      </span>
                    </div>
                  ) : null}
                </ActionForm>
              ) : null}
              <details className="mt-2 text-[11px] text-faint">
                <summary className="cursor-pointer">Advanced</summary>
                <div className="mt-1 space-y-0.5 font-mono">
                  <div>
                    {record.provider}/{record.model} · prompt {record.promptVersion} · {record.schemaVersion}{" "}
                    · v{record.version}
                  </div>
                  <div>
                    estimate ${record.estimate.usd.toFixed(4)} · spend {record.spendAuthorization}
                    {record.actualUsd != null ? ` · actual $${record.actualUsd.toFixed(6)}` : ""} · calls{" "}
                    {record.providerCalls}
                  </div>
                  <div>
                    scene {record.sceneFingerprint.slice(0, 12)}… · shot {record.shotFingerprint.slice(0, 12)}
                    …
                  </div>
                </div>
              </details>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

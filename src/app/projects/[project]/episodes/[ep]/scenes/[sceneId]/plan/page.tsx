import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { RefreshWhileActive } from "@/components/images/refresh-while-active";
import { Badge, Button, PageHeader, Panel } from "@/components/ui";
import { CAMERA_ANGLES, COVERAGE_LABEL, label, sceneSnapshot, SHOT_SIZES } from "@/domain/story/shot-list";
import {
  effectiveShot,
  isIncluded,
  possibleMatches,
  previewCodes,
  reviewOfShotList,
} from "@/domain/story/shot-list-review";
import { requireProject } from "@/server/repo";
import { planShotsWithPrism, submitShotListReview } from "@/server/shot-list-actions";
import { getShotListRepo, getStoryRegistry, openStoryChangeFor } from "@/server/story";

/**
 * Phase 5B-S4: Scene → Plan Shots with Prism → a reviewed Shot List. Nothing becomes project state until Apply.
 */
export const dynamic = "force-dynamic";

export default async function ScenePlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string; ep: string; sceneId: string }>;
  searchParams: Promise<{ proposal?: string }>;
}) {
  const { project: slug, ep, sceneId } = await params;
  const q = await searchParams;
  const data = await requireProject(slug);
  const episode = data.episodes.find((e) => e.slug === ep);
  const scene = data.scenes.find((s) => s.id === sceneId && s.episodeId === episode?.id);
  if (!episode || !scene) notFound();
  const pid = data.project.id;
  const snap = sceneSnapshot(data, episode, scene);
  const repo = await getShotListRepo();
  const versions = await repo.listForScene(pid, scene.id);
  const record = (q.proposal ? versions.find((v) => v.id === q.proposal) : versions[0]) ?? null;
  const parent = record?.parentId ? (versions.find((v) => v.id === record.parentId) ?? null) : null;
  const review = record ? reviewOfShotList(record, parent) : null;
  const existing = data.shots.filter((s) => s.sceneId === scene.id).sort((a, b) => a.order - b.order);
  const storyChanged = await openStoryChangeFor(pid, scene.id);
  const stale = (v: { sceneFingerprint: string }) => !snap || v.sceneFingerprint !== snap.sceneFingerprint;
  const lastApplied = versions.find((v) => v.status === "applied") ?? null;
  const needsReplan = storyChanged || (lastApplied != null && stale(lastApplied));
  const models = getStoryRegistry().models();
  const first = models.find((m) => m.available);
  const paidOffered = models.some((m) => m.paid && m.available);
  const active = versions.some((v) => v.status === "queued" || v.status === "running");
  const ctx = record?.context ?? snap?.context ?? null;
  const codes = record && review ? previewCodes(review, scene, existing) : new Map<string, string>();
  const nameOf = (k: string) => ctx?.characters.find((c) => c.key === k)?.name ?? k;
  const lineOf = (k: string) => ctx?.dialogue.find((d) => d.key === k);
  /** A recorded source range shown against the CURRENT screenplay (the Scene may have moved). */
  const shift = record && snap ? snap.context.scene.startLine - record.context.scene.startLine : 0;
  const excerpt = (a: number, b: number) =>
    (record?.sceneText ?? "")
      .split("\n")
      .slice(a - (record?.context.scene.startLine ?? 1), b - (record?.context.scene.startLine ?? 1) + 1)
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 200);

  return (
    <div>
      <RefreshWhileActive active={active} intervalMs={1000} />
      <PageHeader
        title={`Shot plan — Scene ${scene.sceneNumber}`}
        subtitle={`${scene.slugline} · Prism proposes a camera plan from the accepted screenplay; nothing changes until you Apply.`}
        actions={
          <Link className="text-[12px] text-accent" href={`/projects/${slug}/episodes/${ep}/scenes`}>
            ← Scenes
          </Link>
        }
      />
      <div className="grid gap-4 p-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="min-w-0 space-y-4">
          {needsReplan ? (
            <div
              className="rounded-[3px] border border-warn/40 bg-warn/5 px-3 py-2 text-[12px] text-warn"
              data-testid="plan-story-changed"
            >
              Story changed after production breakdown. The existing Shots and any applied plan were kept as
              they are — Re-plan Shots to review a plan for the current screenplay.
            </div>
          ) : null}
          <Panel title="Plan Shots">
            <ActionForm action={planShotsWithPrism} className="space-y-2" quiet>
              <input type="hidden" name="projectSlug" value={slug} />
              <input type="hidden" name="sceneId" value={scene.id} />
              <Button type="submit" variant="primary" data-testid="plan-shots">
                {needsReplan || versions.length ? "Re-plan Shots" : "Plan Shots with Prism"}
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

          <Panel
            title={`Screenplay — lines ${snap?.context.scene.startLine ?? "?"}–${snap?.context.scene.endLine ?? "?"}`}
          >
            <pre
              className="max-h-[360px] overflow-auto whitespace-pre-wrap font-mono text-[12px]"
              data-testid="plan-scene-text"
            >
              {snap?.sceneText ?? "This Scene's heading is not in the screenplay."}
            </pre>
          </Panel>

          <Panel title={`Existing Shots — ${existing.length}`}>
            {existing.length === 0 ? (
              <p className="text-[12px] text-muted">None yet.</p>
            ) : (
              <ul className="space-y-1 text-[12px]" data-testid="plan-existing-shots">
                {existing.map((s) => (
                  <li key={s.id}>
                    <Link className="text-accent" href={`/projects/${slug}/episodes/${ep}/shots/${s.id}`}>
                      <span className="font-mono">{s.shotCode}</span> — {s.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Versions">
            {versions.length === 0 ? (
              <p className="text-[12px] text-muted">No shot list yet.</p>
            ) : (
              <ul className="space-y-1 text-[12px]" data-testid="plan-versions">
                {versions.map((v) => (
                  <li key={v.id} className="flex items-center gap-2">
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
                    {v.scope.kind === "shot" ? <Badge>one Shot regenerated</Badge> : null}
                    {stale(v) ? <Badge tone="warn">story changed</Badge> : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="min-w-0 space-y-4">
          {!record ? (
            <Panel title="Shot list">
              <p className="text-[12px] text-muted">
                Plan Shots with Prism to see a proposed shot list for this Scene.
              </p>
            </Panel>
          ) : (
            <Panel title={`Shot list v${record.version}`}>
              <div
                data-testid="plan-status"
                data-status={record.status}
                className="mb-2 flex flex-wrap items-center gap-2 text-[12px]"
              >
                <Badge
                  tone={record.status === "applied" ? "pass" : record.status === "failed" ? "fail" : "info"}
                >
                  {record.status}
                </Badge>
                {record.status === "queued" || record.status === "running" ? (
                  <span className="text-muted">Prism is planning…</span>
                ) : null}
                {record.error ? <span className="text-fail">{record.error.message}</span> : null}
                {stale(record) ? (
                  <Badge tone="warn">
                    The Scene&apos;s screenplay changed after this plan — it can no longer be applied
                  </Badge>
                ) : null}
                {record.plan ? <span className="text-muted">{record.plan.summary}</span> : null}
              </div>
              {record.status === "applied" && record.appliedSummary ? (
                <p className="mb-2 text-[12px] text-pass" data-testid="plan-applied">
                  Applied: {String(record.appliedSummary.created)} created,{" "}
                  {String(record.appliedSummary.replaced)} replaced in place (
                  {((record.appliedSummary.codes as string[]) ?? []).join(", ")}).
                </p>
              ) : null}
              {record.plan && review ? (
                <ActionForm action={submitShotListReview} className="space-y-2">
                  <input type="hidden" name="projectSlug" value={slug} />
                  <input type="hidden" name="proposalId" value={record.id} />
                  <input type="hidden" name="reviewPresent" value="1" />
                  <ol className="space-y-2" data-testid="plan-shots-list">
                    {review.items.map((it, idx) => {
                      const s = effectiveShot(record.plan!, it);
                      const included = isIncluded(it);
                      const matches = possibleMatches(record.plan!, it, idx, existing, record.context);
                      const editable = record.status === "ready";
                      return (
                        <li
                          key={it.id}
                          data-testid="plan-shot"
                          data-item={it.id}
                          className={`rounded-[3px] border p-2 text-[12px] ${included ? "border-line2" : "border-line opacity-60"}`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium" data-testid="plan-shot-title">
                              <span className="font-mono">{included ? (codes.get(it.id) ?? "—") : "—"}</span>{" "}
                              — {s.title}
                            </span>
                            <span className="flex flex-wrap gap-1">
                              <Badge>{COVERAGE_LABEL[s.coverage]}</Badge>
                              <Badge>{label(s.shotSize)}</Badge>
                              <Badge>{label(s.cameraAngle)}</Badge>
                              {it.variant ? <Badge tone="info">{it.variant}</Badge> : null}
                              {s.confidence !== "high" ? (
                                <Badge tone="warn">{s.confidence} confidence</Badge>
                              ) : null}
                            </span>
                          </div>
                          <div className="mt-1 text-muted">
                            {s.characterKeys.map(nameOf).join(", ") || "no Characters"} ·{" "}
                            {ctx?.locations.find((l) => l.key === s.locationKey)?.name ?? "no Location"}
                          </div>
                          <div className="mt-1">
                            <span className="text-muted">Why:</span> {s.purpose}
                          </div>
                          <div>
                            <span className="text-muted">Beat:</span> {s.beat}
                          </div>
                          {s.dialogueKeys.length ? (
                            <div data-testid="plan-shot-dialogue">
                              <span className="text-muted">Dialogue:</span>{" "}
                              {s.dialogueKeys
                                .map((k) => lineOf(k))
                                .filter(Boolean)
                                .map((d) => `${d!.speaker}: ${d!.text}`)
                                .join(" / ")}
                            </div>
                          ) : null}
                          <div className="text-muted" data-testid="plan-shot-source">
                            Source: lines{" "}
                            {s.sources.map((r) => `${r.startLine + shift}–${r.endLine + shift}`).join(", ")} —{" "}
                            <em>{excerpt(s.sources[0]!.startLine, s.sources[0]!.endLine)}</em>
                          </div>
                          {s.ambiguity ? <div className="text-warn">{s.ambiguity}</div> : null}
                          {matches.length ? (
                            <div className="text-info" data-testid="plan-shot-match">
                              Possible match: existing{" "}
                              {matches.map((m) => `${m.shotCode} (${m.title})`).join(", ")}
                            </div>
                          ) : null}
                          {editable ? (
                            <>
                              <div className="mt-1.5 flex flex-wrap items-center gap-3">
                                <label className="flex items-center gap-1">
                                  <input
                                    type="checkbox"
                                    name={`include:${it.id}`}
                                    defaultChecked={it.selected}
                                    aria-label={`Include ${s.title}`}
                                  />{" "}
                                  Include
                                </label>
                                <label className="flex items-center gap-1">
                                  <input
                                    type="checkbox"
                                    name={`reject:${it.id}`}
                                    defaultChecked={it.rejected}
                                    aria-label={`Reject ${s.title}`}
                                  />{" "}
                                  Reject
                                </label>
                                {existing.length ? (
                                  <label className="flex items-center gap-1">
                                    Apply as
                                    <select
                                      name={`decision:${it.id}`}
                                      aria-label={`Apply ${s.title} as`}
                                      defaultValue={
                                        it.decision.kind === "replace" ? it.decision.shotId : "create"
                                      }
                                    >
                                      <option value="create">a new Shot</option>
                                      {existing.map((e) => (
                                        <option key={e.id} value={e.id}>
                                          Replace {e.shotCode} (keeps its id and history)
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                ) : null}
                                <span className="flex gap-1">
                                  <Button
                                    type="submit"
                                    name="intent"
                                    value={`up:${it.id}`}
                                    size="sm"
                                    aria-label={`Move ${s.title} up`}
                                  >
                                    ↑
                                  </Button>
                                  <Button
                                    type="submit"
                                    name="intent"
                                    value={`down:${it.id}`}
                                    size="sm"
                                    aria-label={`Move ${s.title} down`}
                                  >
                                    ↓
                                  </Button>
                                  <Button type="submit" name="intent" value={`split:${it.id}`} size="sm">
                                    Split
                                  </Button>
                                  <Button type="submit" name="intent" value={`duplicate:${it.id}`} size="sm">
                                    Duplicate
                                  </Button>
                                </span>
                              </div>
                              <details className="mt-1">
                                <summary className="cursor-pointer text-muted">Edit</summary>
                                <div className="mt-1 grid gap-1.5 md:grid-cols-2">
                                  {(
                                    [
                                      "title",
                                      "purpose",
                                      "beat",
                                      "framing",
                                      "emotionalIntention",
                                      "continuityNotes",
                                    ] as const
                                  ).map((f) => (
                                    <label key={f} className="flex flex-col gap-0.5">
                                      <span className="text-muted">
                                        {label(f.replace(/([A-Z])/g, "_$1").toLowerCase())}
                                      </span>
                                      <input
                                        name={`edit:${it.id}:${f}`}
                                        defaultValue={String(s[f])}
                                        data-testid={`plan-edit-${f}`}
                                      />
                                    </label>
                                  ))}
                                  <label className="flex flex-col gap-0.5">
                                    <span className="text-muted">shot size</span>
                                    <select name={`edit:${it.id}:shotSize`} defaultValue={s.shotSize}>
                                      {SHOT_SIZES.map((v) => (
                                        <option key={v} value={v}>
                                          {label(v)}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                  <label className="flex flex-col gap-0.5">
                                    <span className="text-muted">camera angle</span>
                                    <select name={`edit:${it.id}:cameraAngle`} defaultValue={s.cameraAngle}>
                                      {CAMERA_ANGLES.map((v) => (
                                        <option key={v} value={v}>
                                          {label(v)}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                </div>
                                <div className="mt-1.5 flex gap-1.5">
                                  <input
                                    name={`regenNote:${it.id}`}
                                    placeholder="Note for Prism (optional)"
                                    className="min-w-0 flex-1"
                                  />
                                  <Button type="submit" name="intent" value={`regen:${it.id}`} size="sm">
                                    Regenerate this Shot
                                  </Button>
                                </div>
                              </details>
                            </>
                          ) : null}
                        </li>
                      );
                    })}
                  </ol>
                  {record.status === "ready" ? (
                    <div className="space-y-2 border-t border-line pt-2 text-[12px]">
                      {existing.length ? (
                        <label className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            name="confirmReplace"
                            defaultChecked={review.confirmReplace}
                          />
                          I approve replacing the existing Shots chosen above (their planning fields are
                          overwritten; their ids, generations and frames are kept; nothing is deleted).
                        </label>
                      ) : null}
                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          type="submit"
                          name="intent"
                          value="apply"
                          variant="primary"
                          data-testid="plan-apply"
                          disabled={stale(record)}
                        >
                          Apply selected
                        </Button>
                        <Button type="submit" name="intent" value="save" size="sm">
                          Save review
                        </Button>
                        <Button type="submit" name="intent" value="select_all" size="sm">
                          Select all
                        </Button>
                        <Button type="submit" name="intent" value="select_none" size="sm">
                          Deselect all
                        </Button>
                        <Button type="submit" name="intent" value="regenerate_all" size="sm">
                          Regenerate whole list
                        </Button>
                      </div>
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
                    scene {record.sceneFingerprint.slice(0, 12)}… · episode{" "}
                    {record.episodeFingerprint.slice(0, 12)}… · revision{" "}
                    {record.baseRevisionId ? record.baseRevisionId.slice(0, 8) : "(no history yet)"}
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

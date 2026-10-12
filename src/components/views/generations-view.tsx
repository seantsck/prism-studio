import Link from "next/link";
import { ReadinessBadge } from "@/components/shared";
import { Badge, Button, Field, PageHeader } from "@/components/ui";
import { ATTEMPT_STATUSES, type Episode, type ProjectData } from "@/domain/schemas";
import { assembleGenerationPackage, renderGenerationBrief } from "@/domain/generation-package";
import { summarizeEpisode } from "@/domain/summary";
import { shotPath } from "@/lib/paths";
import { logAttempt, reviewAttempt } from "@/server/actions";
import { ActionForm } from "@/components/action-form";

const ATTEMPT_TONE = {
  approved: "pass",
  rejected: "fail",
  failed: "fail",
  succeeded: "info",
  running: "accent",
  queued: "neutral",
} as const;

export function GenerationsView({ data, episode }: { data: ProjectData; episode: Episode }) {
  const summaries = summarizeEpisode(data, episode);
  const slug = data.project.slug;
  const hidden = <input type="hidden" name="projectSlug" value={slug} />;
  const totalCost = data.attempts.reduce((s, a) => s + (a.costUsd ?? 0), 0);

  return (
    <div>
      <PageHeader
        title={`Generations — ${episode.title}`}
        subtitle="Generation package, brief and append-only attempt history per shot. No provider is connected yet."
        actions={
          <>
            <Badge>{data.attempts.length} attempts</Badge>
            <Badge>${totalCost.toFixed(2)} logged</Badge>
          </>
        }
      />
      <div className="space-y-3 p-6">
        {summaries.map(({ ctx, report }) => {
          const attempts = data.attempts
            .filter((a) => a.shotId === ctx.shot.id)
            .sort((a, b) => a.attemptNumber - b.attemptNumber);
          const pkg = assembleGenerationPackage(ctx);
          const brief = renderGenerationBrief(pkg);
          return (
            <details key={ctx.shot.id} className="border border-line bg-panel" open={attempts.length > 0}>
              <summary className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="flex items-baseline gap-3">
                  <span className="font-mono text-accent">{ctx.shot.shotCode}</span>
                  <span className="font-medium">{ctx.shot.title}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <Badge>{attempts.length} attempts</Badge>
                  {attempts.some((a) => a.approved) ? <Badge tone="pass">approved take</Badge> : null}
                  <ReadinessBadge report={report} />
                </span>
              </summary>
              <div className="grid gap-4 border-t border-line p-4 xl:grid-cols-2">
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                      Generation brief
                    </h3>
                    <Link
                      className="text-[11px] text-accent hover:underline"
                      href={shotPath(slug, episode.slug, ctx.shot.id, "preflight")}
                    >
                      Open shot prep →
                    </Link>
                  </div>
                  <div className="space-y-2.5 border border-line bg-bg p-3">
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
                  <details className="mt-2">
                    <summary className="text-[11px] text-muted hover:text-fg">Raw package JSON ▾</summary>
                    <pre className="scroll-thin mt-1 max-h-72 overflow-auto border border-line bg-bg p-2 font-mono text-[10.5px] text-muted">
                      {JSON.stringify(pkg, null, 2)}
                    </pre>
                  </details>
                </div>

                <div>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                    Attempt history
                  </h3>
                  <div className="space-y-2">
                    {attempts.map((a) => (
                      <ActionForm key={a.id} action={reviewAttempt} className="border border-line p-2.5">
                        {hidden}
                        <input type="hidden" name="attemptId" value={a.id} />
                        <div className="flex items-center justify-between">
                          <span className="font-medium">
                            Take {a.attemptNumber}
                            <span className="ml-2 text-muted">
                              {a.provider} / {a.model}
                            </span>
                          </span>
                          <Badge tone={ATTEMPT_TONE[a.status]}>{a.status}</Badge>
                        </div>
                        {a.rejectionReason ? <div className="mt-1 text-fail">{a.rejectionReason}</div> : null}
                        <details className="mt-1.5">
                          <summary className="text-[11px] text-muted hover:text-fg">Review ▾</summary>
                          <div className="mt-1.5 grid grid-cols-2 gap-2">
                            <Field label="Status">
                              <select name="status" defaultValue={a.status}>
                                {ATTEMPT_STATUSES.map((s) => (
                                  <option key={s}>{s}</option>
                                ))}
                              </select>
                            </Field>
                            <Field label="Rejection reason">
                              <input name="rejectionReason" defaultValue={a.rejectionReason} />
                            </Field>
                            <Field label="Notes" className="col-span-2">
                              <input name="notes" defaultValue={a.notes} />
                            </Field>
                            <div className="col-span-2 text-[10.5px] text-faint">
                              Prompt, package snapshot and settings are immutable.
                            </div>
                            <Button size="sm" type="submit">
                              Save review
                            </Button>
                          </div>
                        </details>
                      </ActionForm>
                    ))}
                    {attempts.length === 0 ? (
                      <div className="border border-dashed border-line2 p-3 text-muted">
                        No attempts logged.
                      </div>
                    ) : null}
                  </div>

                  <details className="mt-3">
                    <summary className="text-[11px] font-semibold uppercase tracking-wide text-accent">
                      + Log attempt ▾
                    </summary>
                    <ActionForm action={logAttempt} className="mt-2 grid grid-cols-2 gap-2">
                      {hidden}
                      <input type="hidden" name="shotId" value={ctx.shot.id} />
                      <Field label="Provider">
                        <input name="provider" defaultValue={ctx.shot.generation.provider ?? ""} />
                      </Field>
                      <Field label="Model">
                        <input name="model" defaultValue={ctx.shot.generation.model ?? ""} />
                      </Field>
                      <Field label="Outcome">
                        <select name="status" defaultValue="rejected">
                          {ATTEMPT_STATUSES.map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Cost (USD)">
                        <input name="costUsd" type="number" step="0.01" min="0" />
                      </Field>
                      <Field label="Rejection reason" className="col-span-2">
                        <input name="rejectionReason" placeholder="e.g. wrong car door" />
                      </Field>
                      <Field label="Notes" className="col-span-2">
                        <input name="notes" />
                      </Field>
                      <div className="col-span-2 text-[10.5px] text-faint">
                        Snapshots the current generation package so history is never rewritten.
                      </div>
                      <div className="col-span-2">
                        <Button size="sm" variant="primary" type="submit">
                          Log attempt
                        </Button>
                      </div>
                    </ActionForm>
                  </details>
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import {
  JobBadge,
  OutputPreview,
  ReviewBadge,
  formatElapsed,
  formatMoney,
} from "@/components/generation/parts";
import { GenerationPoller } from "@/components/generation/poller";
import { Badge, Button, Field, PageHeader } from "@/components/ui";
import type { ProjectGenerationRow } from "@/data/generation-repository";
import { isActive } from "@/domain/generation/job-state";
import { generationSignature } from "@/domain/generation/signature";
import type { Episode, ProjectData } from "@/domain/schemas";
import { shotPath } from "@/lib/paths";
import { logAttempt } from "@/server/actions";
import { getGenerationRepo } from "@/server/generation";

export interface GenerationViewFilters {
  status?: string;
  provider?: string;
  model?: string;
  scene?: string;
  review?: string;
}

const GROUPS: Array<{ key: string; title: string; match: (r: ProjectGenerationRow) => boolean }> = [
  {
    key: "active",
    title: "Active",
    match: (r) => Boolean(r.job && isActive(r.job.status) && r.job.status !== "queued"),
  },
  { key: "queued", title: "Queued", match: (r) => r.job?.status === "queued" },
  {
    key: "completed",
    title: "Completed",
    match: (r) => r.job?.status === "succeeded" || (!r.job && r.attempt.status === "succeeded"),
  },
  {
    key: "failed",
    title: "Failed / cancelled",
    match: (r) =>
      r.job?.status === "failed" ||
      r.job?.status === "cancelled" ||
      (!r.job && r.attempt.status === "failed"),
  },
];

export async function GenerationsView({
  data,
  episode,
  filters = {},
}: {
  data: ProjectData;
  episode: Episode;
  filters?: GenerationViewFilters;
}) {
  const repo = await getGenerationRepo();
  const slug = data.project.slug;
  const epShots = data.shots.filter((s) => s.episodeId === episode.id);
  const shotById = new Map(epShots.map((s) => [s.id, s]));
  const sceneById = new Map(data.scenes.map((s) => [s.id, s]));
  const assetById = new Map(data.assets.map((a) => [a.id, a]));

  const all = (await repo.listProjectGenerations(data.project.id, { limit: 300 })).filter((r) =>
    shotById.has(r.attempt.shotId),
  );
  const providers = [...new Set(all.map((r) => r.attempt.provider))].sort();
  const models = [...new Set(all.map((r) => r.attempt.model))].sort();
  const scenes = [...new Set(epShots.map((s) => s.sceneId))]
    .map((id) => sceneById.get(id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  const rows = all.filter(
    (r) =>
      (!filters.provider || r.attempt.provider === filters.provider) &&
      (!filters.model || r.attempt.model === filters.model) &&
      (!filters.review || r.attempt.reviewStatus === filters.review) &&
      (!filters.scene || shotById.get(r.attempt.shotId)?.sceneId === filters.scene),
  );
  const visibleGroups = GROUPS.filter((g) => !filters.status || filters.status === g.key);

  const estTotal = rows.reduce((s, r) => s + (r.estimated ?? 0), 0);
  const actTotal = rows.reduce((s, r) => s + (r.actual ?? 0), 0);
  const unknownActual = rows.filter((r) => r.job?.status === "succeeded" && r.actual == null).length;
  const activeCount = all.filter((r) => r.job && isActive(r.job.status)).length;
  const signature = generationSignature(
    all.map((r) => ({
      attemptId: r.attempt.id,
      jobStatus: r.job?.status ?? null,
      attemptStatus: r.attempt.status,
      review: r.attempt.reviewStatus,
      updatedAt: r.job?.updatedAt ?? null,
    })),
  );

  return (
    <div>
      <PageHeader
        title={`Generations — ${episode.title}`}
        subtitle="Every attempt is kept: queued, running, failed, rejected and approved. Outputs live in Prism's private storage."
        actions={
          <>
            <Badge>{rows.length} attempts</Badge>
            <Badge>est. {formatMoney(estTotal, "USD")}</Badge>
            <Badge>
              actual {formatMoney(actTotal, "USD")}
              {unknownActual ? ` + ${unknownActual} unknown` : ""}
            </Badge>
            <GenerationPoller projectSlug={slug} signature={signature} active={activeCount > 0} />
          </>
        }
      />
      <div className="space-y-4 p-6">
        <form
          method="get"
          className="flex flex-wrap items-end gap-3 border border-line bg-panel p-3"
          data-testid="generation-filters"
        >
          <Field label="Status">
            <select name="status" defaultValue={filters.status ?? ""}>
              <option value="">All</option>
              {GROUPS.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Provider">
            <select name="provider" defaultValue={filters.provider ?? ""}>
              <option value="">All</option>
              {providers.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <select name="model" defaultValue={filters.model ?? ""}>
              <option value="">All</option>
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="Scene">
            <select name="scene" defaultValue={filters.scene ?? ""}>
              <option value="">All</option>
              {scenes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.sceneNumber}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Review">
            <select name="review" defaultValue={filters.review ?? ""}>
              <option value="">All</option>
              <option value="unreviewed">Unreviewed</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </Field>
          <input type="hidden" name="ep" value={episode.slug} />
          <Button type="submit" size="md">
            Filter
          </Button>
        </form>

        {visibleGroups.map((g) => {
          const list = rows.filter(g.match);
          return (
            <section key={g.key} data-testid={`group-${g.key}`}>
              <h3 className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                {g.title} <Badge>{list.length}</Badge>
              </h3>
              {list.length === 0 ? (
                <div className="border border-dashed border-line2 p-3 text-muted">Nothing here.</div>
              ) : (
                <div className="overflow-x-auto border border-line bg-panel">
                  <table className="w-full text-[12px]">
                    <thead className="border-b border-line text-left text-[10.5px] uppercase text-muted">
                      <tr>
                        <th className="p-2">Output</th>
                        <th className="p-2">Shot</th>
                        <th className="p-2">Scene</th>
                        <th className="p-2">Provider / model</th>
                        <th className="p-2">Status</th>
                        <th className="p-2">Elapsed</th>
                        <th className="p-2">Cost (est. / actual)</th>
                        <th className="p-2">Review</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((r) => {
                        const shot = shotById.get(r.attempt.shotId)!;
                        const scene = sceneById.get(shot.sceneId);
                        const asset = r.primaryAssetId ? assetById.get(r.primaryAssetId) : undefined;
                        return (
                          <tr
                            key={r.attempt.id}
                            className="border-t border-line align-top"
                            data-testid="generation-row"
                          >
                            <td className="w-24 p-2">
                              {asset && asset.type === "image" ? (
                                <OutputPreview
                                  asset={asset}
                                  className="w-20 border border-line"
                                  controls={false}
                                />
                              ) : asset ? (
                                <span className="text-[11px] text-muted">{asset.type}</span>
                              ) : (
                                <span className="text-faint">—</span>
                              )}
                            </td>
                            <td className="p-2">
                              <Link
                                className="text-accent hover:underline"
                                href={shotPath(slug, episode.slug, shot.id, "generate")}
                              >
                                <span className="font-mono">{shot.shotCode}</span> {shot.title}
                              </Link>
                              <div>
                                <Link
                                  className="text-[11px] text-muted hover:underline"
                                  href={`/projects/${slug}/generations/${r.attempt.id}`}
                                >
                                  attempt {r.attempt.attemptNumber}
                                </Link>
                              </div>
                            </td>
                            <td className="p-2">{scene?.sceneNumber ?? "—"}</td>
                            <td className="p-2">
                              {r.attempt.provider}
                              <div className="text-[11px] text-muted">{r.attempt.model}</div>
                            </td>
                            <td className="p-2">
                              {r.job ? <JobBadge status={r.job.status} /> : <Badge>{r.attempt.status}</Badge>}
                            </td>
                            <td className="p-2">
                              {r.job
                                ? formatElapsed(
                                    r.job.startedAt ?? r.job.createdAt,
                                    r.job.completedAt ?? r.job.failedAt ?? r.job.cancelledAt,
                                  )
                                : "—"}
                            </td>
                            <td className="p-2">
                              {formatMoney(r.estimated, r.currency)} /{" "}
                              {r.actual != null
                                ? formatMoney(r.actual, r.currency)
                                : r.job?.status === "succeeded" || r.job?.status === "failed"
                                  ? "Unknown"
                                  : "—"}
                            </td>
                            <td className="p-2">
                              <ReviewBadge status={r.attempt.reviewStatus} />
                              {r.attempt.rejectionCategories.length ? (
                                <div className="mt-0.5 text-[10.5px] text-fail">
                                  {r.attempt.rejectionCategories.join(", ").replace(/_/g, " ")}
                                </div>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}

        <details className="border border-line bg-panel p-3">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-accent">
            + Log an attempt made outside Prism
          </summary>
          <ActionForm action={logAttempt} className="mt-2 grid max-w-2xl grid-cols-2 gap-2">
            <input type="hidden" name="projectSlug" value={slug} />
            <Field label="Shot">
              <select name="shotId">
                {epShots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.shotCode} — {s.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Outcome">
              <select name="outcome" defaultValue="rejected">
                <option value="rejected">Rejected</option>
                <option value="approved">Approved</option>
                <option value="unreviewed">Unreviewed</option>
              </select>
            </Field>
            <Field label="Provider">
              <input name="provider" placeholder="e.g. another tool" />
            </Field>
            <Field label="Model">
              <input name="model" />
            </Field>
            <Field label="Cost (USD)">
              <input name="costUsd" type="number" step="0.01" min="0" />
            </Field>
            <Field label="Rejection reason">
              <input name="rejectionReason" />
            </Field>
            <Field label="Notes" className="col-span-2">
              <input name="notes" />
            </Field>
            <div className="col-span-2 text-[10.5px] text-faint">
              Snapshots the current package so history is never rewritten. Attempts created by Prism&apos;s
              own generation pipeline are made from the shot&apos;s Generate section.
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
  );
}

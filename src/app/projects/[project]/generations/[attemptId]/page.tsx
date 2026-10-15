import Link from "next/link";
import { notFound } from "next/navigation";
import { AdaptationPlanCard } from "@/components/generation/adaptation-plan-card";
import { AttemptMediaPanel, StageChips } from "@/components/generation/attempt-media-panel";
import { PromptInspector } from "@/components/generation/prompt-inspector";
import { JobBadge, OutputPreview, ReviewBadge, formatMoney } from "@/components/generation/parts";
import { Badge, PageHeader } from "@/components/ui";
import {
  renderGenerationBrief,
  type BriefSection,
  type GenerationPackage,
} from "@/domain/generation-package";
import { generationRequestSchema, promptPlanSchema } from "@/domain/generation/schemas";
import type { CompatibilityReport } from "@/domain/generation/compatibility";
import { PART_LABELS } from "@/domain/fingerprint";
import type { CompiledRequestSummary } from "@/generation/provider";
import { loadAttemptMedia } from "@/server/attempt-media";
import { getGenerationRepo, getRegistry } from "@/server/generation";
import { requireProject } from "@/server/repo";

export const dynamic = "force-dynamic";

/** One attempt, as it was: frozen brief, plan, request, compatibility, outputs, costs and event timeline. */
export default async function AttemptPage({
  params,
}: {
  params: Promise<{ project: string; attemptId: string }>;
}) {
  const { project: slug, attemptId } = await params;
  const data = await requireProject(slug);
  const repo = await getGenerationRepo();
  const view = await repo.getAttemptView(attemptId);
  if (!view || view.attempt.projectId !== data.project.id) notFound();
  const { attempt, job, outputs, costs } = view;
  const events = job ? await repo.listJobEvents(job.id) : [];
  const media = await loadAttemptMedia(data, view);
  const shot = data.shots.find((s) => s.id === attempt.shotId);
  const episode = data.episodes.find((e) => e.id === shot?.episodeId);

  let brief: BriefSection[] | null = null;
  try {
    brief = renderGenerationBrief(attempt.packageSnapshot as unknown as GenerationPackage);
  } catch {
    brief = null;
  }
  const plan = promptPlanSchema.safeParse(attempt.promptPlan);
  const request = generationRequestSchema.safeParse(attempt.request);
  let compiled: CompiledRequestSummary | null = null;
  if (plan.success && request.success) {
    compiled = getRegistry().adapter(attempt.provider)?.compileRequest(request.data, plan.data) ?? null;
  }
  const compat = attempt.compatibility as unknown as CompatibilityReport | null;
  const parts =
    (attempt.packageSnapshot as { provenance?: { parts?: Record<string, string> } }).provenance?.parts ?? {};

  return (
    <div>
      <PageHeader
        title={`Attempt ${attempt.attemptNumber} — ${shot?.shotCode ?? ""} ${shot?.title ?? ""}`}
        subtitle={`${attempt.provider} / ${attempt.model} · package ${attempt.packageFingerprint.slice(0, 12)} · immutable`}
        actions={
          <>
            {job ? <JobBadge status={job.status} /> : <Badge>{attempt.status}</Badge>}
            <ReviewBadge status={attempt.reviewStatus} />
          </>
        }
      />
      <div className="space-y-4 p-6">
        <div className="flex flex-wrap gap-3 text-[12px]">
          {shot && episode ? (
            <Link
              className="text-accent hover:underline"
              href={`/projects/${slug}/episodes/${episode.slug}/shots/${shot.id}?section=generate`}
            >
              ← Shot prep
            </Link>
          ) : null}
          <a
            className="text-accent hover:underline"
            href={`/api/projects/${slug}/generations/${attempt.id}/package?format=brief`}
          >
            Download frozen brief (.txt)
          </a>
          <a
            className="text-accent hover:underline"
            href={`/api/projects/${slug}/generations/${attempt.id}/package?format=json`}
          >
            Download frozen package (.json)
          </a>
        </div>

        <StageChips
          attempt={attempt}
          generated={{
            label: job ? job.status.replace(/_/g, " ") : attempt.status,
            tone: attempt.status === "succeeded" ? "pass" : attempt.status === "failed" ? "fail" : "neutral",
          }}
          qaStatus={media.qaStatus}
          qaStale={media.qaStale}
        />

        <AttemptMediaPanel
          projectSlug={slug}
          attemptId={attempt.id}
          media={media}
          succeeded={attempt.status === "succeeded"}
        />

        <AdaptationPlanCard plan={media.plan} acknowledged={attempt.acknowledgedIgnored} />

        <PromptInspector
          heading="Frozen prompt inspector (as submitted)"
          brief={brief}
          plan={plan.success ? plan.data : null}
          compiled={compiled}
        />

        <section className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-2 border border-line bg-panel p-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Outputs</h3>
            {outputs.map((o) => (
              <div key={o.output.id} className="space-y-1" data-testid="attempt-output">
                <div className="text-[11px] text-muted">
                  #{o.output.position} · {o.output.role} · <span className="font-mono">{o.asset.name}</span>
                </div>
                <OutputPreview asset={o.asset} className="max-h-72 border border-line bg-black" />
              </div>
            ))}
            {outputs.length === 0 ? <div className="text-muted">No output.</div> : null}
          </div>

          <div className="space-y-3">
            <div className="border border-line bg-panel p-3">
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Costs</h3>
              <table className="w-full text-[12px]">
                <tbody>
                  {costs.map((c) => (
                    <tr key={c.id} className="border-t border-line first:border-0">
                      <td className="py-1 text-muted">{c.kind}</td>
                      <td className="py-1">
                        {c.kind === "unknown" ? "Unknown" : formatMoney(c.amount, c.currency)}
                      </td>
                      <td className="py-1 text-faint">{c.basis}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border border-line bg-panel p-3">
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                Compatibility at submission
              </h3>
              {compat ? (
                <>
                  <div className="text-[12px]">
                    {compat.compatible ? "Compatible" : "Incompatible"} · modality{" "}
                    <span className="font-mono">{compat.modality}</span>
                  </div>
                  {compat.ignoredFeatures?.length ? (
                    <ul className="mt-1 list-disc pl-4 text-[12px] text-warn">
                      {compat.ignoredFeatures.map((f) => (
                        <li key={f.id}>
                          {f.label}: {f.impact}
                          {attempt.acknowledgedIgnored.includes(f.id) ? " (acknowledged)" : ""}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-[12px] text-muted">Nothing was ignored.</div>
                  )}
                </>
              ) : (
                <div className="text-muted">Not recorded (attempt logged manually).</div>
              )}
            </div>
            <div className="border border-line bg-panel p-3">
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                Job timeline
              </h3>
              <ol className="space-y-0.5 text-[12px]" data-testid="job-events">
                {events.map((e) => (
                  <li key={e.id}>
                    <span className="font-mono text-[10.5px] text-faint">
                      {new Date(e.at).toLocaleTimeString()}
                    </span>{" "}
                    {e.fromStatus && e.fromStatus !== e.toStatus ? `${e.fromStatus} → ` : ""}
                    <span className="font-medium">{e.toStatus}</span>
                    {e.note ? <span className="text-muted"> — {e.note}</span> : null}
                  </li>
                ))}
                {events.length === 0 ? <li className="text-muted">No job (logged manually).</li> : null}
              </ol>
            </div>
          </div>
        </section>

        <details className="border border-line bg-panel p-3">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-muted">
            Package part fingerprints
          </summary>
          <table className="mt-2 text-[11.5px]">
            <tbody>
              {Object.entries(parts).map(([k, v]) => (
                <tr key={k}>
                  <td className="pr-4 text-muted">{(PART_LABELS as Record<string, string>)[k] ?? k}</td>
                  <td className="font-mono text-faint">{String(v).slice(0, 16)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { StageChips } from "@/components/generation/attempt-media-panel";
import { OutputPreview, ReviewBadge, formatMoney } from "@/components/generation/parts";
import { QA_STATUS_LABELS, describeSummary } from "@/domain/continuity/status";
import { FRAMING_LABELS } from "@/domain/framing/adaptation";
import { assetUrl } from "@/lib/utils";
import { loadAttemptMedia, type AttemptMedia } from "@/server/attempt-media";
import { PageHeader } from "@/components/ui";
import type { AttemptView } from "@/data/generation-repository";
import { PART_LABELS } from "@/domain/fingerprint";
import { getGenerationRepo } from "@/server/generation";
import { requireProject } from "@/server/repo";

export const dynamic = "force-dynamic";

const partsOf = (v: AttemptView) =>
  ((v.attempt.packageSnapshot as { provenance?: { parts?: Record<string, string> } }).provenance?.parts ??
    {}) as Record<string, string>;

/** Side-by-side comparison of two attempts, including which production parts differed between them. */
export default async function ComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ a?: string; b?: string }>;
}) {
  const { project: slug } = await params;
  const { a, b } = await searchParams;
  const data = await requireProject(slug);
  const repo = await getGenerationRepo();
  const [va, vb] = await Promise.all([
    a ? repo.getAttemptView(a) : Promise.resolve(null),
    b ? repo.getAttemptView(b) : Promise.resolve(null),
  ]);
  if (!va || !vb || va.attempt.projectId !== data.project.id || vb.attempt.projectId !== data.project.id) {
    notFound();
  }

  const [ma, mb] = await Promise.all([loadAttemptMedia(data, va), loadAttemptMedia(data, vb)]);
  const mediaOf = (v: AttemptView) => (v.attempt.id === va.attempt.id ? ma : mb);
  const pa = partsOf(va);
  const pb = partsOf(vb);
  const changed = Object.keys({ ...pa, ...pb }).filter((k) => k !== "overall" && pa[k] !== pb[k]);

  const column = (v: AttemptView) => {
    const m: AttemptMedia = mediaOf(v);
    const est = v.costs.find((c) => c.kind === "estimated");
    const fin = v.costs.find((c) => c.kind !== "estimated");
    const plan = m.plan;
    const latest = m.latestRun;
    return (
      <div className="space-y-2 border border-line bg-panel p-3" data-testid="compare-column">
        <div className="flex items-center justify-between">
          <span className="font-medium">
            Attempt {v.attempt.attemptNumber}{" "}
            <span className="text-muted">
              {v.attempt.provider}/{v.attempt.model}
            </span>
          </span>
          <ReviewBadge status={v.attempt.reviewStatus} />
        </div>
        {v.outputs[0] ? (
          <div>
            <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-muted">Provider original</div>
            <OutputPreview
              asset={v.outputs[0].asset}
              className="max-h-80 w-full border border-line bg-black"
            />
          </div>
        ) : (
          <div className="border border-dashed border-line2 p-6 text-center text-muted">No output</div>
        )}
        {m.delivery && !m.delivery.isOriginal ? (
          <div data-testid="compare-delivery">
            <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-muted">Delivery master</div>
            <OutputPreview asset={m.delivery.asset} className="max-h-80 w-full border border-line bg-black" />
          </div>
        ) : null}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-[12px]">
          <dt className="text-muted">Status</dt>
          <dd>{v.attempt.status}</dd>
          <dt className="text-muted">Duration</dt>
          <dd>{v.attempt.durationMs ? `${(v.attempt.durationMs / 1000).toFixed(2)}s` : "—"}</dd>
          <dt className="text-muted">Package</dt>
          <dd className="font-mono">{v.attempt.packageFingerprint.slice(0, 12)}</dd>
          {v.attempt.rejectionReason ? (
            <>
              <dt className="text-muted">Rejected</dt>
              <dd className="text-fail">{v.attempt.rejectionReason}</dd>
            </>
          ) : null}
        </dl>
        <StageChips
          attempt={v.attempt}
          generated={{
            label: v.job ? v.job.status.replace(/_/g, " ") : v.attempt.status,
            tone:
              v.attempt.status === "succeeded" ? "pass" : v.attempt.status === "failed" ? "fail" : "neutral",
          }}
          qaStatus={m.qaStatus}
          qaStale={m.qaStale}
        />
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
          <dt className="text-muted">Cost</dt>
          <dd>
            est. {formatMoney(est?.amount ?? null, est?.currency ?? "USD")} · actual{" "}
            {fin ? (fin.kind === "actual" ? formatMoney(fin.amount, fin.currency) : "Unknown") : "—"}
          </dd>
          <dt className="text-muted">Prompt plan</dt>
          <dd>
            {v.attempt.promptPlan
              ? `${v.attempt.promptPlan.sections.length} sections`
              : "none (logged manually)"}
          </dd>
          <dt className="text-muted">Adaptation</dt>
          <dd data-testid="compare-adaptation">
            {plan
              ? `${FRAMING_LABELS[plan.framing.strategy]}${
                  plan.duration.status === "adapted"
                    ? ` · ${(plan.duration.providerMs! / 1000).toFixed(1)}s → ${(plan.duration.trimToMs! / 1000).toFixed(1)}s`
                    : ""
                }`
              : "No adaptation plan recorded"}
          </dd>
          <dt className="text-muted">Original</dt>
          <dd className="font-mono text-[11px]">
            {m.original
              ? `${m.original.width}×${m.original.height} · ${((m.original.durationMs ?? 0) / 1000).toFixed(2)}s`
              : "—"}
          </dd>
          <dt className="text-muted">Delivery</dt>
          <dd className="font-mono text-[11px]">
            {m.delivery && !m.delivery.isOriginal
              ? `${m.delivery.asset.width}×${m.delivery.asset.height} · ${((m.delivery.asset.durationMs ?? 0) / 1000).toFixed(2)}s`
              : "provider original"}
          </dd>
          <dt className="text-muted">Continuity</dt>
          <dd data-testid="compare-qa">
            {latest ? (
              <>
                {QA_STATUS_LABELS[latest.status]}
                {latest.freshness?.stale ? " (stale)" : ""}
                <span className="block text-[11px] text-muted">
                  {describeSummary(latest.summary, latest.analyzerKind).slice(0, 2).join(" · ")}
                </span>
              </>
            ) : (
              "Not run"
            )}
          </dd>
        </dl>
        {m.contactSheet ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={assetUrl(m.contactSheet)!} alt="Contact sheet" className="max-h-28 border border-line" />
        ) : null}
        <Link
          className="text-[12px] text-accent hover:underline"
          href={`/projects/${slug}/generations/${v.attempt.id}`}
        >
          Open attempt →
        </Link>
      </div>
    );
  };

  return (
    <div>
      <PageHeader
        title="Compare attempts"
        subtitle="Both attempts are immutable; only their review state can change."
      />
      <div className="space-y-4 p-6">
        <div className="grid gap-4 md:grid-cols-2">
          {column(va)}
          {column(vb)}
        </div>
        <div className="border border-line bg-panel p-3" data-testid="compare-changes">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
            What changed in the production inputs
          </h3>
          {changed.length === 0 ? (
            <div className="text-muted">Same package: every production input is identical.</div>
          ) : (
            <ul className="list-disc pl-4 text-[12px]">
              {changed.map((k) => (
                <li key={k}>{(PART_LABELS as Record<string, string>)[k] ?? k} changed</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

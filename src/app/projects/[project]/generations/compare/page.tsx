import Link from "next/link";
import { notFound } from "next/navigation";
import { OutputPreview, ReviewBadge } from "@/components/generation/parts";
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

  const pa = partsOf(va);
  const pb = partsOf(vb);
  const changed = Object.keys({ ...pa, ...pb }).filter((k) => k !== "overall" && pa[k] !== pb[k]);

  const column = (v: AttemptView) => (
    <div className="space-y-2 border border-line bg-panel p-3">
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
        <OutputPreview asset={v.outputs[0].asset} className="max-h-80 w-full border border-line bg-black" />
      ) : (
        <div className="border border-dashed border-line2 p-6 text-center text-muted">No output</div>
      )}
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
      <Link
        className="text-[12px] text-accent hover:underline"
        href={`/projects/${slug}/generations/${v.attempt.id}`}
      >
        Open attempt →
      </Link>
    </div>
  );

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

import Link from "next/link";
import { BenchmarkBanner } from "@/components/candidates/benchmark-banner";
import { Badge, Empty, PageHeader } from "@/components/ui";
import { rollupSet } from "@/domain/generation/candidates";
import { latestReviews, NEGATIVE_LABELS } from "@/domain/generation/reviews";
import { getCandidateRepo } from "@/server/candidates";
import { getGenerationRepo } from "@/server/generation";
import { requireProject } from "@/server/repo";

export const dynamic = "force-dynamic";

const money = (n: number | null) => (n == null ? "unknown" : `$${n.toFixed(n < 1 ? 3 : 2)}`);

/** Prism's production R&D history: every candidate set, what won, what it cost and why others lost. */
export default async function ExperimentsPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  const data = await requireProject(slug);
  const candidates = await getCandidateRepo();
  const generation = await getGenerationRepo();
  const sets = await candidates.listSets(data.project.id);
  const reviews = await candidates.listReviews(data.project.id);
  const current = latestReviews(reviews);

  const rows = await Promise.all(
    sets.map(async (s) => {
      const views = await Promise.all(
        s.members.map((m) => (m.attemptId ? generation.getAttemptView(m.attemptId) : null)),
      );
      let actual = 0;
      let known = 0;
      let winnerCost: number | null = null;
      let rejectedSpend = 0;
      const reasons = new Map<string, number>();
      s.members.forEach((m, i) => {
        const v = views[i];
        const a = v?.costs.find((c) => c.kind === "actual")?.amount ?? null;
        const r = m.attemptId ? current.get(m.attemptId) : undefined;
        if (a != null) {
          actual += a;
          known += 1;
          if (r?.decision === "reject") rejectedSpend += a;
          if (m.attemptId && s.set.preferredAttemptId === m.attemptId) winnerCost = a;
        }
        for (const t of r?.negativeTags ?? []) reasons.set(t, (reasons.get(t) ?? 0) + 1);
      });
      const roll = rollupSet(
        s.members.map((m, i) => ({
          submitState: m.submitState,
          attemptStatus: views[i]?.attempt.status ?? null,
        })),
      );
      const winner = s.members.find((m) => m.attemptId && m.attemptId === s.set.preferredAttemptId);
      return { s, roll, actual: known ? actual : null, winnerCost, rejectedSpend, reasons, winner };
    }),
  );

  return (
    <div data-testid="experiments-page">
      <PageHeader
        title="Experiments"
        subtitle="Candidate sets: which models were compared, what won, what it cost and why the others lost."
      />
      <div className="space-y-3 p-6">
        {data.project.isBenchmark ? <BenchmarkBanner /> : null}
        {rows.length === 0 ? (
          <Empty>
            No candidate sets yet. Compare models from a shot&apos;s Generate panel (Shot Prep). Standalone
            generations stay in Generations.
          </Empty>
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-line text-left text-[10.5px] uppercase tracking-wide text-muted">
                <th className="px-2 py-1.5">Shot</th>
                <th className="px-2 py-1.5">Date</th>
                <th className="px-2 py-1.5">Models compared</th>
                <th className="px-2 py-1.5">Winner</th>
                <th className="px-2 py-1.5 text-right">Spend (est / actual)</th>
                <th className="px-2 py-1.5">Reasons</th>
                <th className="px-2 py-1.5">State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ s, roll, actual, winnerCost, rejectedSpend, reasons, winner }) => {
                const shot = data.shots.find((x) => x.id === s.set.shotId);
                const paid = s.members.some((m) => m.provider !== "mock");
                return (
                  <tr key={s.set.id} className="border-b border-line align-top" data-testid="experiment-row">
                    <td className="px-2 py-1.5">
                      <Link href={`/projects/${slug}/candidates/${s.set.id}`} className="underline">
                        {shot?.shotCode ?? "?"} · {s.set.title || "Candidate set"}
                      </Link>
                    </td>
                    <td className="px-2 py-1.5 text-muted">
                      {new Date(s.set.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-2 py-1.5">
                      {s.members.map((m) => `${m.label} ${m.model}`).join(" · ")}
                    </td>
                    <td className="px-2 py-1.5">
                      {winner ? (
                        <>
                          {winner.label} {winner.model}
                          {s.set.promotedAttemptId ? (
                            <Badge tone="pass" className="ml-1">
                              promoted
                            </Badge>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-faint">none yet</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {paid ? (
                        <>
                          {money(s.set.estimatedTotalUsd)} / {money(actual)}
                          <div className="text-[10.5px] text-faint">
                            winner {money(winnerCost)} · rejected {money(rejectedSpend)}
                          </div>
                        </>
                      ) : (
                        "free"
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-muted">
                      {[...reasons.entries()]
                        .sort((a, b) => b[1] - a[1])
                        .map(([t, c]) => `${NEGATIVE_LABELS[t as keyof typeof NEGATIVE_LABELS] ?? t} ×${c}`)
                        .join(", ") || "—"}
                    </td>
                    <td className="px-2 py-1.5 text-muted">
                      {roll.label} · {s.set.status}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

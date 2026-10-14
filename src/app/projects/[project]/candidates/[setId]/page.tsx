import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { CandidateBoard, type BoardCandidate } from "@/components/candidates/candidate-board";
import { GenerationPoller } from "@/components/generation/poller";
import { Badge, Button, PageHeader, Panel } from "@/components/ui";
import type { AttemptView } from "@/data/generation-repository";
import { rollupSet } from "@/domain/generation/candidates";
import { generationSignature } from "@/domain/generation/signature";
import { latestReviews } from "@/domain/generation/reviews";
import { parseAdaptationPlan } from "@/domain/framing/adaptation";
import { assetUrl } from "@/lib/utils";
import { loadAttemptMedia } from "@/server/attempt-media";
import { archiveCandidateSet } from "@/server/candidate-actions";
import { getCandidateRepo } from "@/server/candidates";
import { getGenerationRepo } from "@/server/generation";
import { requireProject } from "@/server/repo";

export const dynamic = "force-dynamic";

const ms = (a: string | null | undefined, b: string | null | undefined): number | null => {
  if (!a || !b) return null;
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) && d >= 0 ? d : null;
};
const money = (n: number | null) => (n == null ? "unknown" : `$${n.toFixed(n < 1 ? 3 : 2)}`);

/** The comparison workspace for one candidate set: side by side, human review, explicit promotion. */
export default async function CandidateSetPage({
  params,
}: {
  params: Promise<{ project: string; setId: string }>;
}) {
  const { project: slug, setId } = await params;
  const data = await requireProject(slug);
  const candidates = await getCandidateRepo();
  const generation = await getGenerationRepo();
  const set = await candidates.getSet(setId);
  if (!set || set.set.projectId !== data.project.id) notFound();

  const shot = data.shots.find((s) => s.id === set.set.shotId);
  const views = new Map<string, AttemptView>();
  for (const m of set.members) {
    if (!m.attemptId) continue;
    const v = await generation.getAttemptView(m.attemptId);
    if (v) views.set(m.attemptId, v);
  }
  const attemptIds = [...views.keys()];
  const reviews = await candidates.listReviews(data.project.id, { attemptIds });
  const current = latestReviews(reviews);
  const countBy = new Map<string, number>();
  for (const r of reviews) countBy.set(r.attemptId, (countBy.get(r.attemptId) ?? 0) + 1);

  const board: BoardCandidate[] = [];
  let actualTotal = 0;
  let actualKnown = 0;
  let rejectedSpend = 0;
  let winnerCost: number | null = null;
  for (const m of set.members) {
    const v = m.attemptId ? (views.get(m.attemptId) ?? null) : null;
    const media = v ? await loadAttemptMedia(data, v) : null;
    const actual = v?.costs.find((c) => c.kind === "actual")?.amount ?? null;
    const est = v?.costs.find((c) => c.kind === "estimated")?.amount ?? m.estimateUsd;
    const r = v ? (current.get(v.attempt.id) ?? null) : null;
    if (actual != null) {
      actualTotal += actual;
      actualKnown += 1;
      if (r?.decision === "reject") rejectedSpend += actual;
      if (set.set.preferredAttemptId === v?.attempt.id) winnerCost = actual;
    }
    const plan = media?.plan ?? parseAdaptationPlan(v?.attempt.adaptationPlan);
    const output = v?.outputs.find((o) => o.output.role === "primary")?.asset ?? null;
    const shown = media?.delivery?.asset ?? output;
    const isMock = m.provider === "mock";
    const adaptations = (m.plan.adaptations as string[] | undefined) ?? [];
    const used = m.plan.referencesUsed as { used: number; total: number } | undefined;
    board.push({
      attemptId: m.attemptId ?? `planned-${m.id}`,
      label: m.label,
      attemptNumber: v?.attempt.attemptNumber ?? null,
      providerName: m.provider === "mock" ? "Mock" : m.provider === "runway" ? "Runway" : m.provider,
      modelLabel: m.model,
      modelId: m.model,
      status: !m.attemptId ? "not_submitted" : (v?.attempt.status ?? "queued"),
      statusNote: m.submitError || v?.job?.lastErrorMessage || "",
      videoUrl: shown && shown.type === "video" ? assetUrl(shown) : null,
      posterUrl: media?.contactSheet ? assetUrl(media.contactSheet) : null,
      frames: (media?.frames ?? []).flatMap((f) => {
        const u = assetUrl(f.asset);
        return u ? [{ atMs: f.atMs, url: u }] : [];
      }),
      durationMs: shown?.durationMs ?? v?.attempt.durationMs ?? null,
      resolution: shown?.width && shown?.height ? `${shown.width}×${shown.height}` : null,
      providerCanvas: plan?.framing.providerCanvas
        ? `${plan.framing.providerCanvas.width}×${plan.framing.providerCanvas.height}`
        : null,
      deliveryNote: media?.delivery?.isOriginal === false ? "conformed master" : "provider original",
      estimateUsd: est,
      actualUsd: actual,
      currency: v?.costs[0]?.currency ?? "USD",
      generationMs: ms(v?.job?.submittedAt, v?.job?.completedAt),
      totalMs: ms(v?.job?.createdAt, v?.job?.completedAt),
      adaptations,
      referencesUsed: used ? `${used.used}/${used.total} images` : "—",
      inputMode: m.inputMode,
      tier: m.tierId,
      nativeAudio: m.nativeAudio,
      review: r
        ? {
            decision: r.decision,
            negativeTags: r.negativeTags,
            positiveTags: r.positiveTags,
            notes: r.notes,
            reviewedAt: r.reviewedAt,
          }
        : null,
      reviewCount: v ? (countBy.get(v.attempt.id) ?? 0) : 0,
      preferred: Boolean(v && set.set.preferredAttemptId === v.attempt.id),
      promoted: Boolean(v && set.set.promotedAttemptId === v.attempt.id),
      free: isMock,
      detailHref: v ? `/projects/${slug}/generations/${v.attempt.id}/continuity` : null,
    });
  }

  const rollup = rollupSet(
    set.members.map((m) => ({
      submitState: m.submitState,
      attemptStatus: m.attemptId ? (views.get(m.attemptId)?.attempt.status ?? "queued") : null,
    })),
  );
  const active = !rollup.settled;
  const signature = generationSignature(
    [...views.values()].map((v) => ({
      attemptId: v.attempt.id,
      jobStatus: v.job?.status ?? null,
      attemptStatus: v.attempt.status,
      review: v.attempt.reviewStatus,
      updatedAt: v.job?.updatedAt ?? null,
    })),
  );
  const disclosure = (
    set.set.recommendation as { disclosure?: { same: string[]; different: string[] } } | null
  )?.disclosure;
  const rec = set.set.recommendation as {
    topModelId?: string | null;
    recommendedTopModelId?: string | null;
    chosen?: Array<{ modelId: string; label: string }>;
    historyNote?: string;
    engineVersion?: string;
  } | null;
  const paidSet = set.members.some((m) => m.provider !== "mock");

  return (
    <div data-testid="candidate-set-page">
      <PageHeader
        title={set.set.title || "Candidate set"}
        subtitle={
          <>
            Shot {shot?.shotCode ?? "?"} · {new Date(set.set.createdAt).toLocaleString()} ·{" "}
            <span data-testid="set-rollup">{rollup.label}</span>
          </>
        }
        actions={
          <>
            <Badge
              tone={
                set.set.status === "decided" ? "pass" : set.set.status === "archived" ? "neutral" : "info"
              }
            >
              {set.set.status}
            </Badge>
            <Link href={`/projects/${slug}/candidates`} className="text-[12px] text-muted underline">
              All experiments
            </Link>
          </>
        }
      />
      <div className="space-y-4 p-6">
        <GenerationPoller projectSlug={slug} shotId={set.set.shotId} signature={signature} active={active} />

        <div className="grid gap-3 md:grid-cols-3">
          <Panel title="Same for every candidate">
            <ul className="list-disc space-y-0.5 pl-4 text-[11.5px]" data-testid="same-list">
              {(disclosure?.same ?? []).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </Panel>
          <Panel title="Necessarily different">
            <ul className="list-disc space-y-0.5 pl-4 text-[11.5px]" data-testid="different-list">
              {(disclosure?.different ?? []).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            <p className="mt-1 text-[10.5px] text-faint">
              Provider capabilities force these differences; this is not an identical-conditions test.
            </p>
          </Panel>
          <Panel title="Spend">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11.5px]" data-testid="set-spend">
              <dt className="text-muted">Estimated total</dt>
              <dd className="tabular-nums">{paidSet ? money(set.set.estimatedTotalUsd) : "free (mock)"}</dd>
              <dt className="text-muted">Actual total</dt>
              <dd className="tabular-nums">
                {paidSet
                  ? `${money(actualKnown ? actualTotal : null)}${actualKnown < attemptIds.length ? " (partial)" : ""}`
                  : "free"}
              </dd>
              <dt className="text-muted">Winner cost</dt>
              <dd className="tabular-nums">{paidSet ? money(winnerCost) : "free"}</dd>
              <dt className="text-muted">Rejected-candidate spend</dt>
              <dd className="tabular-nums">{paidSet ? money(rejectedSpend) : "free"}</dd>
            </dl>
            <p className="mt-1 text-[10.5px] text-faint">
              “Rejected spend” is what exploring cost, not a judgment of the model.
            </p>
          </Panel>
        </div>

        {rec ? (
          <div className="text-[11.5px] text-muted" data-testid="set-recommendation">
            Advice at creation ({rec.engineVersion ?? "model-routing-v1"}):{" "}
            {rec.recommendedTopModelId ? (
              <>
                recommended <span className="text-fg">{rec.recommendedTopModelId}</span>; you chose{" "}
                <span className="text-fg">{(rec.chosen ?? []).map((c) => c.modelId).join(", ")}</span>.
              </>
            ) : (
              "no model was singled out."
            )}{" "}
            {rec.historyNote}
          </div>
        ) : null}

        <CandidateBoard
          projectSlug={slug}
          setId={setId}
          candidates={board}
          canPromote={set.set.status !== "archived"}
        />

        <Panel
          title="History"
          actions={
            <ActionForm action={archiveCandidateSet} quiet successMessage="" className="contents">
              <input type="hidden" name="projectSlug" value={slug} />
              <input type="hidden" name="setId" value={setId} />
              <input type="hidden" name="archive" value={set.set.status === "archived" ? "0" : "1"} />
              <Button size="sm" type="submit">
                {set.set.status === "archived" ? "Reopen" : "Archive"}
              </Button>
            </ActionForm>
          }
        >
          <ol className="space-y-0.5 text-[11.5px]" data-testid="set-events">
            {set.events.map((e) => (
              <li key={e.id}>
                <span className="tabular-nums text-faint">{new Date(e.at).toLocaleTimeString()}</span>{" "}
                {e.kind.replace(/_/g, " ")}
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </div>
  );
}

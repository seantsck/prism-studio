import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { SequenceFilters, type SequenceFilter } from "@/components/sequence/sequence-filters";
import { SortableBoard } from "@/components/sortable-board";
import { Badge, Button, PageHeader, STATUS_TONE } from "@/components/ui";
import { formatDuration, formatSeconds } from "@/domain/duration";
import { PRODUCTION_FRAME_SOURCE_LABEL } from "@/domain/production-frame";
import type { Asset, Episode, ProjectData } from "@/domain/schemas";
import {
  buildShotSequence,
  changedPartLabels,
  SEQUENCE_HEALTH_LABEL,
  sequenceLinkChanges,
  sequenceLinkPreviewKey,
  type SequenceLinkChange,
  type ShotSequence,
  type ShotSequenceItem,
  type ShotSequenceTransition,
  type TransitionFact,
} from "@/domain/shot-sequence";
import { shotPath } from "@/lib/paths";
import { assetUrl, cn } from "@/lib/utils";
import { syncSequenceContinuityLinks } from "@/server/sequence-actions";

/**
 * Phase 2G.5 Shot Sequence Board: the episode as a sequence of canonical stills. A read-only projection of Shot Prep
 * truth (no table, no cache, no package change); its only write is the explicit, previewed continuity-link sync.
 * Images come only through the private asset route.
 */

type Assets = ReadonlyMap<string, Asset>;
const withParam = (base: string, key: string, value: string) =>
  `${base}${base.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;

const VISUAL_BADGE: Record<
  ShotSequenceItem["visual"]["kind"],
  { label: string; tone: "pass" | "info" | "warn" | "fail" }
> = {
  production_frame: { label: "Production Frame", tone: "pass" },
  approved_storyboard: { label: "Storyboard fallback", tone: "info" },
  draft_storyboard: { label: "Draft Storyboard", tone: "warn" },
  none: { label: "No production image", tone: "fail" },
};

function visualAlt(item: ShotSequenceItem): string {
  const v = item.visual;
  const what =
    v.kind === "production_frame"
      ? `Production Frame v${v.version}`
      : v.kind === "approved_storyboard"
        ? `approved Storyboard v${v.version} (fallback, not a Production Frame)`
        : `draft Storyboard v${v.version} (not canonical)`;
  return `Shot ${item.shotCode} — ${what}${v.freshness === "stale" ? ", stale" : ""}`;
}

/** The one canonical display image (or a clear placeholder), production-shaped, with its label and stale overlay. */
function SequenceVisual({
  item,
  assets,
  large = false,
}: {
  item: ShotSequenceItem;
  assets: Assets;
  large?: boolean;
}) {
  const v = item.visual;
  const url = v.assetId ? assetUrl(assets.get(v.assetId)) : null;
  const aspect =
    v.kind === "production_frame" && v.width && v.height
      ? `${v.width} / ${v.height}`
      : item.productionAspect
        ? `${item.productionAspect.w} / ${item.productionAspect.h}`
        : "2.39 / 1";
  const badge = VISUAL_BADGE[v.kind];
  return (
    <div className="relative" data-testid="sequence-visual" data-kind={v.kind} data-freshness={v.freshness}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={visualAlt(item)}
          className={cn(
            "w-full bg-panel2",
            v.kind === "production_frame" ? "object-contain" : "object-cover",
          )}
          style={{ aspectRatio: aspect }}
        />
      ) : (
        <div
          role="img"
          aria-label={
            v.kind === "none"
              ? `Shot ${item.shotCode}: no production image`
              : `Shot ${item.shotCode}: ${badge.label} has no stored image`
          }
          className="flex w-full flex-col items-center justify-center gap-1 bg-[repeating-linear-gradient(135deg,#141417,#141417_10px,#101013_10px,#101013_20px)] text-center"
          style={{ aspectRatio: aspect }}
        >
          <span
            className={cn(
              "font-mono font-semibold tracking-wide text-faint",
              large ? "text-[14px]" : "text-[11px]",
            )}
          >
            {v.kind === "none" ? "NO PRODUCTION IMAGE" : `${badge.label.toUpperCase()} · NO IMAGE`}
          </span>
        </div>
      )}
      <div className="absolute left-1.5 top-1.5 flex flex-wrap gap-1">
        <Badge tone={badge.tone} className="bg-bg/85">
          <span data-testid="sequence-visual-label">
            {badge.label}
            {v.version ? ` v${v.version}` : ""}
          </span>
        </Badge>
        {v.kind === "draft_storyboard" ? (
          <Badge tone="warn" className="bg-bg/85">
            not canonical
          </Badge>
        ) : null}
      </div>
      {v.freshness === "stale" ? (
        <div className="absolute bottom-1.5 left-1.5">
          <Badge tone="warn" className="bg-bg/90 font-semibold">
            <span data-testid="sequence-stale">⚠ Stale</span>
          </Badge>
        </div>
      ) : null}
    </div>
  );
}

function StaleDetails({ item }: { item: ShotSequenceItem }) {
  if (item.visual.freshness !== "stale") return null;
  return (
    <details className="text-[11px]" data-testid="sequence-stale-details">
      <summary className="cursor-pointer text-warn hover:underline">What changed? ▾</summary>
      <ul className="mt-1 list-disc pl-4 text-muted">
        {changedPartLabels(item.visual.changedParts).map((l) => (
          <li key={l}>{l} changed</li>
        ))}
      </ul>
      <p className="mt-1 text-faint">
        {item.visual.kind === "production_frame"
          ? "The frame stays selected and shown until you choose or make another one."
          : "The approved Storyboard is shown as a fallback; re-approve or make a Production Frame."}
      </p>
    </details>
  );
}

function CharacterLines({ item }: { item: ShotSequenceItem }) {
  if (item.characters.length === 0) return <span className="text-faint">No Characters</span>;
  return (
    <ul className="space-y-0.5">
      {item.characters.map((c) => (
        <li key={c.characterId} data-testid="sequence-character" data-authority={c.authority}>
          <span className="font-medium">{c.name}</span>{" "}
          {c.issue ? (
            <span className="text-fail">· invalid Continuity Lock selection</span>
          ) : c.lock ? (
            <span className="text-accent" data-testid="sequence-character-lock">
              🔒 {c.lock.name}
            </span>
          ) : (
            <span className="text-muted">· Live appearance{c.lookName ? ` · ${c.lookName}` : ""}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function pfLine(item: ShotSequenceItem) {
  const pf = item.productionFrame;
  if (!pf) return <span className="text-warn">missing</span>;
  return (
    <span>
      v{pf.version} · {PRODUCTION_FRAME_SOURCE_LABEL[pf.source]}
      {pf.generated ? ` · ${pf.generated.provider} / ${pf.generated.model}` : ""} ·{" "}
      <span className={pf.status === "stale" ? "font-medium text-warn" : "text-pass"}>
        {pf.status === "stale" ? "stale" : "current"}
      </span>
    </span>
  );
}

function linkLabel(item: ShotSequenceItem, codeOf: (id: string | null) => string) {
  const l = item.link;
  if (l.status === "synced") return null;
  return l.status === "missing"
    ? `stores no previous Shot (sequence: ${codeOf(l.expectedPreviousShotId)})`
    : `stores previous ${codeOf(l.storedPreviousShotId)} (sequence: ${codeOf(l.expectedPreviousShotId)})`;
}

function SequenceCard({
  item,
  incoming,
  assets,
  slug,
  episodeSlug,
  compareHref,
  codeOf,
}: {
  item: ShotSequenceItem;
  incoming: ShotSequenceTransition | null;
  assets: Assets;
  slug: string;
  episodeSlug: string;
  compareHref: string | null;
  codeOf: (id: string | null) => string;
}) {
  const reviewCount = incoming?.changes.filter((c) => c.severity === "change").length ?? 0;
  const mismatch = linkLabel(item, codeOf);
  const issue = item.integrityIssues.length > 0 || item.link.status !== "synced";
  return (
    <article
      data-testid="sequence-card"
      data-shot-code={item.shotCode}
      data-health={item.health}
      data-visual-kind={item.visual.kind}
      data-pf-status={item.productionFrame?.status ?? "missing"}
      data-link-status={item.link.status}
      data-needs-pf={String(!item.productionFrame)}
      data-stale={String(item.visual.freshness === "stale")}
      data-issue={String(issue)}
      aria-label={`Shot ${item.shotCode}`}
      className={cn(
        "border bg-panel",
        item.integrityIssues.length > 0
          ? "border-fail/60"
          : item.link.status !== "synced"
            ? "border-warn/60"
            : "border-line",
      )}
    >
      <div className="flex min-h-[26px] flex-wrap items-center gap-1.5 border-b border-line px-2 py-1 pr-8 text-[10.5px] text-muted">
        {incoming ? (
          <>
            <span className="font-mono">← {incoming.fromShotCode}</span>
            {incoming.crossesScene ? <Badge tone="neutral">new scene</Badge> : null}
            {incoming.linkStatus !== "synced" ? (
              <Badge tone="fail">
                <span data-testid="sequence-link-mismatch">link mismatch</span>
              </Badge>
            ) : null}
            {reviewCount > 0 ? (
              <span>
                {reviewCount} change{reviewCount === 1 ? "" : "s"} to review
              </span>
            ) : (
              <span>no changes</span>
            )}
            {compareHref ? (
              <Link
                href={compareHref}
                data-testid="sequence-compare-link"
                className="ml-auto text-info hover:underline"
                aria-label={`Compare ${incoming.fromShotCode} with ${item.shotCode}`}
              >
                Compare
              </Link>
            ) : null}
          </>
        ) : (
          <span>First Shot of the episode</span>
        )}
      </div>
      <SequenceVisual item={item} assets={assets} />
      <div className="space-y-1.5 px-2.5 py-2 text-[11.5px]">
        <div className="flex items-center justify-between gap-2">
          <Link
            href={shotPath(slug, episodeSlug, item.shotId)}
            className="min-w-0 truncate text-[12px] hover:underline"
          >
            <span className="mr-1.5 font-mono text-accent">{item.shotCode}</span>
            {item.title}
          </Link>
          <span className="shrink-0 font-mono text-[11px]">{formatSeconds(item.durationMs)}</span>
        </div>
        <StaleDetails item={item} />
        <dl className="grid grid-cols-[88px_1fr] gap-x-2 gap-y-0.5">
          <dt className="text-muted">Prod. Frame</dt>
          <dd data-testid="sequence-pf-status">{pfLine(item)}</dd>
          <dt className="text-muted">Location</dt>
          <dd data-testid="sequence-location">
            {item.location?.name ?? <span className="text-faint">none</span>}
          </dd>
          <dt className="text-muted">View</dt>
          <dd data-testid="sequence-location-view">
            {item.locationView?.name ?? <span className="text-faint">none</span>}
          </dd>
          <dt className="text-muted">Characters</dt>
          <dd>
            <CharacterLines item={item} />
          </dd>
        </dl>
        {mismatch ? (
          <p className="text-warn" data-testid="sequence-card-link">
            Continuity link: {mismatch}
          </p>
        ) : null}
        {item.integrityIssues.length > 0 ? (
          <ul className="space-y-0.5 text-fail" data-testid="sequence-integrity">
            {item.integrityIssues.map((i, k) => (
              <li key={k}>⛔ {i.message}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={STATUS_TONE[item.status]}>{item.status}</Badge>
          {item.health === "integrity_blocked" ? (
            <Badge tone="fail">{SEQUENCE_HEALTH_LABEL[item.health]}</Badge>
          ) : null}
          {item.preflightBlockers > 0 ? (
            <Badge tone="warn">
              {item.preflightBlockers} preflight blocker{item.preflightBlockers === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-3 pt-0.5 text-[11px]">
          <Link href={shotPath(slug, episodeSlug, item.shotId)} className="text-info hover:underline">
            Open Shot Prep
          </Link>
          {item.health !== "current_production_frame" ? (
            <Link
              href={shotPath(slug, episodeSlug, item.shotId, "production_frame")}
              className="text-info hover:underline"
            >
              {item.productionFrame ? "Production Frame" : "Make Production Frame"}
            </Link>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function SummaryBar({ seq }: { seq: ShotSequence }) {
  const s = seq.summary;
  const stats: Array<[string, string | number, "pass" | "warn" | "fail" | "neutral", string]> = [
    ["Shots", s.shots, "neutral", "shots"],
    ["Current Production Frames", s.currentProductionFrames, "pass", "current"],
    [
      "Stale Production Frames",
      s.staleProductionFrames,
      s.staleProductionFrames ? "warn" : "neutral",
      "stale",
    ],
    [
      "Missing Production Frames",
      s.missingProductionFrames,
      s.missingProductionFrames ? "warn" : "neutral",
      "missing",
    ],
    ["Storyboard-only Shots", s.storyboardOnlyShots, "neutral", "storyboard-only"],
    [
      "Continuity-link mismatches",
      s.linkMismatches,
      s.linkMismatches ? "fail" : "neutral",
      "link-mismatches",
    ],
    [
      "Integrity blockers",
      s.integrityBlockedShots,
      s.integrityBlockedShots ? "fail" : "neutral",
      "integrity",
    ],
    ["Episode runtime", formatDuration(s.runtimeMs), "neutral", "runtime"],
  ];
  return (
    <dl
      data-testid="sequence-summary"
      className="grid gap-px border border-line bg-line [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]"
    >
      {stats.map(([label, value, tone, key]) => (
        <div key={key} className="bg-panel px-3 py-2">
          <dt className="text-[10.5px] uppercase tracking-wide text-muted">{label}</dt>
          <dd
            data-testid={`sequence-summary-${key}`}
            className={cn(
              "font-mono text-[16px]",
              tone === "pass" && "text-pass",
              tone === "warn" && "text-warn",
              tone === "fail" && "text-fail",
            )}
          >
            {value}
          </dd>
        </div>
      ))}
      <div className="bg-panel px-3 py-2 text-[11px] text-muted [grid-column:1/-1]">
        Visual readiness only. Full generation readiness stays in each Shot&apos;s Preflight.
      </div>
    </dl>
  );
}

function SyncPanel({
  data,
  episode,
  changes,
  previewKey,
}: {
  data: ProjectData;
  episode: Episode;
  changes: SequenceLinkChange[];
  previewKey: string;
}) {
  if (changes.length === 0) return null;
  const locked = changes.filter((c) => c.locked);
  const n = changes.length;
  return (
    <section data-testid="sequence-sync" className="border border-warn/40 bg-warn/5 p-3 text-[12px]">
      <h2 className="font-semibold">
        {n} continuity link{n === 1 ? "" : "s"} differ{n === 1 ? "s" : ""} from the sequence order
      </h2>
      <p className="mt-0.5 text-muted">
        Reordering never changes a Shot&apos;s stored previous Shot. Sync them here only if the new order is
        what each Shot should continue from.
      </p>
      <details className="mt-2" data-testid="sequence-sync-preview">
        <summary className="cursor-pointer text-info hover:underline">
          Review {n} link change{n === 1 ? "" : "s"} ▾
        </summary>
        <div className="mt-2 space-y-2">
          <p className="font-medium">
            {n} continuity link{n === 1 ? "" : "s"} will change:
          </p>
          <ul className="space-y-0.5 font-mono text-[11.5px]" data-testid="sequence-sync-changes">
            {changes.map((c) => (
              <li key={c.shotId} data-shot-code={c.shotCode}>
                {c.shotCode}: {c.fromPreviousShotCode ?? "none"} →{" "}
                {c.toPreviousShotCode ?? "none (first Shot)"}
                {c.locked ? <span className="ml-2 text-fail">🔒 locked</span> : null}
              </li>
            ))}
          </ul>
          <p className="text-warn">
            Changing these links changes Shot continuity truth and may make existing Storyboard Frames,
            Production Frames and generations stale. Nothing else changes: order, Characters, Looks, Location
            and frames stay as they are.
          </p>
          {locked.length > 0 ? (
            <p role="alert" className="text-fail" data-testid="sequence-sync-locked">
              Locked Shot{locked.length === 1 ? "" : "s"} {locked.map((c) => c.shotCode).join(", ")} would
              need {locked.length === 1 ? "its" : "their"} link changed, so the sync is refused as a whole.
              Unlock {locked.length === 1 ? "it" : "them"} first, or keep the current links.
            </p>
          ) : (
            <ActionForm action={syncSequenceContinuityLinks} successMessage="">
              <input type="hidden" name="projectSlug" value={data.project.slug} />
              <input type="hidden" name="episodeId" value={episode.id} />
              <input type="hidden" name="previewKey" value={previewKey} />
              <Button type="submit" variant="primary" data-testid="sequence-sync-confirm">
                Confirm: sync {n} link{n === 1 ? "" : "s"}
              </Button>
            </ActionForm>
          )}
        </div>
      </details>
    </section>
  );
}

function FactList({ facts, empty }: { facts: TransitionFact[]; empty: string }) {
  if (facts.length === 0) return <p className="text-faint">{empty}</p>;
  return (
    <ul className="space-y-0.5">
      {facts.map((f, i) => (
        <li
          key={i}
          data-category={f.category}
          data-severity={f.severity}
          className={
            f.severity === "error" ? "text-fail" : f.severity === "change" ? "text-fg" : "text-muted"
          }
        >
          {f.severity === "error" ? "⛔ " : f.severity === "change" ? "△ " : "= "}
          {f.message}
        </li>
      ))}
    </ul>
  );
}

function ShotFacts({ item }: { item: ShotSequenceItem }) {
  const pf = item.productionFrame;
  return (
    <dl className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-0.5 text-[11.5px]">
      <dt className="text-muted">Image</dt>
      <dd>
        {VISUAL_BADGE[item.visual.kind].label}
        {item.visual.version ? ` v${item.visual.version}` : ""}
        {item.visual.freshness === "stale" ? " · stale" : item.visual.freshness === "fresh" ? " · fresh" : ""}
      </dd>
      <dt className="text-muted">Prod. Frame</dt>
      <dd>{pf ? `v${pf.version} · ${pf.status}` : "missing"}</dd>
      <dt className="text-muted">Location / View</dt>
      <dd>
        {item.location?.name ?? "none"} / {item.locationView?.name ?? "no View"}
      </dd>
      <dt className="text-muted">Characters</dt>
      <dd>
        <CharacterLines item={item} />
      </dd>
      <dt className="text-muted">Screen direction</dt>
      <dd>{item.continuity.screenDirection || "—"}</dd>
      <dt className="text-muted">Facing</dt>
      <dd>{item.continuity.facingDirection || "—"}</dd>
      <dt className="text-muted">Weather / time</dt>
      <dd>
        {item.continuity.weather || "—"} / {item.continuity.timeOfDay || "—"}
      </dd>
    </dl>
  );
}

/** Larger side-by-side review of one cut (A → B). Pure facts; no AI call. */
function ComparePanel({
  seq,
  transition,
  assets,
  hrefFor,
  closeHref,
  codeOf,
}: {
  seq: ShotSequence;
  transition: ShotSequenceTransition;
  assets: Assets;
  hrefFor: (toShotId: string) => string;
  closeHref: string;
  codeOf: (id: string | null) => string;
}) {
  const a = seq.shots.find((s) => s.shotId === transition.fromShotId)!;
  const b = seq.shots.find((s) => s.shotId === transition.toShotId)!;
  const i = seq.transitions.indexOf(transition);
  const prev = seq.transitions[i - 1];
  const next = seq.transitions[i + 1];
  return (
    <section
      id="compare"
      data-testid="sequence-compare"
      data-from={a.shotCode}
      data-to={b.shotCode}
      aria-label={`Compare ${a.shotCode} and ${b.shotCode}`}
      className="border border-line bg-panel p-3"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-semibold">
          Cut {a.shotCode} → {b.shotCode}
        </h2>
        {transition.crossesScene ? (
          <Badge tone="neutral">
            Scene {a.sceneNumber} → Scene {b.sceneNumber}
          </Badge>
        ) : null}
        <Badge tone={transition.linkStatus === "synced" ? "pass" : "fail"}>
          link {transition.linkStatus === "synced" ? "synced" : "mismatch"}
        </Badge>
        <div className="ml-auto flex gap-3 text-[11.5px]">
          {prev ? (
            <Link href={hrefFor(prev.toShotId)} className="text-info hover:underline">
              ← {prev.fromShotCode} → {prev.toShotCode}
            </Link>
          ) : null}
          {next ? (
            <Link href={hrefFor(next.toShotId)} className="text-info hover:underline">
              {next.fromShotCode} → {next.toShotCode} →
            </Link>
          ) : null}
          <Link href={closeHref} className="text-muted hover:text-fg">
            Close
          </Link>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {[a, b].map((s) => (
          <div key={s.shotId} className="space-y-1.5">
            <div className="text-[12px]">
              <span className="mr-1.5 font-mono text-accent">{s.shotCode}</span>
              {s.title} <span className="text-muted">· Scene {s.sceneNumber}</span>
            </div>
            <SequenceVisual item={s} assets={assets} large />
            <ShotFacts item={s} />
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-3 border-t border-line pt-2 text-[12px] md:grid-cols-2">
        <div>
          <h3 className="mb-1 font-medium">To review</h3>
          <FactList facts={transition.changes} empty="Nothing changes across this cut." />
          {transition.linkStatus !== "synced" ? (
            <p className="mt-1 text-[11px] text-muted">
              {b.shotCode} stores previous Shot {codeOf(transition.storedPreviousShotId)}; the sequence puts{" "}
              {a.shotCode} before it.
            </p>
          ) : null}
        </div>
        <div>
          <h3 className="mb-1 font-medium">Carries over</h3>
          <FactList facts={transition.stable} empty="—" />
        </div>
      </div>
      <p className="mt-2 text-[11px] text-faint">
        Changes are review notes, not failures: a new Location, Look, Lock, direction or weather can be
        intentional. Prism does not judge the 180° rule or run AI analysis here.
      </p>
    </section>
  );
}

export function SequenceView({
  data,
  episode,
  basePath,
  compareShotId = null,
}: {
  data: ProjectData;
  episode: Episode;
  /** this page's URL (with `?ep=` on the project-level route); `compare=` is added to it */
  basePath: string;
  compareShotId?: string | null;
}) {
  const seq = buildShotSequence(data, episode.id);
  const changes = sequenceLinkChanges(data, episode.id);
  const previewKey = sequenceLinkPreviewKey(data, episode.id);
  const assets: Assets = new Map(data.assets.map((a) => [a.id, a]));
  const codeOf = (id: string | null) =>
    id ? (data.shots.find((s) => s.id === id)?.shotCode ?? "(missing)") : "none";
  const incoming = new Map(seq.transitions.map((t) => [t.toShotId, t]));
  const hrefFor = (toShotId: string) => `${withParam(basePath, "compare", toShotId)}#compare`;
  const compared = compareShotId ? (incoming.get(compareShotId) ?? null) : null;

  // Scene groups in the actual order (consecutive Shots of one Scene)
  const groups: Array<{ sceneId: string; sceneNumber: string; slugline: string; items: ShotSequenceItem[] }> =
    [];
  for (const item of seq.shots) {
    const last = groups[groups.length - 1];
    if (last && last.sceneId === item.sceneId) last.items.push(item);
    else
      groups.push({
        sceneId: item.sceneId,
        sceneNumber: item.sceneNumber,
        slugline: item.sceneSlugline,
        items: [item],
      });
  }
  const counts: Record<SequenceFilter, number> = {
    all: seq.shots.length,
    needs_pf: seq.shots.filter((s) => !s.productionFrame).length,
    stale: seq.shots.filter((s) => s.visual.freshness === "stale").length,
    issues: seq.shots.filter((s) => s.integrityIssues.length > 0 || s.link.status !== "synced").length,
  };

  return (
    <div>
      <PageHeader
        title={`Sequence — ${episode.title}`}
        subtitle="Canonical stills in cut order: do these Shots cut together? Derived from Shot Prep; nothing is generated or analysed here."
        actions={
          <Badge tone={seq.summary.missingProductionFrames === 0 ? "pass" : "warn"}>
            {seq.summary.currentProductionFrames}/{seq.summary.shots} current Production Frames
          </Badge>
        }
      />
      <div className="space-y-5 p-4 sm:p-6">
        <SummaryBar seq={seq} />
        <SyncPanel data={data} episode={episode} changes={changes} previewKey={previewKey} />
        {compared ? (
          <ComparePanel
            seq={seq}
            transition={compared}
            assets={assets}
            hrefFor={hrefFor}
            closeHref={basePath}
            codeOf={codeOf}
          />
        ) : null}
        {seq.shots.length === 0 ? (
          <p className="text-muted">This episode has no Shots yet.</p>
        ) : (
          <SequenceFilters counts={counts}>
            <div className="space-y-7">
              {groups.map((g, gi) => {
                const sceneMs = g.items.reduce((t, i) => t + i.durationMs, 0);
                return (
                  <section
                    key={`${g.sceneId}-${gi}`}
                    data-testid="sequence-scene"
                    data-scene-number={g.sceneNumber}
                  >
                    <h2 className="mb-2 text-[12px] font-semibold">
                      Scene {g.sceneNumber} — {g.slugline}
                      <span className="ml-2 font-mono font-normal text-muted">{formatDuration(sceneMs)}</span>
                    </h2>
                    <SortableBoard
                      key={g.items.map((i) => i.shotId).join(",")}
                      sceneId={g.sceneId}
                      projectSlug={data.project.slug}
                      items={g.items.map((i) => ({ id: i.shotId, locked: i.locked }))}
                    >
                      {g.items.map((item) => {
                        const t = incoming.get(item.shotId) ?? null;
                        return (
                          <SequenceCard
                            key={item.shotId}
                            item={item}
                            incoming={t}
                            assets={assets}
                            slug={data.project.slug}
                            episodeSlug={episode.slug}
                            compareHref={t ? hrefFor(item.shotId) : null}
                            codeOf={codeOf}
                          />
                        );
                      })}
                    </SortableBoard>
                  </section>
                );
              })}
            </div>
          </SequenceFilters>
        )}
      </div>
    </div>
  );
}

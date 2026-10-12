import Link from "next/link";
import { Badge, Empty } from "@/components/ui";
import type { PreflightReport } from "@/domain/preflight";
import { STATUS_GLYPH } from "@/domain/preflight";
import type { Episode, ProjectData } from "@/domain/schemas";
import { cn } from "@/lib/utils";

/** Episode switcher used by project-level, episode-scoped pages (?ep=slug). */
export function EpisodeSwitcher({
  data,
  current,
  basePath,
}: {
  data: ProjectData;
  current: Episode;
  basePath: string;
}) {
  if (data.episodes.length <= 1) {
    return (
      <span className="text-muted">
        Episode {current.number} — {current.title}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1">
      {[...data.episodes]
        .sort((a, b) => a.order - b.order)
        .map((e) => (
          <Link
            key={e.id}
            href={`${basePath}?ep=${e.slug}`}
            className={cn(
              "rounded-[3px] border px-2 py-0.5 text-[11.5px]",
              e.id === current.id ? "border-accent/60 text-accent" : "border-line2 text-muted hover:text-fg",
            )}
          >
            Ep {e.number}
          </Link>
        ))}
    </div>
  );
}

export function NoEpisode({ slug }: { slug: string }) {
  return (
    <div className="p-6">
      <Empty>
        No episodes yet.{" "}
        <Link className="text-accent underline" href={`/projects/${slug}/episodes`}>
          Create the first episode
        </Link>
        .
      </Empty>
    </div>
  );
}

export function ReadinessBadge({ report }: { report: PreflightReport }) {
  if (report.ready) {
    return (
      <Badge tone={report.warnings.length ? "warn" : "pass"}>
        {report.warnings.length ? `Ready · ${report.warnings.length} warn` : "Ready"}
      </Badge>
    );
  }
  return (
    <Badge tone="fail">
      {report.blockers.length} blocker{report.blockers.length === 1 ? "" : "s"}
    </Badge>
  );
}

export function ScoreBar({ score }: { score: number }) {
  const tone = score >= 90 ? "bg-pass" : score >= 60 ? "bg-warn" : "bg-fail";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-14 overflow-hidden bg-line2">
        <div className={cn("h-full", tone)} style={{ width: `${score}%` }} />
      </div>
      <span className="font-mono text-[10.5px] text-muted">{score}</span>
    </div>
  );
}

export function PreflightList({ report }: { report: PreflightReport }) {
  const tone: Record<string, string> = {
    pass: "text-pass",
    fail: "text-fail",
    warn: "text-warn",
    na: "text-faint",
  };
  return (
    <ul className="space-y-0.5 font-mono text-[12px]">
      {report.items.map((i) => (
        <li key={i.ruleId} className="flex gap-2">
          <span className={cn("w-4 shrink-0 text-center", tone[i.status])}>{STATUS_GLYPH[i.status]}</span>
          <span
            className={cn(i.status === "na" ? "text-faint" : i.status === "fail" ? "text-fg" : "text-muted")}
          >
            {i.status === "na" && i.detail ? i.detail : i.label}
            {i.status !== "na" && i.status !== "pass" && i.detail ? (
              <span className="text-faint"> — {i.detail}</span>
            ) : null}
            {i.status === "pass" && i.detail ? <span className="text-faint"> — {i.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Stand-in image for frames/assets with no stored file. Shows shot metadata so boards are still readable. */
export function FramePlaceholder({
  code,
  label,
  hint,
  className,
}: {
  code: string;
  label?: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex aspect-[2.39/1] items-end overflow-hidden bg-[repeating-linear-gradient(135deg,#141417,#141417_10px,#101013_10px,#101013_20px)] p-2",
        className,
      )}
    >
      <div className="absolute left-2 top-1.5 font-mono text-[11px] text-faint">{code}</div>
      <div className="text-[10.5px] leading-tight text-faint">
        {label}
        {hint ? <div className="text-[10px] opacity-70">{hint}</div> : null}
      </div>
    </div>
  );
}

import { diffLines, diffStats } from "@/domain/story/diff";

/**
 * Phase 5B-S2: Original vs Proposed, line by line with word-level highlights inside changed lines. Removed text is
 * struck through in red, added text is green. Server-rendered (pure).
 */
export function DiffView({ original, proposed }: { original: string; proposed: string }) {
  const lines = diffLines(original, proposed);
  const stats = diffStats(lines);
  return (
    <div className="space-y-1" data-testid="revision-diff">
      <div className="text-[11px] text-muted">
        {stats.changedLines} line{stats.changedLines === 1 ? "" : "s"} changed · +{stats.added} / −
        {stats.removed} characters
      </div>
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-[3px] border border-line bg-bg p-2 font-mono text-[12px] leading-relaxed">
        {lines.map((l, i) => (
          <div
            key={i}
            className={
              l.op === "add"
                ? "bg-pass/10"
                : l.op === "del"
                  ? "bg-fail/10"
                  : l.op === "change"
                    ? "bg-warn/5"
                    : ""
            }
          >
            <span className="mr-2 select-none text-faint">
              {l.op === "add" ? "+" : l.op === "del" ? "−" : l.op === "change" ? "~" : " "}
            </span>
            {l.segments.map((s, j) =>
              !s.text ? null : s.op === "add" ? (
                <ins key={j} className="bg-pass/25 text-pass no-underline">
                  {s.text}
                </ins>
              ) : s.op === "del" ? (
                <del key={j} className="bg-fail/20 text-fail">
                  {s.text}
                </del>
              ) : (
                <span key={j}>{s.text}</span>
              ),
            )}
            {l.segments.length === 0 || l.segments.every((s) => !s.text) ? " " : null}
          </div>
        ))}
      </pre>
    </div>
  );
}

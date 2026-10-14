import { Badge } from "@/components/ui";

/**
 * Shown wherever a benchmark / synthetic-fixture project's review or model data appears. The classification is
 * an explicit project setting (never guessed from a slug). The data is real and fully usable for testing the
 * tooling; it is just never mixed into production model intelligence.
 */
export function BenchmarkBanner({ compact = false }: { compact?: boolean }) {
  if (compact)
    return (
      <span data-testid="benchmark-badge">
        <Badge tone="warn">TEST / BENCHMARK DATA</Badge>
      </span>
    );
  return (
    <div
      className="flex flex-wrap items-center gap-2 border border-warn/40 bg-panel px-3 py-2 text-[12px]"
      data-testid="benchmark-banner"
      role="note"
    >
      <Badge tone="warn">TEST / BENCHMARK DATA</Badge>
      <span className="text-muted">
        This project is classified as a benchmark / synthetic fixture. Its reviews and winners work normally
        but are excluded from production model performance and routing recommendations.
      </span>
    </div>
  );
}

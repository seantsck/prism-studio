import { Badge } from "@/components/ui";
import { spatialAxisStates, type AxisState } from "@/domain/previs/spatial-workspace";

const TONE: Record<AxisState, "pass" | "warn" | "neutral"> = {
  fresh: "pass",
  stale: "warn",
  unknown: "neutral",
};
const WORD: Record<AxisState, string> = { fresh: "Fresh", stale: "STALE", unknown: "UNKNOWN" };

/**
 * Phase 4C-I2: the compact four-axis status of one Master Frame (Scene · Camera · Blocking · Lighting), presenting a
 * status that was computed elsewhere (by the server for Shot Prep, by the editor against its live saved state in the
 * workspace). It is display only: promotion always recomputes the state on the server.
 */
export function SpatialAxisBadges({
  status,
  testIdPrefix,
}: {
  status: { stale: ReadonlyArray<string>; unknown: ReadonlyArray<string> };
  testIdPrefix: string;
}) {
  return (
    <span className="flex flex-wrap gap-1" data-testid={testIdPrefix}>
      {spatialAxisStates(status).map((a) => (
        <span key={a.axis} data-testid={`${testIdPrefix}-${a.axis}`} data-state={a.state}>
          <Badge tone={TONE[a.state]}>
            {a.label} {WORD[a.state]}
          </Badge>
        </span>
      ))}
    </span>
  );
}

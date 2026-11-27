import { Badge } from "@/components/ui";
import {
  REFERENCE_ORIGIN_LABEL,
  type ReferenceSlot,
  type ShotReferenceIntegrity,
} from "@/domain/generation/reference-integrity";

/**
 * Reference check (before spend): which canonical references this Shot has, where each came from, and whether the
 * selected Production Frame was actually generated from them. Read-only; every fact comes from
 * `shotReferenceIntegrity` (the same function the spend gate uses), so the panel can never disagree with the gate.
 */
const LINEAGE_TONE = {
  none: "neutral",
  verified: "pass",
  partial: "fail",
  unreferenced: "warn",
  unverifiable: "warn",
} as const;

const LINEAGE_LABEL = {
  none: "no frame",
  verified: "verified",
  partial: "references missing",
  unreferenced: "words only",
  unverifiable: "not verifiable",
} as const;

export function ReferenceCheck({ integrity }: { integrity: ShotReferenceIntegrity }) {
  const { slots, lineage } = integrity;
  const consumed = new Set(lineage.consumed.map((s) => s.id));
  const missing = new Set(lineage.missing.map((s) => s.id));
  const inFrame = (s: ReferenceSlot): { text: string; tone: "pass" | "fail" | "neutral" } | null =>
    consumed.has(s.id)
      ? { text: "used to generate this frame", tone: "pass" }
      : missing.has(s.id)
        ? { text: "NOT used to generate this frame", tone: "fail" }
        : null;
  return (
    <section
      className="border border-line p-2"
      data-testid="reference-check"
      data-lineage={lineage.status}
      data-verified={integrity.verified ? "1" : "0"}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Reference check</h4>
        <Badge tone={LINEAGE_TONE[lineage.status]}>{LINEAGE_LABEL[lineage.status]}</Badge>
      </div>
      <p className="mb-1.5 text-[12px] text-muted">
        A video model receives only the Production Frame and a motion prompt. Identity, wardrobe and location
        reach the clip through that frame alone, so this is where they are checked.
      </p>
      {slots.length > 0 ? (
        <ul className="space-y-1 text-[12px]" data-testid="reference-slots">
          {slots.map((s) => {
            const used = inFrame(s);
            return (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
                data-testid="reference-slot"
                data-slot={s.id}
                data-status={s.status}
                data-origin={s.origin ?? ""}
              >
                <Badge tone={s.status === "ready" ? "pass" : "warn"}>
                  {s.status === "ready" ? "image" : "words only"}
                </Badge>
                <span>
                  <span className="text-fg">{s.subject}</span> — {s.label}
                </span>
                {s.origin ? (
                  <span className="text-muted" data-testid="reference-origin">
                    {REFERENCE_ORIGIN_LABEL[s.origin]}
                  </span>
                ) : null}
                {used ? <Badge tone={used.tone}>{used.text}</Badge> : null}
                <span className="basis-full text-[11px] text-faint">{s.detail}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[12px] text-muted">This Shot has no Actor or Location to reference.</p>
      )}
      <p
        className={`mt-1.5 text-[12px] ${
          lineage.status === "partial"
            ? "text-fail"
            : lineage.status === "verified"
              ? "text-pass"
              : "text-muted"
        }`}
        data-testid="reference-lineage"
      >
        {lineage.message}
      </p>
    </section>
  );
}

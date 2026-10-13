import type { BriefSection } from "@/domain/generation-package";
import type { PromptPlan } from "@/domain/generation/schemas";
import type { CompiledRequestSummary } from "@/generation/provider";

/**
 * The three layers kept deliberately separate:
 *   1. Production Generation Brief  (what the filmmaker decided: the frozen GenerationPackage)
 *   2. Normalized PromptPlan        (provider-independent sections)
 *   3. Provider-compiled request    (what an adapter would send, summarized: no secrets, no signed URLs)
 */
export function PromptInspector({
  brief,
  plan,
  compiled,
  heading = "Prompt inspector",
}: {
  brief: BriefSection[] | null;
  plan: PromptPlan | null;
  compiled: CompiledRequestSummary | null;
  heading?: string;
}) {
  return (
    <details className="border border-line bg-panel" data-testid="prompt-inspector">
      <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-fg">
        {heading}
      </summary>
      <div className="grid gap-3 border-t border-line p-3 xl:grid-cols-3">
        <section>
          <h4 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-accent">
            1 · Production brief
          </h4>
          <div className="scroll-thin max-h-80 space-y-2 overflow-auto border border-line bg-bg p-2">
            {brief ? (
              brief.map((s) => (
                <div key={s.title}>
                  <div className="text-[10.5px] font-semibold uppercase text-muted">{s.title}</div>
                  {s.lines.map((l, i) => (
                    <div key={i} className="whitespace-pre-wrap text-[11.5px]">
                      {l}
                    </div>
                  ))}
                </div>
              ))
            ) : (
              <span className="text-muted">Not available.</span>
            )}
          </div>
        </section>
        <section>
          <h4 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-accent">
            2 · PromptPlan
          </h4>
          <div className="scroll-thin max-h-80 space-y-2 overflow-auto border border-line bg-bg p-2">
            {plan ? (
              plan.sections.map((s) => (
                <div key={s.key}>
                  <div className="text-[10.5px] font-semibold uppercase text-muted">{s.title}</div>
                  {s.lines.map((l, i) => (
                    <div key={i} className="text-[11.5px]">
                      {l}
                    </div>
                  ))}
                </div>
              ))
            ) : (
              <span className="text-muted">No plan (legacy attempt).</span>
            )}
          </div>
        </section>
        <section>
          <h4 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-accent">
            3 · Provider request (summary)
          </h4>
          <div className="scroll-thin max-h-80 overflow-auto border border-line bg-bg p-2">
            {compiled ? (
              <>
                <div className="font-mono text-[11px] text-info">{compiled.endpoint}</div>
                <pre className="mt-1 whitespace-pre-wrap font-mono text-[10.5px] text-muted">
                  {JSON.stringify(compiled.fields, null, 2)}
                </pre>
                {compiled.attachments.length > 0 ? (
                  <ul className="mt-2 space-y-0.5 text-[11px]">
                    {compiled.attachments.map((a, i) => (
                      <li key={i}>
                        <span className="font-mono text-muted">{a.role}</span>{" "}
                        {a.note ?? a.assetId.slice(0, 8)}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {compiled.notes.map((n, i) => (
                  <p key={i} className="mt-2 text-[10.5px] text-faint">
                    {n}
                  </p>
                ))}
              </>
            ) : (
              <span className="text-muted">Choose a compatible model to see its compiled request.</span>
            )}
          </div>
        </section>
      </div>
    </details>
  );
}

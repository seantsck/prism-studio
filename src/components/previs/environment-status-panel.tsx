"use client";

import {
  ENVIRONMENT_OPERATION_LABEL,
  environmentReport,
  type OperationState,
} from "@/domain/previs/environment-capability";
import type { SceneObjectView } from "@/lib/previs/scene-adapter";

const STATE_LABEL: Record<OperationState, string> = {
  available: "Available",
  limited: "Limited",
  unavailable: "Unavailable",
};
const STATE_TONE: Record<OperationState, string> = {
  available: "text-pass",
  limited: "text-warn",
  unavailable: "text-fail",
};

/**
 * Phase 4E: what this Set's Gaussian-splat environment supports, derived live from the working scene. Renders nothing
 * when the Set has no splat, so sets without one (and every image-first flow) look exactly as before.
 */
export function EnvironmentStatusPanel(props: { objects: SceneObjectView[] }) {
  const report = environmentReport(props.objects);
  if (!report) return null;
  return (
    <section
      className="mb-3 rounded border border-line p-2 text-xs"
      data-testid="environment-status"
      data-status={report.status}
      data-scale={report.scale}
    >
      <h2 className="mb-1 uppercase tracking-wide text-muted">Environment</h2>
      <div
        className={`mb-1.5 font-medium ${report.status === "needs_attention" ? "text-fail" : ""}`}
        data-testid="environment-status-label"
      >
        {report.label}
      </div>
      {report.issues.map((issue) => (
        <p
          key={issue.code}
          role="alert"
          className="mb-1 text-fail"
          data-testid="environment-issue"
          data-code={issue.code}
        >
          {issue.message}
        </p>
      ))}
      <ul className="space-y-1">
        {report.operations.map((op) => (
          <li
            key={op.operation}
            data-testid={`environment-op-${op.operation.replaceAll("_", "-")}`}
            data-state={op.state}
          >
            <span className="font-medium">{ENVIRONMENT_OPERATION_LABEL[op.operation]}</span>{" "}
            <span className={STATE_TONE[op.state]}>· {STATE_LABEL[op.state]}</span>
            {op.operation === "save" && op.state === "unavailable" ? null : (
              <div className="text-muted">{op.note}</div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

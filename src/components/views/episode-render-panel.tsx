import { ActionForm } from "@/components/action-form";
import { Badge, Button } from "@/components/ui";
import { requestEpisodeRender, retryEpisodeRender } from "@/server/episode-render-actions";
import type { EditTarget } from "./episode-edit-controls";
import type { RenderPanelVM, RenderRowVM } from "./episode-render-model";
import { RenderAutoRefresh } from "./episode-render-refresh";

/**
 * Phase 5B-V4 "Render Episode" on the Episode Edit page: what a render of the current SAVED revision will be, the one
 * explicit Render button, and every render of this Episode with its live state (Queued → Rendering → Assembling →
 * Verifying → Completed / Failed). A finished render plays here and downloads through the private asset route. A render
 * of an earlier revision stays available, labelled with its revision.
 */

const sectionTitle = "text-[11px] font-semibold uppercase tracking-[0.08em] text-muted";
const TONE: Record<string, "neutral" | "pass" | "warn" | "fail" | "info" | "accent"> = {
  queued: "neutral",
  rendering_segments: "info",
  assembling: "info",
  verifying: "info",
  completed: "pass",
  failed: "fail",
  cancelled: "neutral",
};

export function RenderPanel({
  target,
  projectSlug,
  vm,
}: {
  target: EditTarget;
  projectSlug: string;
  vm: RenderPanelVM;
}) {
  return (
    <section className="space-y-3 border border-line bg-panel p-3" data-testid="render-panel">
      <RenderAutoRefresh active={vm.anyActive} />
      <div className="flex flex-wrap items-center gap-2">
        <h2 className={sectionTitle}>Render Episode</h2>
        <span className="text-[11px] text-faint">Final MP4 of a saved Edit revision · segmented render</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]" data-testid="render-facts">
        <dt className="text-faint">Edit revision</dt>
        <dd data-testid="render-fact-revision">
          {vm.savedAs != null ? `Saved revision #${vm.savedAs}` : "Unsaved changes"} (working revision{" "}
          {vm.editRevision})
        </dd>
        <dt className="text-faint">Duration</dt>
        <dd data-testid="render-fact-duration" data-ms={vm.durationMs}>
          {vm.duration}
        </dd>
        <dt className="text-faint">Segments</dt>
        <dd data-testid="render-fact-segments">
          {vm.visualSegments} visual items → {vm.renderSegments} render segments
        </dd>
        <dt className="text-faint">Missing media</dt>
        <dd data-testid="render-fact-missing" className={vm.missing.length ? "text-fail" : "text-pass"}>
          {vm.missing.length ? vm.missing.join(", ") : "None"}
        </dd>
        <dt className="text-faint">Target</dt>
        <dd data-testid="render-fact-target">{vm.target}</dd>
        <dt className="text-faint">Format</dt>
        <dd>{vm.format}</dd>
        <dt className="text-faint">Estimated cost</dt>
        <dd data-testid="render-fact-cost">{vm.cost}</dd>
      </dl>
      <ActionForm
        action={requestEpisodeRender}
        successMessage=""
        className="flex flex-wrap items-center gap-2"
      >
        <input type="hidden" name="projectSlug" value={target.projectSlug} />
        <input type="hidden" name="editId" value={target.editId} />
        <input type="hidden" name="expectedRevision" value={target.revision} />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!vm.canRender}
          data-testid="render-episode"
        >
          Render Episode
        </Button>
        {vm.blockedReason ? (
          <span className="text-[11.5px] text-warn" data-testid="render-blocked">
            {vm.blockedReason}
          </span>
        ) : null}
      </ActionForm>
      {vm.renders.length ? (
        <ol className="space-y-2" data-testid="render-list">
          {[...vm.renders].reverse().map((r) => (
            <RenderRow key={r.id} r={r} projectSlug={projectSlug} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function RenderRow({ r, projectSlug }: { r: RenderRowVM; projectSlug: string }) {
  return (
    <li
      className="space-y-1.5 border border-line2 p-2 text-[11.5px]"
      data-testid="episode-render"
      data-number={r.number}
      data-status={r.status}
      data-edit-revision={r.editRevision}
      data-saved-revision={r.savedRevisionNumber ?? ""}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-medium">Render #{r.number}</span>
        <span data-testid="render-status">
          <Badge tone={TONE[r.status] ?? "neutral"}>{r.statusLabel}</Badge>
        </span>
        {r.progress ? (
          <span className="text-muted" data-testid="render-progress">
            {r.progress}
          </span>
        ) : null}
        <span className="text-faint" data-testid="render-revision">
          Rendered from Edit revision #{r.savedRevisionNumber ?? r.editRevision}
        </span>
        {r.newerRevisionExists ? (
          <span data-testid="render-newer">
            <Badge tone="neutral">A newer Edit revision exists.</Badge>
          </span>
        ) : null}
      </div>
      {r.error ? (
        <div className="flex flex-wrap items-center gap-2 text-fail" data-testid="render-error">
          <span>{r.error}</span>
          <ActionForm action={retryEpisodeRender} successMessage="" quiet>
            <input type="hidden" name="projectSlug" value={projectSlug} />
            <input type="hidden" name="renderId" value={r.id} />
            <Button type="submit" size="sm" data-testid="render-retry">
              Retry
            </Button>
          </ActionForm>
        </div>
      ) : null}
      {r.output ? (
        <div className="space-y-1.5" data-testid="render-output" data-asset-id={r.output.assetId}>
          <video
            controls
            preload="metadata"
            src={r.output.url}
            className="w-full max-w-[720px] bg-black"
            data-testid="render-video"
            data-duration-ms={r.output.durationMs}
          >
            <track kind="captions" />
          </video>
          <div className="flex flex-wrap items-center gap-3">
            <span data-testid="render-output-duration">{r.output.duration}</span>
            <span data-testid="render-output-resolution">{r.output.resolution}</span>
            <span>{r.output.frameRate} fps</span>
            <span>{r.output.codecs}</span>
            <span data-testid="render-output-size">{r.output.size}</span>
            <a
              href={r.output.downloadUrl}
              download={r.output.filename}
              className="text-accent hover:underline"
              data-testid="render-download"
            >
              Download {r.output.filename}
            </a>
          </div>
          <details className="text-[11px]" data-testid="render-advanced">
            <summary className="cursor-pointer text-muted">Advanced</summary>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 font-mono text-[10.5px]">
              <dt className="text-faint">checksum</dt>
              <dd data-testid="render-checksum">{r.output.checksum}</dd>
              <dt className="text-faint">profile</dt>
              <dd>{r.output.profile}</dd>
              <dt className="text-faint">manifest</dt>
              <dd>{r.output.manifestFingerprint}</dd>
              <dt className="text-faint">segments</dt>
              <dd>{r.output.segments}</dd>
            </dl>
          </details>
        </div>
      ) : null}
    </li>
  );
}

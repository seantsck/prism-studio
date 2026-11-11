import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button } from "@/components/ui";
import type { ShotContext } from "@/domain/context";
import type { GenerationPackage } from "@/domain/generation-package";
import { buildPromptPlan, renderPromptPlan } from "@/domain/generation/prompt-plan";
import { NEGATIVE_LABELS, NEGATIVE_TAGS } from "@/domain/generation/reviews";
import {
  clipDurationChoices,
  SHOT_CLIP_EARLIER_FRAME,
  SHOT_CLIP_NO_FRAME,
  shotClips,
  videoInputs,
} from "@/domain/generation/video-inputs";
import type { GenerationModel } from "@/domain/generation/schemas";
import type { ProjectData } from "@/domain/schemas";
import { assetUrl } from "@/lib/utils";
import { promoteCandidate, reviewCandidate } from "@/server/candidate-actions";
import { generateClipAlternative, setShotClipDuration } from "@/server/video-actions";

/**
 * Phase 5B-V1: Video Inputs (what the animation will start from and do) and the Shot Clip (the Shot's selected video,
 * its alternatives, their lineage and freshness). Everything is read from the same frozen package / attempts the 2H
 * Animate workflow uses: the canonical Production Frame stays the exact first frame; nothing here generates.
 */
const secs = (ms: number) => `${Number((ms / 1000).toFixed(2))} seconds`;

export function ShotClipPanel({
  data,
  ctx,
  pkg,
  models,
  candidateSetOf,
}: {
  data: ProjectData;
  ctx: ShotContext;
  pkg: GenerationPackage;
  models: GenerationModel[];
  /** attempt id → its animation candidate set id */
  candidateSetOf: Map<string, string>;
}) {
  const slug = data.project.slug;
  const shotId = ctx.shot.id;
  const vi = videoInputs(ctx, pkg, data.attempts);
  const clips = shotClips(ctx, data.attempts).filter((c) => c.attempt.status === "succeeded");
  const current = clips.find((c) => c.selected) ?? null;
  const durations = clipDurationChoices(models);
  const prompt = renderPromptPlan(buildPromptPlan(pkg, null, { purpose: "animate_production_frame" }));
  const assetOf = (id: string | null) => (id ? data.assets.find((a) => a.id === id) : undefined);

  return (
    <div className="space-y-3">
      <section className="border border-line p-2" data-testid="video-inputs">
        <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Video Inputs</h4>
        {!vi.firstFrame ? (
          <p className="text-[12px] text-fail" data-testid="video-inputs-no-frame">
            {SHOT_CLIP_NO_FRAME}
          </p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            <dt className="text-muted">First Frame</dt>
            <dd data-testid="video-inputs-first-frame">
              {vi.firstFrame.label}
              {vi.firstFrame.width ? ` · ${vi.firstFrame.width}×${vi.firstFrame.height}` : ""}
              {vi.firstFrame.image === "production_conform" ? " · production conform" : ""}
            </dd>
            <dt className="text-muted">Action</dt>
            <dd data-testid="video-inputs-action">{vi.action.join(" — ") || "As in the Production Frame"}</dd>
            <dt className="text-muted">Camera</dt>
            <dd data-testid="video-inputs-camera">{vi.camera}</dd>
            <dt className="text-muted">Performance</dt>
            <dd data-testid="video-inputs-performance">{vi.performance.join(" · ") || "—"}</dd>
            <dt className="text-muted">Continuity</dt>
            <dd data-testid="video-inputs-continuity">{vi.continuity.join(" · ") || "—"}</dd>
            <dt className="text-muted">Duration</dt>
            <dd data-testid="video-inputs-duration">
              {vi.durationMs > 0 ? secs(vi.durationMs) : "not set"}
              {durations.length ? (
                <ActionForm
                  action={setShotClipDuration}
                  quiet
                  className="ml-2 inline-flex items-center gap-1"
                >
                  <input type="hidden" name="projectSlug" value={slug} />
                  <input type="hidden" name="shotId" value={shotId} />
                  <select
                    name="durationMs"
                    defaultValue={String(vi.durationMs)}
                    aria-label="Clip duration"
                    data-testid="clip-duration"
                  >
                    {durations.map((d) => (
                      <option key={d} value={d}>
                        {d / 1000}s
                      </option>
                    ))}
                  </select>
                  <Button size="sm" type="submit">
                    Set
                  </Button>
                </ActionForm>
              ) : null}
            </dd>
          </dl>
        )}
        <details className="mt-1.5 text-[11px] text-faint">
          <summary className="cursor-pointer">Advanced</summary>
          <div className="mt-1 space-y-1 font-mono">
            {vi.firstFrame ? (
              <div data-testid="video-inputs-asset">
                first frame asset {vi.firstFrame.assetId} · sha256 {vi.firstFrame.checksum ?? "unknown"}
              </div>
            ) : null}
            <div>
              aspect ratio {pkg.style.aspectRatio || "—"} · duration {vi.durationMs} ms
            </div>
            <pre className="whitespace-pre-wrap" data-testid="video-inputs-prompt">
              {prompt}
            </pre>
          </div>
        </details>
      </section>

      <section className="border border-line p-2" data-testid="shot-clip">
        <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Shot Clip</h4>
        {current ? (
          <div className="space-y-1" data-testid="shot-clip-current" data-attempt={current.attempt.id}>
            <video
              controls
              src={assetUrl(assetOf(current.attempt.outputAssetId)) ?? undefined}
              className="w-full"
              data-testid="shot-clip-video"
            />
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <Badge tone="pass">Shot Clip</Badge>
              <span className="text-muted">
                from Production Frame v{current.provenance.version ?? "?"} · {current.attempt.provider}/
                {current.attempt.model}
              </span>
              {current.fromEarlierFrame ? <Badge tone="warn">{SHOT_CLIP_EARLIER_FRAME}</Badge> : null}
              {current.freshness.status !== "fresh" ? (
                <span data-testid="shot-clip-stale">
                  <Badge tone="warn">
                    Needs review: {current.freshness.messages.join(" · ") || "inputs unverifiable"}
                  </Badge>
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-[12px] text-muted">No Shot Clip yet. Animate, then choose Use as Shot Clip.</p>
        )}
        {clips.length ? (
          <ul className="mt-2 space-y-2" data-testid="shot-clip-candidates">
            {clips.map((c) => {
              const setId = candidateSetOf.get(c.attempt.id) ?? "";
              const note = (c.attempt.modelSettings as { creatorDirection?: { text?: string } })
                .creatorDirection?.text;
              return (
                <li
                  key={c.attempt.id}
                  className="space-y-1 border border-line p-2 text-[12px]"
                  data-testid="shot-clip-candidate"
                  data-attempt={c.attempt.id}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">#{c.attempt.attemptNumber}</span>
                    <span>
                      {c.attempt.provider}/{c.attempt.model}
                    </span>
                    {note ? <span className="text-muted">“{note}”</span> : null}
                    {c.selected ? <Badge tone="pass">Shot Clip</Badge> : null}
                    {c.attempt.reviewStatus === "rejected" ? <Badge tone="fail">rejected</Badge> : null}
                    {c.fromEarlierFrame ? <Badge tone="warn">{SHOT_CLIP_EARLIER_FRAME}</Badge> : null}
                    {c.freshness.status !== "fresh" && !c.fromEarlierFrame ? (
                      <Badge tone="warn">needs review</Badge>
                    ) : null}
                  </div>
                  <details>
                    <summary className="cursor-pointer text-muted">Play</summary>
                    <video
                      controls
                      src={assetUrl(assetOf(c.attempt.outputAssetId)) ?? undefined}
                      className="mt-1 w-full"
                      data-testid="shot-clip-play"
                    />
                  </details>
                  <div className="flex flex-wrap items-center gap-2">
                    {!c.selected && setId ? (
                      <ActionForm
                        action={promoteCandidate}
                        quiet={false}
                        successMessage="Shot Clip selected"
                        className="flex items-center gap-1.5"
                      >
                        <input type="hidden" name="projectSlug" value={slug} />
                        <input type="hidden" name="setId" value={setId} />
                        <input type="hidden" name="attemptId" value={c.attempt.id} />
                        <input type="hidden" name="confirm" value="1" />
                        {current ? (
                          <label className="flex items-center gap-1 text-[11px] text-warn">
                            <input
                              type="checkbox"
                              name="confirmReplace"
                              value="1"
                              data-testid="confirm-replace-clip"
                            />{" "}
                            replace the current Shot Clip
                          </label>
                        ) : null}
                        <Button size="sm" variant="primary" type="submit" data-testid="use-as-shot-clip">
                          Use as Shot Clip
                        </Button>
                      </ActionForm>
                    ) : null}
                    {!c.selected && c.attempt.reviewStatus !== "rejected" ? (
                      <ActionForm action={reviewCandidate} quiet className="flex items-center gap-1">
                        <input type="hidden" name="projectSlug" value={slug} />
                        <input type="hidden" name="attemptId" value={c.attempt.id} />
                        <input type="hidden" name="decision" value="reject" />
                        <select name="negative" aria-label="Reject reason" defaultValue="camera_motion">
                          {NEGATIVE_TAGS.map((t) => (
                            <option key={t} value={t}>
                              {NEGATIVE_LABELS[t]}
                            </option>
                          ))}
                        </select>
                        <Button size="sm" variant="danger" type="submit" data-testid="reject-clip">
                          Reject
                        </Button>
                      </ActionForm>
                    ) : null}
                    {setId ? (
                      <Link className="text-accent" href={`/projects/${slug}/candidates/${setId}`}>
                        Review in candidates
                      </Link>
                    ) : null}
                  </div>
                  {vi.ready ? (
                    <ActionForm action={generateClipAlternative} quiet={false} className="flex gap-1.5">
                      <input type="hidden" name="projectSlug" value={slug} />
                      <input type="hidden" name="attemptId" value={c.attempt.id} />
                      <input
                        name="motionNote"
                        aria-label="Alternative motion"
                        placeholder="Less movement. Yumeko only glances toward Sean."
                        className="min-w-0 flex-1"
                      />
                      <Button size="sm" type="submit" data-testid="generate-alternative">
                        Generate Alternative
                      </Button>
                    </ActionForm>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

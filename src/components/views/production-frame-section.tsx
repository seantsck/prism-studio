import { ActionForm } from "@/components/action-form";
import { LocationViewSpecFields } from "@/components/location-views/location-view-ui";
import { Badge, Button, Field } from "@/components/ui";
import type { ShotContext } from "@/domain/context";
import { PART_LABELS } from "@/domain/fingerprint";
import {
  assetPromotionStatus,
  PRODUCTION_FRAME_SOURCE_LABEL,
  storyboardPromotionStatus,
  productionFrameFreshness,
  productionFrameToViewStatus,
  shotProductionAspect,
  type ProductionFrame,
} from "@/domain/production-frame";
import { assetUrl } from "@/lib/utils";
import { saveProductionFrameAsLocationView } from "@/server/location-view-actions";
import {
  promoteMasterFrame,
  promoteStoryboardFrame,
  selectProductionFrame,
  uploadProductionFrame,
} from "@/server/production-frame-actions";

/** An optional 3D Master Frame of this Shot (read from the previs repository by the page; absent without 3D). */
export interface MasterFrameChoice {
  id: string;
  assetId: string;
  capturedAt: string;
  width: number;
  height: number;
}

const stamp = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

function FreshnessBadge({ status }: { status: "fresh" | "stale" | "missing" }) {
  return status === "stale" ? (
    <Badge tone="warn">stale</Badge>
  ) : status === "fresh" ? (
    <Badge tone="pass">fresh</Badge>
  ) : null;
}

/**
 * Shot Prep → Production Frame (Phase 2G.1). The Shot's canonical approved still, its immutable history, and the three
 * ways to make one: promote the approved Storyboard, promote an optional 3D Master Frame, or upload an image. Nothing
 * here needs a 3D set, a GPU or a generation model. Images are shown through the private asset route only; no Storage
 * path or signed URL is rendered or persisted.
 */
export function ProductionFrameSection({
  ctx,
  slug,
  masterFrames,
  candidates,
  openHref,
}: {
  ctx: ShotContext;
  slug: string;
  masterFrames: MasterFrameChoice[];
  /** Where "Generate candidates" opens the planner when it is not rendered inline. */
  openHref?: string;
  /**
   * Phase 2G.2: the "Generate candidates" panel (image models, candidate sets), rendered by the page because it reads
   * generation state. Absent in tests of this section alone.
   */
  candidates?: React.ReactNode;
}) {
  const shotId = ctx.shot.id;
  const selected = ctx.selectedProductionFrame;
  const aspect = shotProductionAspect(ctx.shot, ctx.bible);
  const freshOf = (f: ProductionFrame) => productionFrameFreshness(ctx, f);
  const selectedFresh = selected ? freshOf(selected) : null;
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="shotId" value={shotId} />
    </>
  );

  // can the approved Storyboard's image become a Production Frame? (by the same rules the server applies)
  const sbFrame = ctx.approvedFrame;
  const sbCheck = storyboardPromotionStatus(ctx);
  // Phase 2G.3: only a selected, FRESH frame of a Shot with a Location may become a canonical Location View
  const asView = productionFrameToViewStatus(ctx);

  return (
    <div data-testid="production-frame-section" className="space-y-4">
      <p className="text-[12px] text-muted">
        The approved image Prism carries into image-to-video and continuity. Frames are saved as history;
        choosing another one never deletes the others.
        {aspect ? (
          <>
            {" "}
            This Shot&apos;s production frame is <span className="font-mono text-fg">{aspect.raw}</span>;
            other shapes are refused, never cropped.
          </>
        ) : null}
      </p>

      {selected && selectedFresh ? (
        <div
          data-testid="pf-selected"
          data-version={selected.version}
          data-source={selected.source}
          data-freshness={selectedFresh.status}
          className="border border-line"
        >
          {assetUrl(ctx.assets.get(selected.assetId)) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              data-testid="pf-preview"
              src={assetUrl(ctx.assets.get(selected.assetId))!}
              alt={`Production Frame v${selected.version} of ${ctx.shot.shotCode}`}
              className="w-full object-cover"
              style={{ aspectRatio: `${selected.width} / ${selected.height}` }}
            />
          ) : null}
          <div className="space-y-1.5 border-t border-line p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[12.5px] font-semibold">Production Frame</h3>
              <span className="font-mono text-[12px]">v{selected.version}</span>
              <Badge tone="info">{PRODUCTION_FRAME_SOURCE_LABEL[selected.source]}</Badge>
              <FreshnessBadge status={selectedFresh.status} />
            </div>
            <div className="font-mono text-[11px] text-muted">
              {selected.productionAspectRatio} · {selected.width}×{selected.height} · created{" "}
              {stamp(selected.createdAt)}
            </div>
            {selectedFresh.status === "stale" ? (
              <div
                data-testid="pf-stale"
                className="border border-warn/40 bg-warn/10 p-2 text-[12px] text-warn"
              >
                <div className="font-medium">
                  This Production Frame no longer matches the Shot. It stays selected and is not changed.
                </div>
                <ul className="mt-1 list-disc pl-4">
                  {selectedFresh.changedParts.map((p) => (
                    <li key={p}>{PART_LABELS[p]} changed</li>
                  ))}
                </ul>
                <div className="mt-1 text-[11px] text-warn/80">
                  Create or select a current Production Frame, or set an explicit start frame, before
                  image-to-video.
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div data-testid="pf-empty" className="border border-dashed border-line2 p-3">
          <div className="text-[12.5px] font-medium">No Production Frame yet.</div>
          <p className="mt-0.5 text-[12px] text-muted">
            This is the approved image Prism will carry into image-to-video and continuity. Use the approved
            Storyboard, upload an image, or generate candidates and choose one.
          </p>
        </div>
      )}

      {selected && ctx.location ? (
        <details data-testid="pf-save-as-view" className="border border-line">
          <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[12px] font-medium">
            Save as Location View
            <span className="ml-2 text-[11px] font-normal text-muted">
              make this frame a canonical view of {ctx.location.name} that other Shots can reuse
            </span>
          </summary>
          <div className="border-t border-line p-2.5">
            {asView.ok ? (
              <ActionForm
                action={saveProductionFrameAsLocationView}
                resetOnSuccess
                successMessage="Location View saved"
                className="grid grid-cols-2 items-end gap-2"
              >
                {hidden}
                <LocationViewSpecFields location={ctx.location} compact testIdPrefix="pf-view" />
                <div className="col-span-2 text-[11px] text-muted">
                  The view reuses this frame&apos;s image (nothing is copied). It does not change this Shot.
                </div>
                <div className="col-span-2">
                  <Button data-testid="pf-save-as-view-submit" size="sm" type="submit">
                    Save as Location View
                  </Button>
                </div>
              </ActionForm>
            ) : (
              <p data-testid="pf-save-as-view-reason" className="text-[12px] text-warn">
                {asView.reason}
              </p>
            )}
          </div>
        </details>
      ) : null}

      {/* ways to make one */}
      <div className="space-y-2 border-t border-line pt-3">
        <ActionForm
          action={promoteStoryboardFrame}
          successMessage="Production Frame saved"
          className="flex items-center justify-between gap-3 border border-line px-2.5 py-1.5"
        >
          {hidden}
          <span className="text-[12px]">
            Use approved Storyboard
            {sbFrame ? <span className="text-muted"> · v{sbFrame.version}</span> : null}
            {!sbCheck.ok ? (
              <span data-testid="pf-storyboard-reason" className="block text-[11px] text-faint">
                {sbCheck.reason}
              </span>
            ) : null}
          </span>
          <Button data-testid="pf-use-storyboard" size="sm" type="submit" disabled={!sbCheck.ok}>
            Use approved Storyboard
          </Button>
        </ActionForm>

        {masterFrames.length > 0 ? (
          <div data-testid="pf-master-frames" className="space-y-1.5">
            {masterFrames.map((m) => {
              const check = assetPromotionStatus(ctx, ctx.assets.get(m.assetId) ?? null);
              return (
                <ActionForm
                  key={m.id}
                  action={promoteMasterFrame}
                  successMessage="Production Frame saved"
                  className="flex items-center justify-between gap-3 border border-line px-2.5 py-1.5"
                >
                  {hidden}
                  <input type="hidden" name="masterFrameId" value={m.id} />
                  <span className="text-[12px]">
                    Use 3D Master Frame
                    <span className="text-muted">
                      {" "}
                      · {m.width}×{m.height} · {stamp(m.capturedAt)}
                    </span>
                    {!check.ok ? <span className="block text-[11px] text-faint">{check.reason}</span> : null}
                  </span>
                  <Button data-testid={`pf-use-master-${m.id}`} size="sm" type="submit" disabled={!check.ok}>
                    Use 3D Master Frame
                  </Button>
                </ActionForm>
              );
            })}
          </div>
        ) : null}

        <ActionForm
          action={uploadProductionFrame}
          resetOnSuccess
          successMessage="Production Frame saved"
          className="grid grid-cols-[1fr_auto] items-end gap-2 border border-line p-2.5"
        >
          {hidden}
          <Field label="Upload Production Frame" hint="PNG, JPEG or WebP at the production aspect">
            <input
              data-testid="pf-upload-file"
              type="file"
              name="file"
              accept="image/png,image/jpeg,image/webp"
              className="!p-0.5"
            />
          </Field>
          <Button data-testid="pf-upload-submit" size="sm" type="submit">
            Upload Production Frame
          </Button>
        </ActionForm>
      </div>

      {/* Phase 2G.2: generate still-image candidates (no 3D, no GPU; the provider renders them) */}
      {candidates ? (
        <details data-testid="pf-generate" className="border border-line">
          <summary
            data-testid="pf-generate-summary"
            className="cursor-pointer select-none px-2.5 py-1.5 text-[12px] font-medium"
          >
            {selected ? "Generate alternatives" : "Generate candidates"}
            <span className="ml-2 text-[11px] font-normal text-muted">
              still images from image models; you choose one
            </span>
          </summary>
          <div className="border-t border-line p-2.5">{candidates}</div>
        </details>
      ) : null}

      {!candidates && openHref ? (
        <div className="flex items-center justify-between gap-3 border border-line px-2.5 py-1.5">
          <span className="text-[12px]">
            {selected ? "Generate alternatives" : "Generate candidates"}
            <span className="block text-[11px] text-faint">
              still images from image models; you choose one
            </span>
          </span>
          <a
            data-testid="pf-generate-link"
            href={openHref}
            className="rounded-[3px] border border-line2 px-2 py-1 text-[12px] hover:border-accent"
          >
            {selected ? "Generate alternatives" : "Generate candidates"}
          </a>
        </div>
      ) : null}

      {/* history */}
      {ctx.productionFrames.length > 0 ? (
        <div className="space-y-1.5 border-t border-line pt-3" data-testid="pf-history">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">History</h3>
          {ctx.productionFrames.map((f) => {
            const fr = freshOf(f);
            const isSelected = selected?.id === f.id;
            const url = assetUrl(ctx.assets.get(f.assetId));
            return (
              <ActionForm
                key={f.id}
                action={selectProductionFrame}
                quiet
                className="flex items-center gap-3 border border-line px-2.5 py-1.5"
              >
                {hidden}
                <input type="hidden" name="productionFrameId" value={f.id} />
                <input type="hidden" name="expectedSelectedId" value={selected?.id ?? ""} />
                <span data-testid="pf-history-item" data-version={f.version} className="contents">
                  {url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={url}
                      alt=""
                      className="h-9 shrink-0 border border-line object-cover"
                      style={{ aspectRatio: `${f.width} / ${f.height}` }}
                    />
                  ) : null}
                  <span className="min-w-0 flex-1 text-[12px]">
                    <span className="font-mono">v{f.version}</span>{" "}
                    <span className="text-muted">
                      · {PRODUCTION_FRAME_SOURCE_LABEL[f.source]} · {f.width}×{f.height}
                    </span>
                  </span>
                  <FreshnessBadge status={fr.status} />
                  {isSelected ? <Badge tone="accent">selected</Badge> : null}
                </span>
                {isSelected ? null : (
                  <Button data-testid={`pf-select-${f.version}`} size="sm" type="submit">
                    Use
                  </Button>
                )}
              </ActionForm>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

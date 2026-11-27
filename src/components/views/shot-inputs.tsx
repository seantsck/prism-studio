import { ActionForm } from "@/components/action-form";
import { Button, Panel } from "@/components/ui";
import type { Asset, Shot } from "@/domain/schemas";
import { assetUrl } from "@/lib/utils";
import { removeShotInput } from "@/server/actions";

const LABEL: Record<string, string> = {
  reference: "Reference image",
  start_frame: "Start frame",
  end_frame: "End frame",
  reference_video: "Reference video",
  reference_audio: "Reference audio",
  lighting_reference: "Lighting reference",
};

/**
 * What this Shot is generated from, picture by picture: its reference images, start and end frames, reference video
 * and audio, and lighting reference. Each can be taken off the Shot (the picture is kept; it can then be deleted when
 * nothing else uses it). Shown only when the Shot has any.
 */
export function ShotInputs({ slug, shot, assets }: { slug: string; shot: Shot; assets: readonly Asset[] }) {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const g = shot.generation;
  const inputs: Array<{ role: string; assetId: string }> = [
    ...g.referenceAssetIds.map((assetId) => ({ role: "reference", assetId })),
    ...(g.startFrameAssetId ? [{ role: "start_frame", assetId: g.startFrameAssetId }] : []),
    ...(g.endFrameAssetId ? [{ role: "end_frame", assetId: g.endFrameAssetId }] : []),
    ...(g.referenceVideoAssetId ? [{ role: "reference_video", assetId: g.referenceVideoAssetId }] : []),
    ...(g.referenceAudioAssetId ? [{ role: "reference_audio", assetId: g.referenceAudioAssetId }] : []),
    ...(shot.lighting.referenceAssetId
      ? [{ role: "lighting_reference", assetId: shot.lighting.referenceAssetId }]
      : []),
  ];
  if (inputs.length === 0) return null;
  const locked = shot.status === "locked";
  return (
    <div className="mx-6 mt-3">
      <Panel title={`Pictures this Shot is made from (${inputs.length})`}>
        <p className="mb-2 text-[12px] text-muted">
          Sent with every generation of this Shot, as well as its actors&apos; and location&apos;s own
          references. Remove one to stop sending it; the picture itself is kept (delete it afterwards if you
          want).
        </p>
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3" data-testid="shot-inputs">
          {inputs.map(({ role, assetId }) => {
            const a = byId.get(assetId);
            return (
              <li
                key={`${role}:${assetId}`}
                className="flex flex-col gap-1"
                data-testid="shot-input"
                data-role={role}
                data-asset={assetId}
              >
                <div className="aspect-[3/4] overflow-hidden rounded-[3px] border border-line2 bg-[#232326]">
                  {a?.type === "image" && assetUrl(a) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={assetUrl(a)!} alt={a.name} className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="truncate text-[11.5px]" title={a?.name ?? "Missing"}>
                  {a?.name ?? "Missing picture"}
                </div>
                <div className="text-[10.5px] text-muted">{LABEL[role]}</div>
                <ActionForm action={removeShotInput} successMessage="Removed">
                  <input type="hidden" name="projectSlug" value={slug} />
                  <input type="hidden" name="shotId" value={shot.id} />
                  <input type="hidden" name="role" value={role} />
                  <input type="hidden" name="assetId" value={assetId} />
                  <Button
                    type="submit"
                    variant="ghost"
                    disabled={locked}
                    title={locked ? "Unlock the Shot first" : undefined}
                    data-testid="shot-input-remove"
                  >
                    Remove from this Shot
                  </Button>
                </ActionForm>
              </li>
            );
          })}
        </ul>
      </Panel>
    </div>
  );
}

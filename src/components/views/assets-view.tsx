import { Badge, PageHeader } from "@/components/ui";
import { ASSET_TYPES, type Episode, type ProjectData } from "@/domain/schemas";
import { formatSeconds } from "@/domain/duration";

export function AssetsView({ data, episode }: { data: ProjectData; episode: Episode }) {
  // Assets reachable from this episode: frames, takes of its lines, plus project-level references.
  const shotIds = new Set(data.shots.filter((s) => s.episodeId === episode.id).map((s) => s.id));
  const lineIds = new Set(data.dialogueLines.filter((l) => l.episodeId === episode.id).map((l) => l.id));
  const usage = new Map<string, string>();
  for (const f of data.frames)
    if (f.assetId && shotIds.has(f.shotId))
      usage.set(
        f.assetId,
        `Storyboard · ${data.shots.find((s) => s.id === f.shotId)?.shotCode} v${f.version}`,
      );
  for (const t of data.takes)
    if (t.audioAssetId && lineIds.has(t.dialogueLineId)) usage.set(t.audioAssetId, `Take #${t.takeNumber}`);
  for (const r of data.identityRefs)
    if (r.assetId)
      usage.set(
        r.assetId,
        `Identity · ${data.characters.find((c) => c.id === r.characterId)?.name} ${r.slot}`,
      );

  const assets = data.assets.filter((a) => usage.has(a.id));
  const byType = ASSET_TYPES.map((t) => [t, assets.filter((a) => a.type === t)] as const).filter(
    ([, xs]) => xs.length > 0,
  );

  return (
    <div>
      <PageHeader
        title={`Assets — ${episode.title}`}
        subtitle="Everything references assets by id. Placeholder assets have no stored file yet."
      />
      <div className="space-y-6 p-6">
        {byType.map(([type, xs]) => (
          <section key={type}>
            <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              {type} ({xs.length})
            </h2>
            <div className="border border-line">
              <table className="w-full text-left text-[12px]">
                <tbody>
                  {xs.map((a) => (
                    <tr key={a.id} className="border-t border-line first:border-t-0">
                      <td className="px-3 py-1.5">{a.name}</td>
                      <td className="text-muted">{usage.get(a.id)}</td>
                      <td className="font-mono text-muted">
                        {a.durationMs ? formatSeconds(a.durationMs) : ""}
                      </td>
                      <td className="font-mono text-muted">
                        {a.width && a.height ? `${a.width}×${a.height}` : ""}
                      </td>
                      <td>
                        <Badge>{a.source}</Badge>
                      </td>
                      <td>
                        {a.storagePath ? (
                          <Badge tone="pass">stored</Badge>
                        ) : (
                          <Badge tone="warn">placeholder</Badge>
                        )}
                      </td>
                      <td className="pr-3 text-right font-mono text-[10.5px] text-faint">
                        {a.checksum?.slice(0, 8) ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
        {byType.length === 0 ? (
          <div className="border border-dashed border-line2 p-6 text-center text-muted">No assets yet.</div>
        ) : null}
      </div>
    </div>
  );
}

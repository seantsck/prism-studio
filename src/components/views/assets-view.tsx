import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { AudioPlayer } from "@/components/audio-player";
import { Badge, Button, Empty, Field, PageHeader, Panel } from "@/components/ui";
import { ASSET_FILTERS, filterAssets, isAssetFilter, type AssetFilterKey } from "@/domain/asset-library";
import { findAssetUsage, indexAssetUsage } from "@/domain/asset-usage";
import { formatSeconds } from "@/domain/duration";
import { ASSET_PURPOSES, type Asset, type ProjectData } from "@/domain/schemas";
import { assetUrl, cn } from "@/lib/utils";
import { deleteAsset, updateAsset, uploadAsset } from "@/server/actions";
import { getMediaQaRepo } from "@/server/media-qa";

const bytesLabel = (n: number | null) =>
  n == null ? "—" : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

function Preview({ asset, data }: { asset: Asset; data: ProjectData }) {
  const src = assetUrl(asset);
  if (!src)
    return (
      <div className="flex h-40 items-center justify-center bg-bg text-faint">
        Placeholder — no stored file
      </div>
    );
  if (asset.type === "image" || asset.type === "reference")
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={asset.name} className="max-h-72 w-full bg-bg object-contain" />;
  if (asset.type === "audio") {
    const take = data.takes.find((t) => t.audioAssetId === asset.id);
    return (
      <div className="p-3">
        <AudioPlayer
          src={src}
          waveform={take?.waveform ?? null}
          durationMs={asset.durationMs ?? take?.durationMs ?? 1000}
          label={asset.name}
        />
      </div>
    );
  }
  if (asset.type === "video") return <video src={src} controls className="max-h-72 w-full bg-bg" />;
  return (
    <div className="p-3">
      <a className="text-accent underline" href={src}>
        Download {asset.originalFilename || asset.name}
      </a>
    </div>
  );
}

interface Lineage {
  derivedFrom: {
    parentName: string;
    parentId: string;
    operation: string;
    processor: string;
    version: number;
  } | null;
  derivatives: Array<{ id: string; name: string; operation: string; slot: string }>;
  pins: string[];
}

function Detail({
  asset,
  data,
  base,
  lineage,
}: {
  asset: Asset;
  data: ProjectData;
  base: string;
  lineage: Lineage;
}) {
  const usage = findAssetUsage(data, asset.id);
  const rows: Array<[string, string]> = [
    ["Type / purpose", `${asset.type} · ${asset.purpose.replace(/_/g, " ")}`],
    ["Source", asset.source.replace(/_/g, " ")],
    ["File", asset.originalFilename || "—"],
    ["MIME", asset.mime ?? "—"],
    ["Size", bytesLabel(asset.byteSize)],
    ["Dimensions", asset.width && asset.height ? `${asset.width} × ${asset.height}` : "—"],
    ["Duration", asset.durationMs ? formatSeconds(asset.durationMs) : "—"],
    ["Audio", asset.sampleRate ? `${asset.sampleRate} Hz · ${asset.channels ?? "?"} ch` : "—"],
    [
      "Storage",
      asset.objectPath
        ? `${asset.storageProvider} · ${asset.bucket ? `${asset.bucket}/` : ""}${asset.objectPath}`
        : "placeholder",
    ],
    ["Checksum (sha256)", asset.checksum ?? "—"],
    ["Created", asset.createdAt.slice(0, 16).replace("T", " ")],
  ];
  return (
    <aside className="space-y-3">
      <Panel
        title={asset.name}
        actions={
          <Link href={base} className="text-[11px] text-muted hover:text-fg">
            Close
          </Link>
        }
      >
        <div className="-m-3 mb-3 border-b border-line">
          <Preview asset={asset} data={data} />
        </div>
        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[11.5px]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="break-all font-mono text-[11px]">{v}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <Panel title={`Where used · ${usage.summary}`}>
        {usage.direct.length === 0 ? (
          <p className="text-muted">Nothing references this asset. It can be deleted.</p>
        ) : (
          <ul className="space-y-1 text-[12px]">
            {usage.direct.map((u, i) => (
              <li key={`${u.entityId}-${i}`} className="flex items-start gap-2">
                <Badge className="shrink-0">{u.kind.replace(/_/g, " ")}</Badge>
                <span className="min-w-0">{u.label}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {lineage.derivedFrom || lineage.derivatives.length > 0 || lineage.pins.length > 0 ? (
        <Panel title="Lineage">
          <div className="space-y-1.5 text-[12px]" data-testid="asset-lineage">
            {lineage.derivedFrom ? (
              <p>
                Derived from{" "}
                <Link
                  className="text-accent hover:underline"
                  href={`${base}?asset=${lineage.derivedFrom.parentId}`}
                >
                  {lineage.derivedFrom.parentName}
                </Link>{" "}
                by <span className="font-mono">{lineage.derivedFrom.operation}</span> (
                {lineage.derivedFrom.processor}, v{lineage.derivedFrom.version}). The original is never
                replaced.
              </p>
            ) : null}
            {lineage.derivatives.length > 0 ? (
              <ul className="space-y-0.5">
                {lineage.derivatives.map((d) => (
                  <li key={d.id}>
                    <Badge className="mr-1.5">{d.operation.replace(/_/g, " ")}</Badge>
                    <Link className="text-accent hover:underline" href={`${base}?asset=${d.id}`}>
                      {d.name}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
            {lineage.pins.map((p) => (
              <p key={p} className="text-muted">
                Kept because {p}.
              </p>
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel title="Edit">
        <ActionForm action={updateAsset} className="space-y-2">
          <input type="hidden" name="projectSlug" value={data.project.slug} />
          <input type="hidden" name="assetId" value={asset.id} />
          <Field label="Name">
            <input name="name" defaultValue={asset.name} />
          </Field>
          <Field label="Purpose">
            <select name="purpose" defaultValue={asset.purpose}>
              {ASSET_PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {p.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tags" hint="Comma separated">
            <input name="tags" defaultValue={asset.tags.join(", ")} />
          </Field>
          <Field label="Notes">
            <textarea name="notes" rows={2} defaultValue={asset.notes} />
          </Field>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </ActionForm>
      </Panel>

      <Panel title="Delete">
        {usage.inUse || lineage.pins.length > 0 ? (
          <p className="text-muted">
            In use — remove its references first. (Assets referenced by Looks, takes, storyboard frames,
            generation history or derived media are never deleted silently.)
          </p>
        ) : (
          <ActionForm
            action={deleteAsset}
            confirmMessage={`Delete "${asset.name}"? This removes the stored file.`}
          >
            <input type="hidden" name="projectSlug" value={data.project.slug} />
            <input type="hidden" name="assetId" value={asset.id} />
            <Button type="submit" variant="danger">
              Delete asset
            </Button>
          </ActionForm>
        )}
      </Panel>
    </aside>
  );
}

export async function AssetLibraryView({
  data,
  base,
  searchParams,
}: {
  data: ProjectData;
  /** Path of this page, e.g. /projects/ojousama/assets */
  base: string;
  searchParams: { filter?: string; q?: string; asset?: string };
}) {
  const filter: AssetFilterKey = isAssetFilter(searchParams.filter) ? searchParams.filter : "all";
  const q = (searchParams.q ?? "").trim();
  const usage = indexAssetUsage(data);
  const assets = filterAssets(data, usage, { filter, q });
  const selected = data.assets.find((a) => a.id === searchParams.asset) ?? null;
  const lineage: Lineage = { derivedFrom: null, derivatives: [], pins: [] };
  if (selected) {
    const qa = await getMediaQaRepo();
    const [own, children, pins] = await Promise.all([
      qa.getDerivationOfAsset(selected.id),
      qa.listDerivationsByParent(selected.id),
      qa.assetPins(selected.id),
    ]);
    if (own) {
      const parent = data.assets.find((a) => a.id === own.parentAssetId);
      lineage.derivedFrom = {
        parentName: parent?.name ?? "original asset",
        parentId: own.parentAssetId,
        operation: own.operation,
        processor: `${own.processor} ${own.processorVersion}`,
        version: own.version,
      };
    }
    lineage.derivatives = children.map((c) => ({
      id: c.asset.id,
      name: c.asset.name,
      operation: c.derivation.operation,
      slot: c.derivation.slot,
    }));
    lineage.pins = pins;
  }
  const href = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const next = { filter: filter === "all" ? undefined : filter, q: q || undefined, ...over };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };

  return (
    <div>
      <PageHeader
        title="Asset library"
        subtitle={`${assets.length} of ${data.assets.length} assets · files are private; everything references assets by id`}
      />
      <div className="grid gap-6 p-6 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {ASSET_FILTERS.map((f) => (
              <Link
                key={f.key}
                href={href({ filter: f.key === "all" ? undefined : f.key, asset: undefined })}
                className={cn(
                  "rounded-[3px] border px-2 py-0.5 text-[11.5px]",
                  f.key === filter ? "border-accent/60 text-accent" : "border-line2 text-muted hover:text-fg",
                )}
              >
                {f.label}
              </Link>
            ))}
          </div>

          <form action={base} method="get" className="flex gap-2">
            {filter !== "all" ? <input type="hidden" name="filter" value={filter} /> : null}
            <input
              name="q"
              defaultValue={q}
              placeholder="Search file, tag, character, scene, shot, location…"
              className="flex-1"
              aria-label="Search assets"
            />
            <Button type="submit">Search</Button>
            {q ? (
              <Link
                href={href({ q: undefined })}
                className="self-center text-[11.5px] text-muted hover:text-fg"
              >
                Clear
              </Link>
            ) : null}
          </form>

          {assets.length === 0 ? (
            <Empty>{data.assets.length === 0 ? "No assets yet." : "No assets match this filter."}</Empty>
          ) : (
            <div className="border border-line">
              <table className="w-full text-left text-[12px]">
                <thead className="border-b border-line text-[10.5px] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-1.5">Name</th>
                    <th>Type</th>
                    <th>Purpose</th>
                    <th>Used</th>
                    <th>Dur / size</th>
                    <th>Storage</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((a) => {
                    const u = usage.get(a.id);
                    const src = assetUrl(a);
                    return (
                      <tr
                        key={a.id}
                        className={cn(
                          "border-t border-line first:border-t-0 hover:bg-panel2",
                          selected?.id === a.id && "bg-panel2",
                        )}
                      >
                        <td className="px-3 py-1.5">
                          <Link
                            href={href({ asset: a.id })}
                            className="flex items-center gap-2 hover:text-accent"
                          >
                            {src && a.type === "image" ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={src}
                                alt=""
                                className="h-7 w-10 shrink-0 rounded-[2px] bg-bg object-cover"
                              />
                            ) : (
                              <span className="flex h-7 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[2px] bg-bg text-[8px] uppercase text-faint">
                                {a.type}
                              </span>
                            )}
                            <span className="truncate">{a.name}</span>
                          </Link>
                        </td>
                        <td className="text-muted">{a.type}</td>
                        <td className="text-muted">{a.purpose.replace(/_/g, " ")}</td>
                        <td className="text-muted">
                          {u?.inUse ? (
                            u.shots.length > 0 ? (
                              `${u.shots.length} shot${u.shots.length === 1 ? "" : "s"}`
                            ) : (
                              `${u.direct.length} ref`
                            )
                          ) : (
                            <span className="text-faint">unused</span>
                          )}
                        </td>
                        <td className="font-mono text-muted">
                          {a.durationMs ? formatSeconds(a.durationMs) : bytesLabel(a.byteSize)}
                        </td>
                        <td>
                          {a.objectPath ? (
                            <Badge tone="pass">{a.storageProvider}</Badge>
                          ) : (
                            <Badge tone="warn">placeholder</Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <Panel title="Upload">
            <ActionForm action={uploadAsset} resetOnSuccess className="grid grid-cols-2 gap-3">
              <input type="hidden" name="projectSlug" value={data.project.slug} />
              <Field
                label="File"
                hint="Images, audio, video, PDF, 3D models (.glb). Validated server-side; max 50 MB."
              >
                <input type="file" name="file" required className="!p-0.5" />
              </Field>
              <Field label="Purpose">
                <select name="purpose" defaultValue="other">
                  {ASSET_PURPOSES.map((p) => (
                    <option key={p} value={p}>
                      {p.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Tags" hint="Comma separated">
                <input name="tags" />
              </Field>
              <Field label="Notes">
                <input name="notes" />
              </Field>
              <div className="col-span-2">
                <Button type="submit" variant="primary">
                  Upload asset
                </Button>
              </div>
            </ActionForm>
          </Panel>
        </div>

        {selected ? (
          <Detail asset={selected} data={data} base={href({ asset: undefined })} lineage={lineage} />
        ) : (
          <aside className="text-muted">
            Select an asset to see its preview, metadata and where it is used.
          </aside>
        )}
      </div>
    </div>
  );
}

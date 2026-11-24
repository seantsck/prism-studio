import { ActionForm } from "@/components/action-form";
import { Badge, Button, Field } from "@/components/ui";
import type { Asset, Character, CharacterLook, Episode } from "@/domain/schemas";
import { previewUrl } from "@/lib/utils";
import { saveLook, setLookLocked, uploadLookReference } from "@/server/actions";

/**
 * A Character's Looks (outfits: wardrobe, hair, makeup …), each with its pictures, and a new one. Lives on the Looks
 * page (/projects/<slug>/looks, under Characters in the sidebar); the Character page links to it.
 */
export function LooksEditor({
  slug,
  character,
  looks,
  episodes,
  assets,
}: {
  slug: string;
  character: Character;
  looks: CharacterLook[];
  episodes: Episode[];
  assets: Asset[];
}) {
  const c = character;
  const assetsById = new Map(assets.map((a) => [a.id, a]));
  const hidden = <input type="hidden" name="projectSlug" value={slug} />;
  const data = { episodes };
  return (
    <div className="space-y-3">
      {looks.map((l) => (
        <details key={l.id} className="border border-line" open={looks.length === 1}>
          <summary className="flex items-center justify-between px-3 py-2">
            <span className="font-medium">{l.name}</span>
            <Badge tone={l.locked ? "pass" : "warn"}>{l.locked ? "locked" : "open"}</Badge>
          </summary>
          <div className="border-t border-line p-3">
            <ActionForm action={saveLook} className="grid grid-cols-2 gap-3">
              {hidden}
              <input type="hidden" name="id" value={l.id} />
              <input type="hidden" name="characterId" value={c.id} />
              <input type="hidden" name="episodeId" value={l.episodeId ?? ""} />
              <Field label="Name" className="col-span-2">
                <input name="name" defaultValue={l.name} disabled={l.locked} />
              </Field>
              {(
                [
                  ["wardrobe", "Wardrobe"],
                  ["shoes", "Shoes"],
                  ["jewelry", "Jewelry"],
                  ["hair", "Hair"],
                  ["makeup", "Makeup"],
                  ["grooming", "Grooming"],
                  ["bodyNotes", "Body notes"],
                  ["accessories", "Accessories"],
                ] as const
              ).map(([k, label]) => (
                <Field label={label} key={k}>
                  <textarea name={k} rows={2} defaultValue={l[k]} disabled={l.locked} />
                </Field>
              ))}
              <div className="col-span-2 flex gap-2">
                {!l.locked ? (
                  <Button type="submit" variant="primary">
                    Save look
                  </Button>
                ) : null}
              </div>
            </ActionForm>
            <div className="mt-2 text-[12px]">
              <div className="mb-1 text-muted">Look reference images ({l.referenceAssetIds.length})</div>
              <div className="flex flex-wrap gap-1">
                {l.referenceAssetIds.map((aid) => {
                  const url = previewUrl(assetsById.get(aid));
                  return url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={aid}
                      data-testid="look-ref-thumb"
                      src={url}
                      alt={`${l.name} reference`}
                      className="h-14 border border-line object-cover"
                    />
                  ) : (
                    <span key={aid} className="border border-line px-1 text-[11px] text-muted">
                      placeholder
                    </span>
                  );
                })}
              </div>
              {!l.locked ? (
                <ActionForm action={uploadLookReference} className="mt-1 flex gap-1">
                  {hidden}
                  <input type="hidden" name="lookId" value={l.id} />
                  <input
                    data-testid="look-ref-file"
                    type="file"
                    name="file"
                    accept="image/*"
                    className="!p-0.5 text-[11px]"
                  />
                  <Button data-testid="look-ref-upload" size="sm" type="submit">
                    Add Look image
                  </Button>
                </ActionForm>
              ) : null}
            </div>
            <ActionForm action={setLookLocked} className="mt-2">
              {hidden}
              <input type="hidden" name="id" value={l.id} />
              <input type="hidden" name="locked" value={String(!l.locked)} />
              <Button type="submit">{l.locked ? "Unlock look" : "Lock look"}</Button>
            </ActionForm>
          </div>
        </details>
      ))}
      <details className="border border-dashed border-line2">
        <summary className="px-3 py-2 text-muted">+ New look</summary>
        <ActionForm action={saveLook} className="grid grid-cols-2 gap-3 border-t border-line p-3">
          {hidden}
          <input type="hidden" name="characterId" value={c.id} />
          <Field label="Name" className="col-span-2">
            <input name="name" placeholder="Episode 1 / Formal Black" required />
          </Field>
          <Field label="Episode">
            <select name="episodeId" defaultValue="">
              <option value="">All episodes</option>
              {data.episodes.map((e) => (
                <option key={e.id} value={e.id}>
                  Ep {e.number} — {e.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Wardrobe" className="col-span-2">
            <textarea name="wardrobe" rows={2} />
          </Field>
          <Field label="Shoes">
            <input name="shoes" />
          </Field>
          <Field label="Jewelry">
            <input name="jewelry" />
          </Field>
          <Field label="Hair">
            <input name="hair" />
          </Field>
          <Field label="Makeup">
            <input name="makeup" />
          </Field>
          <div className="col-span-2">
            <Button type="submit" variant="primary">
              Create look
            </Button>
          </div>
        </ActionForm>
      </details>
    </div>
  );
}

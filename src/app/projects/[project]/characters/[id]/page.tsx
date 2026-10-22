import { notFound } from "next/navigation";
import { Badge, Button, Field, PageHeader, Panel } from "@/components/ui";
import { FramePlaceholder } from "@/components/shared";
import {
  CONTINUITY_LOCK_EXPLANATION,
  ContinuityLockCard,
} from "@/components/character-continuity/continuity-lock-ui";
import { IDENTITY_SLOTS } from "@/domain/schemas";
import { assetUrl } from "@/lib/utils";
import {
  saveCharacter,
  saveLook,
  saveVoiceProfile,
  setIdentityLocked,
  setLookLocked,
  setVoiceLocked,
  uploadIdentityRef,
  uploadLookReference,
} from "@/server/actions";
import { createCharacterContinuityLock } from "@/server/character-continuity-actions";
import { requireProject } from "@/server/repo";
import { ActionForm } from "@/components/action-form";

const join = (xs: string[]) => xs.join("\n");

export default async function CharacterPage({
  params,
}: {
  params: Promise<{ project: string; id: string }>;
}) {
  const { project: slug, id } = await params;
  const data = await requireProject(slug);
  const c = data.characters.find((x) => x.id === id);
  if (!c) notFound();
  const refs = data.identityRefs.filter((r) => r.characterId === c.id);
  const looks = data.looks.filter((l) => l.characterId === c.id);
  const voices = data.voiceProfiles.filter((v) => v.characterId === c.id);
  // Phase 2G.4: this Character's immutable Continuity Locks, grouped by the Look they froze (null = no Look)
  const locks = (data.characterContinuityLocks ?? [])
    .filter((l) => l.characterId === c.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const lockGroups = [...new Set(locks.map((l) => l.sourceLookId))].map((lookId) => ({
    lookId,
    title: lookId
      ? `Look "${looks.find((l) => l.id === lookId)?.name ?? locks.find((l) => l.sourceLookId === lookId)?.facts.look?.name ?? "removed"}"`
      : "No Look",
    locks: locks.filter((l) => l.sourceLookId === lookId),
  }));
  const assetsById = new Map(data.assets.map((a) => [a.id, a]));
  const identityLocked = refs.length > 0 && refs.every((r) => r.locked);
  const hidden = <input type="hidden" name="projectSlug" value={slug} />;

  return (
    <div>
      <PageHeader
        title={c.name}
        subtitle={c.role}
        actions={
          <Badge tone={identityLocked ? "pass" : "warn"}>
            {identityLocked ? "Identity locked" : "Identity open"}
          </Badge>
        }
      />
      <div className="grid gap-4 p-6 xl:grid-cols-2">
        <Panel title="Character">
          <ActionForm action={saveCharacter} className="space-y-3">
            {hidden}
            <input type="hidden" name="id" value={c.id} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name">
                <input name="name" defaultValue={c.name} />
              </Field>
              <Field label="Role">
                <input name="role" defaultValue={c.role} />
              </Field>
            </div>
            <Field label="Description">
              <textarea name="description" rows={2} defaultValue={c.description} />
            </Field>
            <Field label="Personality">
              <textarea name="personality" rows={2} defaultValue={c.personality} />
            </Field>
            <Field label="Behavior notes">
              <textarea name="behaviorNotes" rows={2} defaultValue={c.behaviorNotes} />
            </Field>
            <Field label="Physical description">
              <textarea name="physicalDescription" rows={2} defaultValue={c.physicalDescription} />
            </Field>
            <Field label="Signature behavior">
              <input name="signatureBehavior" defaultValue={c.signatureBehavior} />
            </Field>
            <Field label="Relationship notes">
              <textarea name="relationshipNotes" rows={2} defaultValue={c.relationshipNotes} />
            </Field>
            <Field label="Continuity rules" hint="One per line">
              <textarea name="continuityRules" rows={3} defaultValue={join(c.continuityRules)} />
            </Field>
            <Button type="submit" variant="primary">
              Save character
            </Button>
          </ActionForm>
        </Panel>

        <Panel
          title="Identity references"
          actions={
            <ActionForm action={setIdentityLocked}>
              {hidden}
              <input type="hidden" name="characterId" value={c.id} />
              <input type="hidden" name="locked" value={String(!identityLocked)} />
              <Button size="sm" type="submit">
                {identityLocked ? "Unlock" : "Lock all"}
              </Button>
            </ActionForm>
          }
        >
          <div className="grid grid-cols-2 gap-3">
            {IDENTITY_SLOTS.filter((s) => s !== "additional").map((slot) => {
              const ref = refs.find((r) => r.slot === slot);
              const asset = data.assets.find((a) => a.id === ref?.assetId);
              const url = assetUrl(asset);
              return (
                <div key={slot} data-testid={`identity-slot-${slot}`} className="border border-line p-2">
                  <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted">
                    {slot.replace("_", " ")}
                    {ref?.locked ? <Badge tone="pass">locked</Badge> : null}
                  </div>
                  {url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url} alt={slot} className="aspect-[3/4] w-full object-cover" />
                  ) : (
                    <FramePlaceholder
                      code={slot}
                      label={asset ? "Placeholder reference" : "Missing"}
                      className="aspect-[3/4]"
                    />
                  )}
                  <ActionForm action={uploadIdentityRef} className="mt-2 flex gap-1">
                    {hidden}
                    <input type="hidden" name="characterId" value={c.id} />
                    <input type="hidden" name="slot" value={slot} />
                    <input
                      data-testid="identity-file"
                      type="file"
                      name="file"
                      accept="image/*"
                      className="!p-0.5 text-[11px]"
                    />
                    <Button data-testid="identity-upload" size="sm" type="submit">
                      Upload
                    </Button>
                  </ActionForm>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title={`Looks (${looks.length})`} className="xl:col-span-2">
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
                    <div className="mb-1 text-muted">
                      Look reference images ({l.referenceAssetIds.length})
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {l.referenceAssetIds.map((aid) => {
                        const url = assetUrl(assetsById.get(aid));
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
        </Panel>

        <Panel title={`Continuity Locks (${locks.length})`} className="xl:col-span-2">
          <p className="mb-2 text-[12px] text-muted">
            {CONTINUITY_LOCK_EXPLANATION} A Lock is immutable: it copies today&apos;s identity facts, the
            chosen Look and their stored images, so later edits here never change a Shot that relies on it. No
            images are generated or copied.
          </p>
          <ActionForm
            action={createCharacterContinuityLock}
            className="mb-3 flex flex-wrap items-end gap-2 border border-dashed border-line2 p-2"
          >
            {hidden}
            <input type="hidden" name="characterId" value={c.id} />
            <Field label="Look">
              <select data-testid="cl-look" name="lookId" defaultValue={looks[0]?.id ?? ""}>
                {looks.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
                <option value="">No Look (intentional)</option>
              </select>
            </Field>
            <Field label="Name" className="min-w-[260px] flex-1">
              <input
                data-testid="cl-name"
                name="name"
                required
                maxLength={120}
                defaultValue={`${c.name} — ${looks[0]?.name ?? "No Look"}`}
              />
            </Field>
            <Button data-testid="cl-create" type="submit" variant="primary">
              Create Continuity Lock
            </Button>
          </ActionForm>
          {locks.length === 0 ? (
            <p data-testid="cl-none" className="text-[12px] text-muted">
              No Continuity Locks yet. Shots use {c.name}&apos;s current identity references and Looks.
            </p>
          ) : (
            <div className="space-y-3">
              {lockGroups.map((g) => (
                <div key={g.lookId ?? "none"} data-testid="cl-group" className="space-y-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                    {g.title}
                  </div>
                  {g.locks.map((l) => (
                    <ContinuityLockCard key={l.id} lock={l} assets={assetsById} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title={`Voice profiles (${voices.length})`} className="xl:col-span-2">
          <p className="mb-3 text-muted">Data model only — no voice provider is connected yet.</p>
          <div className="space-y-3">
            {[...voices, null].map((v) => (
              <details
                key={v?.id ?? "new"}
                className={v ? "border border-line" : "border border-dashed border-line2"}
              >
                <summary className="flex items-center justify-between px-3 py-2">
                  <span className={v ? "font-medium" : "text-muted"}>
                    {v ? v.name : "+ New voice profile"}
                  </span>
                  {v ? (
                    <span className="flex gap-1.5">
                      <Badge>{v.locale}</Badge>
                      <Badge>{v.provider}</Badge>
                      {v.locked ? <Badge tone="pass">locked</Badge> : null}
                    </span>
                  ) : null}
                </summary>
                <div className="border-t border-line p-3">
                  <ActionForm action={saveVoiceProfile} className="grid grid-cols-2 gap-3">
                    {hidden}
                    <input type="hidden" name="characterId" value={c.id} />
                    {v ? <input type="hidden" name="id" value={v.id} /> : null}
                    <Field label="Name">
                      <input name="name" defaultValue={v?.name ?? ""} required disabled={v?.locked} />
                    </Field>
                    <Field label="Accent">
                      <input name="accent" defaultValue={v?.accent ?? ""} disabled={v?.locked} />
                    </Field>
                    <Field label="Language">
                      <input name="language" defaultValue={v?.language ?? "ja"} disabled={v?.locked} />
                    </Field>
                    <Field label="Locale">
                      <input name="locale" defaultValue={v?.locale ?? ""} disabled={v?.locked} />
                    </Field>
                    <Field label="Provider">
                      <input
                        name="provider"
                        defaultValue={v?.provider ?? "unassigned"}
                        disabled={v?.locked}
                      />
                    </Field>
                    <Field label="Provider voice id">
                      <input
                        name="providerVoiceId"
                        defaultValue={v?.providerVoiceId ?? ""}
                        disabled={v?.locked}
                      />
                    </Field>
                    <Field label="Description" className="col-span-2">
                      <textarea
                        name="description"
                        rows={2}
                        defaultValue={v?.description ?? ""}
                        disabled={v?.locked}
                      />
                    </Field>
                    <Field label="Pitch notes">
                      <input name="pitchNotes" defaultValue={v?.pitchNotes ?? ""} disabled={v?.locked} />
                    </Field>
                    <Field label="Timbre notes">
                      <input name="timbreNotes" defaultValue={v?.timbreNotes ?? ""} disabled={v?.locked} />
                    </Field>
                    <Field label="Speaking style">
                      <input
                        name="speakingStyle"
                        defaultValue={v?.speakingStyle ?? ""}
                        disabled={v?.locked}
                      />
                    </Field>
                    <Field label="Emotional range">
                      <input
                        name="emotionalRange"
                        defaultValue={v?.emotionalRange ?? ""}
                        disabled={v?.locked}
                      />
                    </Field>
                    <Field label="Pronunciation rules" hint="One per line" className="col-span-2">
                      <textarea
                        name="pronunciationRules"
                        rows={2}
                        defaultValue={join(v?.pronunciationRules ?? [])}
                        disabled={v?.locked}
                      />
                    </Field>
                    {!v?.locked ? (
                      <div className="col-span-2">
                        <Button type="submit" variant="primary">
                          {v ? "Save voice" : "Create voice"}
                        </Button>
                      </div>
                    ) : null}
                  </ActionForm>
                  {v ? (
                    <ActionForm action={setVoiceLocked} className="mt-2">
                      {hidden}
                      <input type="hidden" name="id" value={v.id} />
                      <input type="hidden" name="locked" value={String(!v.locked)} />
                      <Button type="submit">{v.locked ? "Unlock voice" : "Lock voice"}</Button>
                    </ActionForm>
                  ) : null}
                </div>
              </details>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

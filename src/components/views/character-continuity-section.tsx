import { ActionForm } from "@/components/action-form";
import {
  CONTINUITY_LOCK_EXPLANATION,
  ContinuityLockCard,
} from "@/components/character-continuity/continuity-lock-ui";
import { Button } from "@/components/ui";
import { lockMatchesAssignment } from "@/domain/character-continuity";
import type { ShotCharacterContext, ShotContext } from "@/domain/context";
import {
  clearShotCharacterContinuityLock,
  createLockFromShotAssignment,
  selectShotCharacterContinuityLock,
} from "@/server/character-continuity-actions";

/**
 * Shot Prep → CHARACTER CONTINUITY (Phase 2G.4), one block per assigned Character. The assignment may rely on ONE
 * immutable Character Continuity Lock made for its CURRENT Look (a Lock of another Look is never offered and is refused
 * by the server and the database). Optional: no Lock is never a blocker, and the Character then uses its current
 * IdentityRefs and Look exactly as before. Choosing / changing a Lock changes the Shot's character truth (frames made
 * before become stale); editing the source library later does not change a locked Shot.
 */
export function CharacterContinuitySection({
  ctx,
  c,
  slug,
}: {
  ctx: ShotContext;
  c: ShotCharacterContext;
  slug: string;
}) {
  const selected = c.continuityLock;
  const name = c.character?.name ?? "Unknown character";
  const compatible = c.continuityLocks.filter(
    (l) => l.id !== selected?.id && lockMatchesAssignment(l, c.assignment),
  );
  const otherLooks = c.continuityLocks.length - compatible.length - (selected ? 1 : 0);
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="shotId" value={ctx.shot.id} />
      <input type="hidden" name="characterId" value={c.assignment.characterId} />
      <input type="hidden" name="expectedSelectedId" value={selected?.id ?? ""} />
    </>
  );
  return (
    <div
      data-testid="character-continuity"
      data-character-id={c.assignment.characterId}
      className="mt-2 space-y-1.5 border-t border-line pt-2"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Character continuity</h4>
        <span className="text-[11px] text-faint">{CONTINUITY_LOCK_EXPLANATION}</span>
      </div>

      {c.continuityLockIssue ? (
        <div
          data-testid="cc-integrity"
          className="border border-fail/40 bg-fail/10 p-2 text-[12px] text-fail"
        >
          {c.continuityLockIssue.message}
          <ActionForm action={clearShotCharacterContinuityLock} quiet className="mt-1">
            <input type="hidden" name="projectSlug" value={slug} />
            <input type="hidden" name="shotId" value={ctx.shot.id} />
            <input type="hidden" name="characterId" value={c.assignment.characterId} />
            <Button data-testid="cc-clear-invalid" size="sm" type="submit">
              Clear the invalid selection
            </Button>
          </ActionForm>
        </div>
      ) : null}

      {selected ? (
        <div data-testid="cc-selected" data-lock-id={selected.id}>
          <ContinuityLockCard lock={selected} assets={ctx.assets} selected>
            <ActionForm action={clearShotCharacterContinuityLock} quiet>
              {hidden}
              <Button data-testid="cc-clear" size="sm" type="submit">
                Clear Lock
              </Button>
            </ActionForm>
          </ContinuityLockCard>
        </div>
      ) : !c.continuityLockIssue ? (
        <p data-testid="cc-empty" className="text-[12px] text-muted">
          No Character Continuity Lock selected. Prism will use the Character&apos;s current IdentityRefs and
          Look.
        </p>
      ) : null}

      {compatible.length > 0 ? (
        <div data-testid="cc-available" className="space-y-1.5">
          <div className="text-[11px] text-muted">
            Locks of {name} for {c.look ? `Look "${c.look.name}"` : "no Look"}
          </div>
          {compatible.map((l) => (
            <ContinuityLockCard key={l.id} lock={l} assets={ctx.assets}>
              <ActionForm action={selectShotCharacterContinuityLock} quiet>
                {hidden}
                <input type="hidden" name="continuityLockId" value={l.id} />
                <Button data-testid="cc-choose" size="sm" type="submit">
                  Choose Lock
                </Button>
              </ActionForm>
            </ContinuityLockCard>
          ))}
        </div>
      ) : null}
      {otherLooks > 0 ? (
        <p data-testid="cc-other-looks" className="text-[11px] text-faint">
          {otherLooks} Lock{otherLooks === 1 ? "" : "s"} of {name} made for another Look{" "}
          {otherLooks === 1 ? "is" : "are"} not offered: a Lock can only be used with the Look it froze.
        </p>
      ) : null}

      {c.character ? (
        <ActionForm action={createLockFromShotAssignment} className="flex flex-wrap items-center gap-1.5">
          {hidden}
          <input
            data-testid="cc-create-name"
            name="name"
            required
            maxLength={120}
            defaultValue={`${name} — ${c.look ? c.look.name : "No Look"}`}
            className="min-w-[220px] flex-1 text-[12px]"
          />
          <Button data-testid="cc-create" size="sm" type="submit">
            Create Lock from current appearance
          </Button>
        </ActionForm>
      ) : null}
    </div>
  );
}

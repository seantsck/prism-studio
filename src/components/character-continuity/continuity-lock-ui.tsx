import { Badge } from "@/components/ui";
import {
  describeIdentityCoverage,
  IDENTITY_SLOT_LABEL,
  lockCoverage,
  type CharacterContinuityLock,
} from "@/domain/character-continuity";
import type { Asset } from "@/domain/schemas";
import { assetUrl } from "@/lib/utils";

const stamp = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** The one-line explanation shown wherever Locks are offered. No AI "remembering": Prism stores the facts. */
export const CONTINUITY_LOCK_EXPLANATION =
  "A Continuity Lock freezes the exact identity, wardrobe and appearance references this Shot should preserve.";

const COVERAGE_TONE = { rich: "pass", sparse: "warn", none: "info" } as const;

/**
 * One immutable Character Continuity Lock: its name, Look, frozen appearance summary, TRUTHFUL coverage (only the
 * images it really froze) and thumbnails (private asset route only; never a path or a signed URL in the markup).
 */
export function ContinuityLockCard({
  lock,
  assets,
  children,
  selected = false,
}: {
  lock: CharacterContinuityLock;
  assets: ReadonlyMap<string, Asset>;
  children?: React.ReactNode;
  selected?: boolean;
}) {
  const coverage = lockCoverage(lock);
  const f = lock.facts;
  const identity = describeIdentityCoverage(coverage);
  return (
    <div
      data-testid="continuity-lock-card"
      data-lock-id={lock.id}
      data-lock-name={lock.name}
      data-look-id={lock.sourceLookId ?? ""}
      className="space-y-1.5 border border-line p-2"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <span data-testid="continuity-lock-name" className="font-medium">
          {lock.name}
        </span>
        <Badge tone="info">{f.look ? `Look: ${f.look.name}` : "No Look"}</Badge>
        <Badge tone={COVERAGE_TONE[coverage.level]}>
          <span data-testid="continuity-lock-coverage">{coverage.level} coverage</span>
        </Badge>
        {selected ? <Badge tone="accent">selected</Badge> : null}
        {children ? <span className="ml-auto">{children}</span> : null}
      </div>
      <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
        <dt className="text-muted">Identity</dt>
        <dd data-testid="continuity-lock-identity">
          {coverage.identityCount > 0 ? identity : "no identity images (words only)"}
        </dd>
        <dt className="text-muted">Look images</dt>
        <dd data-testid="continuity-lock-look-count">{coverage.lookCount}</dd>
        {f.physicalDescription ? (
          <>
            <dt className="text-muted">Physical</dt>
            <dd>{f.physicalDescription}</dd>
          </>
        ) : null}
        {f.look
          ? (
              [
                ["Wardrobe", f.look.wardrobe],
                ["Hair", f.look.hair],
                ["Makeup", f.look.makeup],
                ["Jewelry", f.look.jewelry],
              ] as const
            )
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd data-testid={`continuity-lock-${k.toLowerCase()}`}>{v}</dd>
                </div>
              ))
          : null}
      </dl>
      {lock.references.length > 0 ? (
        <div data-testid="continuity-lock-thumbs" className="flex flex-wrap gap-1">
          {lock.references.map((r) => {
            const url = assetUrl(assets.get(r.assetId));
            const label =
              r.role === "identity" && r.identitySlot ? IDENTITY_SLOT_LABEL[r.identitySlot] : "Look";
            return url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={r.assetId}
                data-testid="continuity-lock-thumb"
                data-role={r.role}
                src={url}
                alt={`${f.characterName} ${label}`}
                title={label}
                className="h-12 border border-line object-cover"
                style={{ aspectRatio: `${r.width} / ${r.height}` }}
              />
            ) : (
              <span key={r.assetId} className="border border-line px-1 text-[10.5px] text-muted">
                {label}
              </span>
            );
          })}
        </div>
      ) : null}
      <div className="font-mono text-[10.5px] text-faint">
        {lock.references.length} frozen image{lock.references.length === 1 ? "" : "s"} ·{" "}
        {stamp(lock.createdAt)}
      </div>
    </div>
  );
}

import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button, PageHeader } from "@/components/ui";
import { productionChecklist, type ChecklistArea, type ShotLight } from "@/domain/production-checklist";
import { cn } from "@/lib/utils";
import { requireProject } from "@/server/repo";
import { approveCharacter } from "@/server/visual-bible-actions";

export const dynamic = "force-dynamic";

const AREA: Record<ChecklistArea, string> = {
  people: "People",
  outfits: "Outfits",
  places: "Places",
  shots: "Shots",
};

const LIGHT: Record<ShotLight, { label: string; dot: string }> = {
  ready: { label: "Ready", dot: "bg-pass" },
  partial: { label: "Can be made, could be better", dot: "bg-warn" },
  blocked: { label: "Not yet", dot: "bg-fail" },
};

/**
 * One Episode, everything its frames need, in the order it has to happen: people (photos → views), outfits (a picture
 * per Look), places, then Shots. Each missing thing has the button that opens the screen that fixes it, already set up.
 */
export default async function ChecklistPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ episode?: string }>;
}) {
  const { project: slug } = await params;
  const sp = await searchParams;
  const data = await requireProject(slug);
  // the Episode asked for, else the one with the most Shots (the real one, not a smoke test)
  const ranked = [...data.episodes].sort(
    (a, b) =>
      data.shots.filter((s) => s.episodeId === b.id).length -
        data.shots.filter((s) => s.episodeId === a.id).length || a.order - b.order,
  );
  const episode = data.episodes.find((e) => e.id === sp.episode) ?? ranked[0];
  const list = episode ? productionChecklist(data, episode.id) : null;

  return (
    <div>
      <PageHeader
        title="Production checklist"
        subtitle="What each Episode still needs before its frames can be made, in the order it has to happen."
      />
      <div className="space-y-5 p-6" data-testid="checklist">
        {ranked.length > 1 ? (
          <nav className="flex flex-wrap gap-1.5 text-[12px]" aria-label="Episode">
            {ranked.map((e) => (
              <Link
                key={e.id}
                href={`/projects/${slug}/checklist?episode=${e.id}`}
                aria-current={e.id === episode?.id ? "page" : undefined}
                className={cn(
                  "rounded-[3px] border px-2 py-1",
                  e.id === episode?.id ? "border-accent text-fg" : "border-line2 text-muted hover:text-fg",
                )}
              >
                {e.number}. {e.title}
              </Link>
            ))}
          </nav>
        ) : null}

        {!list ? (
          <p className="text-[13px] text-muted">This project has no Episode yet.</p>
        ) : (
          <>
            <section className="rounded-[3px] border border-line bg-panel p-4" data-testid="checklist-next">
              <h2 className="text-[14px] font-medium">
                Next steps for “{list.episodeTitle}”{" "}
                <span className="font-normal text-muted">({list.steps.length})</span>
              </h2>
              {list.steps.length === 0 ? (
                <p className="mt-2 text-[13px] text-pass">
                  Nothing missing: every Shot of this Episode has what it needs.
                </p>
              ) : (
                <ol className="mt-3 space-y-2">
                  {list.steps.map((s, i) => (
                    <li
                      key={`${s.title}-${i}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[3px] border border-line bg-bg px-3 py-2"
                      data-testid="checklist-step"
                      data-area={s.area}
                    >
                      <span className="w-5 text-right text-[12px] text-faint">{i + 1}</span>
                      <span className="w-16 text-[11px] text-muted">{AREA[s.area]}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px]">{s.title}</span>
                        <span className="block text-[11.5px] text-muted">{s.detail}</span>
                      </span>
                      <Link
                        href={s.href}
                        className={cn(
                          "rounded-[3px] px-2.5 py-1 text-[12px] font-medium",
                          i === 0
                            ? "bg-accent text-accentfg"
                            : "border border-line2 text-fg hover:border-muted",
                        )}
                        data-testid="checklist-step-go"
                      >
                        {s.action}
                      </Link>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section data-testid="checklist-people">
              <h2 className="mb-2 text-[13px] font-medium">People</h2>
              <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {list.people.map((p) => (
                  <li
                    key={p.characterId}
                    className="rounded-[3px] border border-line bg-panel p-3 text-[12px]"
                    data-testid="checklist-person"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <Link href={p.studioHref} className="text-[13px] font-medium hover:underline">
                        {p.name}
                      </Link>
                      {p.locked ? <span className="text-[11px] text-pass">Approved</span> : null}
                    </div>
                    <p className={cn("mt-1", p.photos >= 4 ? "text-muted" : "text-warn")}>
                      {p.photos} photo{p.photos === 1 ? "" : "s"} of their own
                    </p>
                    <ul className="mt-1 flex flex-wrap gap-1">
                      {p.views.map((v) => (
                        <li
                          key={v.id}
                          className={cn(
                            "rounded-[2px] border px-1.5 py-px text-[10.5px]",
                            v.filled ? "border-pass/40 text-pass" : "border-line2 text-faint",
                          )}
                        >
                          {v.label}
                        </li>
                      ))}
                    </ul>
                    {p.looks.length > 0 ? (
                      <p className="mt-1 text-muted">Outfits: {p.looks.map((l) => l.name).join(", ")}</p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {p.readyToApprove && !p.locked ? (
                        <ActionForm action={approveCharacter} successMessage="Approved">
                          <input type="hidden" name="projectSlug" value={slug} />
                          <input type="hidden" name="characterId" value={p.characterId} />
                          {p.looks.map((l) => (
                            <input key={l.lookId} type="hidden" name="lookId" value={l.lookId} />
                          ))}
                          <Button type="submit" variant="primary" data-testid="checklist-approve">
                            Approve {p.name}
                          </Button>
                        </ActionForm>
                      ) : null}
                      {p.readyToApprove && !p.locked ? (
                        <span className="text-[11px] text-muted">
                          Locks their references and outfits, so no Shot changes by accident.
                        </span>
                      ) : p.locked ? (
                        <Link href={p.characterHref} className="text-[11px] text-muted hover:underline">
                          Unlock on their page to change anything
                        </Link>
                      ) : null}
                    </div>
                  </li>
                ))}
                {list.people.length === 0 ? (
                  <li className="text-[12px] text-muted">
                    No one is assigned to a Shot of this Episode yet.
                  </li>
                ) : null}
              </ul>
            </section>

            <section data-testid="checklist-shots">
              <h2 className="mb-2 text-[13px] font-medium">Shots</h2>
              <ul className="divide-y divide-line rounded-[3px] border border-line bg-panel">
                {list.shots.map((s) => (
                  <li
                    key={s.shotId}
                    className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2 text-[12px]"
                    data-testid="checklist-shot"
                    data-light={s.light}
                  >
                    <span
                      className={cn("mt-1 h-2.5 w-2.5 shrink-0 rounded-full", LIGHT[s.light].dot)}
                      title={LIGHT[s.light].label}
                    />
                    <Link href={s.href} className="w-10 font-medium hover:underline">
                      {s.code}
                    </Link>
                    <span className="min-w-0 flex-1">
                      <span className="block">{s.title}</span>
                      <span className="block text-muted">
                        {s.people.length > 0 ? s.people.join(", ") : "No one"} ·{" "}
                        {s.hasFrame ? "has a frame" : "no frame yet"}
                      </span>
                      {s.missing.map((m) => (
                        <span
                          key={m}
                          className={cn(
                            "block text-[11.5px]",
                            m.startsWith("No one is in this shot") ? "text-faint" : "text-warn",
                          )}
                        >
                          {m}
                        </span>
                      ))}
                    </span>
                    <Link href={s.href} className="text-[11.5px] text-accent hover:underline">
                      Open
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

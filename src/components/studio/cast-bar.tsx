import Link from "next/link";
import { cn } from "@/lib/utils";
import type { StudioSubject } from "@/server/reference-studio";

/**
 * Who or where the Studio is working on: every Character and Location of the project, each with the picture that
 * currently stands for it. A link per subject, so the choice is in the address and survives a reload.
 */
export function CastBar({
  base,
  subjects,
  selected,
}: {
  base: string;
  subjects: StudioSubject[];
  selected: { kind: string; id: string } | null;
}) {
  const group = (kind: StudioSubject["kind"], title: string) => {
    const list = subjects.filter((s) => s.kind === kind);
    if (list.length === 0) return null;
    return (
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[11px] text-muted">{title}</span>
        <ul className="flex gap-1.5">
          {list.map((s) => {
            const on = selected?.kind === s.kind && selected.id === s.id;
            return (
              <li key={s.id}>
                <Link
                  href={`${base}?subject=${s.kind}:${s.id}`}
                  aria-current={on ? "page" : undefined}
                  data-testid="studio-subject"
                  data-subject={`${s.kind}:${s.id}`}
                  className={cn(
                    "flex items-center gap-2 rounded-[3px] border py-1 pl-1 pr-2.5 transition-colors",
                    on
                      ? "border-accent bg-accent/10 text-fg"
                      : "border-line2 text-muted hover:border-muted hover:text-fg",
                  )}
                >
                  <span className="block h-8 w-8 shrink-0 overflow-hidden rounded-[2px] bg-[#232326]">
                    {s.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.thumbUrl} alt="" className="h-full w-full object-cover" />
                    ) : null}
                  </span>
                  <span className="whitespace-nowrap text-[12.5px] leading-tight">
                    {s.name}
                    <span className="block text-[10.5px] text-faint">
                      {s.images === 0 ? "no picture yet" : `${s.images} picture${s.images === 1 ? "" : "s"}`}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    );
  };
  return (
    <nav
      aria-label="Characters and locations"
      className="flex flex-wrap items-center gap-x-6 gap-y-2 overflow-x-auto border-b border-line px-6 py-2.5"
      data-testid="studio-cast"
    >
      {group("character", "Characters")}
      {group("location", "Locations")}
    </nav>
  );
}

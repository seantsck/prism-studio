import type { ReactNode } from "react";
import {
  CHARACTER_AI_FIELDS,
  PART_SIZE_LABEL,
  fieldMatters,
  type CharacterAiKey,
} from "@/domain/character-ai";
import type { PartSize } from "@/domain/schemas";
import { cn } from "@/lib/utils";

/**
 * One field of a Character's sheet, with what Prism uses it for and how to write it well. A field that does not matter
 * for this size of part is marked optional and shown quieter, so nobody feels they must fill it in.
 */
export function SheetField({
  k,
  size,
  extra,
  children,
}: {
  k: CharacterAiKey;
  size: PartSize;
  extra?: string;
  children: ReactNode;
}) {
  const f = CHARACTER_AI_FIELDS.find((x) => x.key === k)!;
  const matters = fieldMatters(k, size);
  return (
    <label
      className={cn("block", !matters && "opacity-60")}
      data-testid="sheet-field"
      data-field={k}
      data-optional={matters ? undefined : "1"}
    >
      <span className="mb-1 flex items-baseline gap-2 text-[11px] text-muted">
        {f.label}
        {matters ? null : (
          <span className="text-faint">optional for a {PART_SIZE_LABEL[size].toLowerCase()}</span>
        )}
      </span>
      {children}
      <span className="mt-0.5 block text-[10.5px] text-faint">
        {[f.uses, f.tip, extra].filter(Boolean).join(" ")}
      </span>
    </label>
  );
}

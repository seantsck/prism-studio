"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Phase 5B-S2: the screenplay (a Scene or the whole Episode) as read-only text the creator can SELECT. The selection
 * becomes the "Selection" target of the Ask Prism form (`formId`), as absolute offsets into the canonical screenplay
 * plus the selected text itself (the server verifies both still match before it builds the request).
 */
export function ScriptSelection({
  text,
  baseOffset,
  formId,
  rows = 22,
}: {
  text: string;
  baseOffset: number;
  formId: string;
  rows?: number;
}) {
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const capture = (el: HTMLTextAreaElement) => {
    const { selectionStart: a, selectionEnd: b } = el;
    if (b > a && el.value.slice(a, b).trim()) {
      setSel({ start: a, end: b });
      const radio = document.getElementById("scope-selection") as HTMLInputElement | null;
      if (radio) radio.checked = true;
    } else setSel(null);
  };
  // the native event too: a programmatic setSelectionRange (keyboard tools, tests) fires "select", not React's onSelect
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => capture(el);
    el.addEventListener("select", on);
    return () => el.removeEventListener("select", on);
  });
  const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;
  return (
    <div className="space-y-2">
      <textarea
        ref={ref}
        aria-label="Screenplay text"
        readOnly
        value={text}
        rows={rows}
        spellCheck={false}
        onSelect={(e) => capture(e.currentTarget)}
        onMouseUp={(e) => capture(e.currentTarget)}
        onKeyUp={(e) => capture(e.currentTarget)}
        className="w-full font-mono !text-[12.5px] leading-relaxed"
      />
      <input type="hidden" name="selStart" form={formId} value={sel ? baseOffset + sel.start : ""} />
      <input type="hidden" name="selEnd" form={formId} value={sel ? baseOffset + sel.end : ""} />
      <input type="hidden" name="selText" form={formId} value={sel ? text.slice(sel.start, sel.end) : ""} />
      <p className="text-[11.5px] text-muted" data-testid="selection-status">
        {sel
          ? `Selected ${sel.end - sel.start} characters (lines ${lineOf(sel.start)}–${lineOf(sel.end - 1)} of this view).`
          : "Select text to work on just that passage, or ask about the whole Scene."}
      </p>
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex h-6 items-center rounded-[3px] border border-line2 px-2 text-[12px] text-muted hover:text-fg"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

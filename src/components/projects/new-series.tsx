"use client";

import { useRef, useState } from "react";
import { ActionForm } from "@/components/action-form";
import { cn } from "@/lib/utils";
import { createProject } from "@/server/actions";

const TYPES = [
  ["series", "Series"],
  ["film", "Film"],
  ["short", "Short"],
] as const;

const LANGUAGES = [
  ["en", "English"],
  ["ja", "日本語"],
  ["es", "Español"],
  ["ko", "한국어"],
  ["fr", "Français"],
] as const;

/** Original starting ideas: a click puts one in the box to edit. */
const IDEAS = [
  "A retired stunt double in Osaka is hired to teach a pampered pop idol to fight, then learns someone really is hunting her.",
  "Two rival ramen shops on the same Tokyo street go to war when their heirs secretly start dating.",
  "A night-shift paramedic in 1990s Los Angeles keeps getting calls from a number that was disconnected years ago.",
  "On a generation ship, the AI wakes the one crew member who hates it most, because only she can find the saboteur.",
  "A disgraced chef cooks his way back with a food truck that only opens after midnight, and only for people in trouble.",
  "A Kyoto tea house is the last neutral ground between two yakuza families, until the owner's daughter takes a side.",
  "A small-town radio host starts receiving song requests from listeners who died decades ago.",
  "An heiress has thirty days to marry a stranger chosen by her late grandfather, or lose the family company.",
];

export interface DraftOffer {
  /** "provider/modelId" */
  model: string;
  label: string;
  paid: boolean;
  /** A ceiling for any premise the form accepts. */
  usd: number;
}

/**
 * The Projects page's one big box: describe a series and create it. Title is optional (the idea names it), the format
 * and language are one tap, and Prism can write Episode 1 straight after, at the price shown before anything runs.
 */
export function NewSeries({
  draft,
  draftOff,
  premiseMax,
}: {
  draft: DraftOffer | null;
  /** Why Prism can't write Episode 1 here (no real writing model switched on), shown in place of the switch. */
  draftOff: string | null;
  premiseMax: number;
}) {
  const [premise, setPremise] = useState("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState<string>("series");
  // a free model drafts by default; a paid one waits for the creator to turn it on
  const [writeIt, setWriteIt] = useState(!!draft && !draft.paid);
  const box = useRef<HTMLTextAreaElement>(null);
  const put = (text: string) => {
    setPremise(text);
    box.current?.focus();
  };
  const price = draft
    ? draft.paid
      ? `up to $${draft.usd < 0.01 ? draft.usd.toFixed(4) : draft.usd.toFixed(2)} with ${draft.label}`
      : `free with ${draft.label}`
    : null;
  const drafting = !!draft && writeIt && premise.trim().length > 0;

  return (
    <ActionForm action={createProject} successMessage="" className="w-full" data-testid="new-series">
      <input type="hidden" name="projectType" value={type} />
      {drafting ? (
        <>
          <input type="hidden" name="draftEpisode" value="1" />
          <input type="hidden" name="model" value={draft.model} />
          {draft.paid ? <input type="hidden" name="confirmedTotalUsd" value={draft.usd.toFixed(4)} /> : null}
        </>
      ) : null}

      <div className="new-series-card rounded-2xl border border-line2 bg-panel/90 shadow-[0_24px_80px_-32px_rgba(214,162,74,0.35)] backdrop-blur transition-colors focus-within:border-accent/60">
        <label htmlFor="premise" className="sr-only">
          Describe your series
        </label>
        <textarea
          id="premise"
          ref={box}
          name="premise"
          value={premise}
          onChange={(e) => setPremise(e.target.value)}
          maxLength={premiseMax}
          rows={4}
          placeholder="A shy sushi apprentice in Osaka secretly enters a televised cooking contest under a false name…"
          className="block w-full resize-none px-5 pb-2 pt-5 text-[16px] leading-relaxed placeholder:text-faint"
          data-testid="new-project-premise"
        />
        <div className="flex flex-wrap items-center gap-2 px-4 pt-1">
          <div className="flex rounded-full border border-line p-0.5" role="radiogroup" aria-label="Format">
            {TYPES.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={type === id}
                onClick={() => setType(id)}
                className={cn(
                  "rounded-full px-3 py-1 text-[12px] transition-colors",
                  type === id ? "bg-fg text-bg" : "text-muted hover:text-fg",
                )}
                data-testid={`new-series-type-${id}`}
              >
                {label}
              </button>
            ))}
          </div>
          <select
            name="defaultLanguage"
            defaultValue="en"
            aria-label="Dialogue language"
            className="hover:text-fg"
          >
            {LANGUAGES.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-3 px-4 pb-4 pt-3">
          {draft ? (
            <label
              className="flex cursor-pointer items-center gap-2 rounded-full px-2 py-1 text-[12px] text-muted hover:text-fg"
              data-testid="new-series-draft"
            >
              <span
                className={cn(
                  "relative inline-block h-4 w-7 rounded-full transition-colors",
                  writeIt ? "bg-accent" : "bg-line2",
                )}
                aria-hidden
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-3 w-3 rounded-full bg-bg transition-[left]",
                    writeIt ? "left-3.5" : "left-0.5",
                  )}
                />
              </span>
              <input
                type="checkbox"
                className="sr-only"
                checked={writeIt}
                onChange={(e) => setWriteIt(e.target.checked)}
                data-testid="new-series-draft-toggle"
              />
              <span>
                Prism writes Episode 1 next <span className="text-faint">· {price}</span>
              </span>
            </label>
          ) : draftOff ? (
            <span className="text-[12px] text-faint" data-testid="new-series-draft-off">
              {draftOff} Episode 1 starts empty; you can write it yourself.
            </span>
          ) : null}
          <button
            type="submit"
            className="ml-auto inline-flex h-9 items-center rounded-full bg-accent px-5 text-[13px] font-semibold text-accentfg transition-[filter] hover:brightness-110 disabled:opacity-40"
            disabled={!premise.trim() && !title.trim()}
            data-testid="new-series-create"
          >
            {drafting ? "Create and write Episode 1" : "Create"}
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2" data-testid="new-series-ideas">
        <button
          type="button"
          onClick={() => put(IDEAS[Math.floor(Math.random() * IDEAS.length)]!)}
          className="rounded-full border border-accent/40 px-3 py-1 text-[12px] text-accent hover:bg-accent/10"
          data-testid="new-series-inspire"
        >
          Inspire me
        </button>
        {IDEAS.slice(0, 3).map((idea) => (
          <button
            key={idea}
            type="button"
            onClick={() => put(idea)}
            title={idea}
            className="max-w-[16rem] truncate rounded-full border border-line px-3 py-1 text-[12px] text-muted hover:border-line2 hover:text-fg"
            data-testid="new-series-idea"
          >
            {idea}
          </button>
        ))}
      </div>

      <details className="mx-auto mt-5 max-w-xl text-[12px]" data-testid="new-series-more">
        <summary className="cursor-pointer text-center text-muted hover:text-fg">More options</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="sm:col-span-2">
            <span className="mb-1 block text-muted">
              Title (optional: your idea names it, and you can rename it later)
            </span>
            <input
              name="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Working title"
              data-testid="new-series-title"
            />
          </label>
          <label>
            <span className="mb-1 block text-muted">Genre</span>
            <input name="genre" placeholder="Action comedy" />
          </label>
          <label>
            <span className="mb-1 block text-muted">Tone</span>
            <input name="tone" placeholder="Warm, fast, a little absurd" />
          </label>
          <label className="sm:col-span-2">
            <span className="mb-1 block text-muted">Description</span>
            <textarea name="description" rows={2} />
          </label>
        </div>
      </details>
    </ActionForm>
  );
}

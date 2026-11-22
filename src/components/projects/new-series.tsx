"use client";

import { useRef, useState } from "react";
import { ActionForm } from "@/components/action-form";
import { cn } from "@/lib/utils";
import { DEFAULT_EPISODE_COUNT, EPISODE_COUNTS, MAX_EPISODES } from "@/domain/series-start";
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

/**
 * The Projects page's one big box: describe a series and create it. Title is optional (the idea names it); the format,
 * the number of Episodes and the language are one tap each. Writing happens on the next page, where every step shows
 * its price before it runs.
 */
/** A library Character (`cast`) or Location (`place`) the new project starts with. */
export interface SeriesCast {
  kind: "cast" | "place";
  id: string;
  name: string;
  thumbUrl: string | null;
}

export function NewSeries({ premiseMax, cast = [] }: { premiseMax: number; cast?: SeriesCast[] }) {
  const [starring, setStarring] = useState(cast);
  const [premise, setPremise] = useState("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState<string>("series");
  const [count, setCount] = useState<number>(DEFAULT_EPISODE_COUNT);
  const box = useRef<HTMLTextAreaElement>(null);
  const put = (text: string) => {
    setPremise(text);
    box.current?.focus();
  };
  return (
    <ActionForm action={createProject} successMessage="" className="w-full" data-testid="new-series">
      <input type="hidden" name="projectType" value={type} />
      {type === "series" ? <input type="hidden" name="episodeCount" value={count} /> : null}

      {starring.map((c) => (
        <input key={`${c.kind}-${c.id}`} type="hidden" name={c.kind} value={c.id} />
      ))}
      {starring.length ? (
        <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="new-series-cast">
          <span className="text-[12px] text-muted">Starting with</span>
          {starring.map((c) => (
            <span
              key={`${c.kind}-${c.id}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 py-0.5 pl-0.5 pr-2 text-[12px]"
              data-testid="new-series-cast-member"
              data-name={c.name}
            >
              {c.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.thumbUrl} alt="" className="h-5 w-5 rounded-full object-cover" />
              ) : (
                <span className="h-5 w-5 rounded-full bg-panel2" aria-hidden />
              )}
              {c.name}
              <button
                type="button"
                onClick={() => setStarring((list) => list.filter((x) => x !== c))}
                className="text-faint hover:text-fg"
                aria-label={`Leave out ${c.name}`}
              >
                ×
              </button>
            </span>
          ))}
          <span className="w-full text-[11.5px] text-faint">
            They are added to the new project, and your description is saved with their names so the story is
            about them.
          </span>
        </div>
      ) : null}
      <div className="new-series-card rounded-2xl border border-line2 bg-panel/90 shadow-[0_24px_80px_-32px_rgba(214,162,74,0.35)] backdrop-blur transition-colors focus-within:border-accent/60">
        <label htmlFor="new-series-title" className="sr-only">
          Title
        </label>
        <input
          id="new-series-title"
          name="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
          placeholder="Title (optional: your idea names it)"
          className="block w-full px-5 pt-4 text-[18px] font-semibold tracking-tight placeholder:font-normal placeholder:text-faint"
          data-testid="new-series-title"
        />
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
          className="block w-full resize-none px-5 pb-2 pt-2 text-[16px] leading-relaxed placeholder:text-faint"
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
          {type === "series" ? (
            <div className="flex items-center gap-1" role="radiogroup" aria-label="Episodes">
              {EPISODE_COUNTS.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={count === n}
                  onClick={() => setCount(n)}
                  className={cn(
                    "h-7 min-w-7 rounded-full px-2 text-[12px] transition-colors",
                    count === n ? "bg-fg text-bg" : "text-muted hover:text-fg",
                  )}
                  data-testid={`new-series-episodes-${n}`}
                >
                  {n}
                </button>
              ))}
              <label className="ml-1 flex items-center gap-1 text-[12px] text-muted">
                <span className="sr-only">Number of episodes</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_EPISODES}
                  value={count}
                  onChange={(e) =>
                    setCount(Math.max(1, Math.min(MAX_EPISODES, Math.round(Number(e.target.value) || 1))))
                  }
                  className="new-series-count"
                  aria-label="Number of episodes"
                  data-testid="new-series-episodes-input"
                />
                episodes
              </label>
            </div>
          ) : (
            <span className="text-[12px] text-muted">One screenplay</span>
          )}
          <button
            type="submit"
            className="ml-auto inline-flex h-9 items-center rounded-full bg-accent px-5 text-[13px] font-semibold text-accentfg transition-[filter] hover:brightness-110 disabled:opacity-40"
            disabled={!premise.trim() && !title.trim()}
            data-testid="new-series-create"
          >
            Create
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

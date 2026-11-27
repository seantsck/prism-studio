"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { priceText } from "@/domain/pricing/user-price";
import {
  CHARACTER_NAME_MAX,
  CHARACTER_PROMPT_MAX,
  CREATE_PHOTOS_MAX,
  LOCATION_NAME_MAX,
  LOCATION_PROMPT_MAX,
  PHOTO_ADVICE,
  photoCountNote,
} from "@/domain/standalone-character";
import { preparePhoto, type Prepared } from "@/components/studio/photo-upload";
import { createStandaloneCharacter, createStandaloneLocation } from "@/server/library-actions";
import { uploadReferencePhoto } from "@/server/reference-studio-actions";

type Kind = "character" | "location";

interface Photo {
  key: number;
  name: string;
  preview: string;
  /** null while it is being read. */
  ready: Prepared | null;
}

const TEXT: Record<Kind, { title: string; hint: string; placeholder: string; button: string }> = {
  character: {
    title: "Create an actor",
    hint: "Who they are and how they look. Their role is set in each project you add them to.",
    placeholder:
      "Takumi, late 20s, Japanese, lean build, short black hair swept back, calm eyes, navy overcoat over a white shirt.",
    button: "Create actor",
  },
  location: {
    title: "Create a location",
    hint: "What the place looks and feels like. Use it in any project.",
    placeholder:
      "A rain-soaked alley in Shinjuku at night, neon signs reflected in puddles, steam rising from a ramen stall.",
    button: "Create location",
  },
};

/**
 * The home page's smaller boxes beside the series box: make a character or a location on its own, outside any story,
 * with photos if the creator has them. It is created first; then each photo is uploaded on its own request (a hosted
 * request carries only a few megabytes, and the browser makes an upright, smaller copy of a large phone photo, exactly
 * as the Reference Studio does), and its page opens: the character's own page, from where it joins a project.
 */
/** The price of "Have Prism fill in the details" (worked out on the server before the box is shown). */
export type FillOffer =
  { ok: true; model: string; label: string; paid: boolean; usd: number } | { ok: false; reason: string };

function SubjectBox({ kind, maxUploadBytes, fill }: { kind: Kind; maxUploadBytes: number; fill: FillOffer }) {
  const [fillIt, setFillIt] = useState(fill.ok);
  const router = useRouter();
  const t = TEXT[kind];
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leftOut, setLeftOut] = useState<{ href: string; failed: string[] } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const held = urls.current;
    return () => {
      for (const u of held) URL.revokeObjectURL(u);
    };
  }, []);

  const choose = (files: File[]) => {
    const room = Math.max(0, CREATE_PHOTOS_MAX - photos.length);
    const taken = files.filter((f) => f.type.startsWith("image/")).slice(0, room);
    const fresh = taken.map((f) => {
      const preview = URL.createObjectURL(f);
      urls.current.add(preview);
      seq.current += 1;
      return { key: seq.current, name: f.name, preview, ready: null } as Photo;
    });
    setPhotos((list) => [...list, ...fresh]);
    void (async () => {
      for (const [i, p] of fresh.entries()) {
        const ready = await preparePhoto(taken[i]!, maxUploadBytes);
        setPhotos((list) => list.map((x) => (x.key === p.key ? { ...x, ready } : x)));
      }
    })();
  };
  const remove = (key: number) => setPhotos((list) => list.filter((p) => p.key !== key));

  const reading = photos.some((p) => !p.ready);
  const usable = photos.filter((p) => p.ready?.ok);
  const note = photoCountNote(kind, usable.length);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || reading) return;
    setError(null);
    setBusy("Creating…");
    const form = new FormData(e.currentTarget);
    form.delete("photos");
    let made: Awaited<ReturnType<typeof createStandaloneCharacter>>;
    try {
      made = await (kind === "character" ? createStandaloneCharacter(form) : createStandaloneLocation(form));
    } catch {
      made = { ok: false, error: "That did not reach Prism. Check your connection and try again." };
    }
    if (!made.ok || !made.created) {
      setBusy(null);
      setError(made.ok ? "Something went wrong. Try again." : made.error);
      return;
    }
    const { created } = made;
    const failed: string[] = [];
    for (const [i, p] of usable.entries()) {
      if (!p.ready?.ok) continue;
      setBusy(`Uploading photo ${i + 1} of ${usable.length}…`);
      const f = new FormData();
      f.set("projectSlug", created.slug);
      f.set("subjectKind", kind);
      f.set("subjectId", created.id);
      f.set("as", "reference");
      f.set("file", p.ready.file, p.ready.file.name);
      if (p.ready.copy) f.set("copyOf", JSON.stringify(p.ready.copy));
      try {
        const r = await uploadReferencePhoto(f);
        if (!r.ok) failed.push(`${p.name}: ${r.error}`);
      } catch {
        failed.push(`${p.name}: the upload did not reach Prism.`);
      }
    }
    if (failed.length) {
      setBusy(null);
      setLeftOut({ href: created.href, failed });
      return;
    }
    setBusy("Opening…");
    router.push(created.href);
  };

  if (leftOut)
    return (
      <div
        className="rounded-xl border border-warn/50 bg-panel/90 p-4 text-[12.5px]"
        data-testid={`new-${kind}-partial`}
      >
        <p className="font-medium">
          Created, but {leftOut.failed.length} photo{leftOut.failed.length === 1 ? "" : "s"} could not be
          added:
        </p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted">
          {leftOut.failed.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => router.push(leftOut.href)}
          className="mt-3 inline-flex h-8 items-center rounded-full bg-accent px-4 text-[12.5px] font-semibold text-accentfg"
        >
          Open it and add them there
        </button>
      </div>
    );

  return (
    <form onSubmit={submit} className="w-full" data-testid={`new-${kind}`}>
      <div className="new-subject-card rounded-xl border border-line2 bg-panel/90 backdrop-blur transition-colors focus-within:border-accent/60">
        <label
          htmlFor={`new-${kind}-prompt`}
          className="block px-4 pt-3 text-[14px] font-semibold tracking-tight"
        >
          {t.title}
        </label>
        <p className="px-4 pt-0.5 text-[11.5px] leading-snug text-muted">{t.hint}</p>
        <textarea
          id={`new-${kind}-prompt`}
          name="prompt"
          rows={4}
          required
          maxLength={kind === "character" ? CHARACTER_PROMPT_MAX : LOCATION_PROMPT_MAX}
          placeholder={t.placeholder}
          className="block w-full resize-none text-[13.5px] leading-relaxed placeholder:text-faint"
          data-testid={`new-${kind}-prompt`}
        />
        <div className="px-3">
          <input
            name="name"
            maxLength={kind === "character" ? CHARACTER_NAME_MAX : LOCATION_NAME_MAX}
            placeholder="Name (optional)"
            aria-label="Name (optional)"
            className="w-full text-[12px] placeholder:text-faint"
            data-testid={`new-${kind}-name`}
          />
        </div>

        <div
          className="mx-3 mt-2 rounded-lg border border-dashed border-line p-2"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            choose(Array.from(e.dataTransfer.files));
          }}
        >
          <input
            ref={input}
            type="file"
            name="photos"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={(e) => {
              choose(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
            data-testid={`new-${kind}-photos`}
          />
          {photos.length ? (
            <ul className="mb-2 grid grid-cols-4 gap-1.5" data-testid={`new-${kind}-photo-list`}>
              {photos.map((p) => (
                <li key={p.key} className="relative aspect-square overflow-hidden rounded-[4px] bg-[#232326]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.preview}
                    alt=""
                    className={cn("h-full w-full object-cover", p.ready && !p.ready.ok && "opacity-30")}
                  />
                  {!p.ready ? (
                    <Loader2
                      className="absolute inset-0 m-auto h-4 w-4 animate-spin text-fg"
                      aria-label="Reading"
                    />
                  ) : !p.ready.ok ? (
                    <span
                      className="absolute inset-x-0 bottom-0 bg-black/75 px-1 text-[9px] leading-tight text-warn"
                      title={p.ready.message}
                    >
                      can&apos;t use
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => remove(p.key)}
                    disabled={!!busy}
                    className="absolute right-0.5 top-0.5 rounded-full bg-black/70 p-0.5 text-fg hover:bg-black"
                    aria-label={`Remove ${p.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={!!busy || photos.length >= CREATE_PHOTOS_MAX}
            className="flex w-full items-center justify-center gap-1.5 rounded-md py-1 text-[12px] text-muted hover:text-fg disabled:opacity-40"
            data-testid={`new-${kind}-add-photos`}
          >
            <ImagePlus className="h-3.5 w-3.5" /> {photos.length ? "Add more photos" : "Add photos"}
          </button>
          <p className="mt-1 text-[11px] leading-snug text-faint">{PHOTO_ADVICE[kind].text}</p>
          <p
            className={cn(
              "mt-0.5 text-[11px]",
              note.tone === "pass" ? "text-pass" : note.tone === "warn" ? "text-warn" : "text-faint",
            )}
            data-testid={`new-${kind}-photo-note`}
          >
            {note.text}
          </p>
        </div>

        {fill.ok ? (
          <label
            className="mx-3 mt-2 flex items-start gap-2 text-[11.5px] leading-snug"
            data-testid={`new-${kind}-fill`}
          >
            <input
              type="checkbox"
              name="fill"
              value="1"
              checked={fillIt}
              onChange={(e) => setFillIt(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Have Prism fill in the details{" "}
              <span className="font-medium" data-testid={`new-${kind}-fill-price`}>
                · {fill.paid ? priceText(fill.usd) : "free"}
              </span>
              <span className="block text-faint">
                {kind === "character"
                  ? "Personality, how they move and speak, a precise look for pictures, a signature habit. You review it before anything changes."
                  : "Layout, zones and entrances, lighting, props. You review it before anything changes."}
              </span>
            </span>
          </label>
        ) : null}
        {fill.ok ? (
          <>
            <input type="hidden" name="fillModel" value={fill.model} />
            {fill.paid ? <input type="hidden" name="fillConfirmedUsd" value={fill.usd.toFixed(4)} /> : null}
          </>
        ) : null}
        <div className="flex items-center gap-2 px-3 pb-3 pt-2">
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted" aria-live="polite">
            {busy ?? (error ? <span className="text-fail">{error}</span> : null)}
          </span>
          <button
            type="submit"
            disabled={!!busy || reading}
            className="inline-flex h-8 shrink-0 items-center rounded-full bg-accent px-4 text-[12.5px] font-semibold text-accentfg transition-[filter] hover:brightness-110 disabled:opacity-40"
            data-testid={`new-${kind}-create`}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t.button}
          </button>
        </div>
      </div>
    </form>
  );
}

export function NewCharacter({ maxUploadBytes, fill }: { maxUploadBytes: number; fill: FillOffer }) {
  return <SubjectBox kind="character" maxUploadBytes={maxUploadBytes} fill={fill} />;
}

export function NewLocation({ maxUploadBytes, fill }: { maxUploadBytes: number; fill: FillOffer }) {
  return <SubjectBox kind="location" maxUploadBytes={maxUploadBytes} fill={fill} />;
}

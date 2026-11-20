"use client";

import { useEffect, useState, type DragEvent } from "react";
import { ActionForm } from "@/components/action-form";
import { RefreshWhileActive } from "@/components/images/refresh-while-active";
import { Button } from "@/components/ui";
import {
  closestFormat,
  editPresets,
  formatLabel,
  preferredFormat,
  referencePresets,
  typicalCost,
  usd,
  type EditPresetId,
  type ReferenceQuote,
} from "@/domain/generation/reference-studio";
import { cn } from "@/lib/utils";
import type { StudioModel, StudioState, StudioTake } from "@/server/reference-studio";
import { quoteReferenceImage } from "@/server/reference-studio-actions";
import { removeBackground, startSubjectImage } from "@/server/subject-image-actions";
import { usePhotoUpload } from "./photo-upload";
import { SourcePicker } from "./source-picker";
import { Stage } from "./stage";

const ACTIVE = new Set(["queued", "running"]);

/**
 * The Reference Studio workspace for ONE Character or Location: a brief on the left (what to start from, what to make
 * or change, the picture format, quality and model, and the price), and the stage on the right (the starting image
 * beside the result, then every take). It drives the existing Character / Location image pipeline; it adds no second
 * one. Nothing is promoted to the Visual Bible without an explicit "Use as…".
 */
export function ReferenceStudio({
  slug,
  state,
  initial,
  locationViewKinds,
  maxUploadBytes,
}: {
  slug: string;
  state: StudioState;
  initial: { make?: string; look?: string; from?: string; change?: string };
  locationViewKinds: Array<{ id: string; label: string }>;
  maxUploadBytes: number;
}) {
  const subject = state.selected!;
  const kind = subject.kind;
  const presets = referencePresets(kind);
  const edits = editPresets(kind);
  const images = state.images.filter((i) => !i.rejected);
  const available = state.models.filter((m) => m.available);
  const has = (id: string | undefined) => !!id && images.some((i) => i.assetId === id);

  const [mode, setMode] = useState<"make" | "change">(has(initial.change) ? "change" : "make");
  const [sourceIds, setSourceIds] = useState<string[]>(() => {
    if (has(initial.change)) return [initial.change!];
    if (has(initial.from)) return [initial.from!];
    // the picture that already defines the subject, else the first photograph the creator added
    const canonical = images.find((i) => i.roles.some((r) => r.startsWith("Canonical")));
    const uploaded = images.find((i) => i.origin === "uploaded");
    const first = canonical ?? uploaded;
    return first ? [first.assetId] : [];
  });
  const [intent, setIntent] = useState<string>(
    presets.some((p) => p.intent === initial.make) ? initial.make! : presets[0]!.intent,
  );
  const [presetValue, setPresetValue] = useState("");
  const [lookId, setLookId] = useState(subject.looks.some((l) => l.id === initial.look) ? initial.look! : "");
  const [direction, setDirection] = useState("");
  // "cutout" is not a generated change: it is Prism's own background removal, which keeps the original pixels
  const [editId, setEditId] = useState<EditPresetId | "cutout">(edits[0]!.id);
  const [editValue, setEditValue] = useState("");
  const [modelChoice, setModelChoice] = useState("");
  const [quality, setQuality] = useState("");
  const [formatChoice, setFormatChoice] = useState("auto");
  const [transparent, setTransparent] = useState(false);
  /** null = the newest take */
  const [focusId, setFocusId] = useState<string | null>(null);
  // A photograph the creator has just added becomes the starting image (they added it to use it): the first of a
  // batch, as soon as the refreshed page carries it.
  const [wanted, setWanted] = useState<string | null>(null);
  if (wanted && images.some((i) => i.assetId === wanted)) {
    setWanted(null);
    setSourceIds([wanted]);
  }
  const upload = usePhotoUpload({ slug, subject, maxUploadBytes, onAdded: setWanted });
  // files dragged anywhere over the Studio are for the upload area (and never open in place of the page)
  const [dragging, setDragging] = useState(false);
  const carriesFiles = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer.types).includes("Files");

  const preset = presets.find((p) => p.intent === intent) ?? presets[0]!;
  const edit = edits.find((e) => e.id === editId) ?? edits[0]!;
  const editChosen = (id: string) => !cuttingOut && id === edit.id;
  const sources = sourceIds.flatMap((id) => images.filter((i) => i.assetId === id));
  const changing = mode === "change";
  const cuttingOut = changing && editId === "cutout" && kind === "character";
  // what the request needs from a model: an image to work from, or words alone
  const needsImages =
    changing ||
    sources.length > 0 ||
    (!!lookId && (subject.looks.find((l) => l.id === lookId)?.references ?? 0) > 0);
  const fits = (m: StudioModel) => (needsImages ? m.images : m.text);
  // Prism suggests a free model that can do this first; the creator's own choice is never replaced
  const suggested = available.find((m) => fits(m) && !m.paid) ?? available.find(fits) ?? available[0] ?? null;
  const model = available.find((m) => m.value === modelChoice) ?? suggested;
  const autoFormat = model
    ? changing
      ? closestFormat(sources[0]?.inspection.width, sources[0]?.inspection.height, model.formats)
      : preferredFormat(preset.ratios, model.formats)
    : null;
  const format =
    model && formatChoice !== "auto" && model.formats.includes(formatChoice) ? formatChoice : autoFormat;
  const qualityId = model?.qualities.some((q) => q.id === quality) ? quality : "";
  // an edit comes back in one of the model's shapes: say so when that is not the picture's own shape
  const reframed = (() => {
    const w = sources[0]?.inspection.width;
    const h = sources[0]?.inspection.height;
    const [fw, fh] = (format ?? "").split(":").map(Number);
    if (!changing || !w || !h || !fw || !fh) return null;
    return Math.abs(Math.log(w / h / (fw / fh))) > 0.03
      ? `Your image is ${w} × ${h}. The closest shape this model makes is ${format}, so its edges will be re-framed slightly.`
      : null;
  })();

  const problem = cuttingOut
    ? sources.length === 0
      ? "Choose the image to cut out."
      : null
    : !model
      ? "No image model is available on this server."
      : changing && sources.length === 0
        ? "Choose the image to change."
        : !changing && preset.needsLook && subject.looks.length > 0 && !lookId
          ? "Choose the Look to show."
          : null;

  /** The request as it stands: the same fields price it (a read) and submit it. */
  const fields: Array<[string, string]> | null = (() => {
    if (!model || problem || cuttingOut) return null;
    const f: Array<[string, string]> = [
      ["projectSlug", slug],
      ["subjectKind", kind],
      ["subjectId", subject.id],
      ["model", model.value],
      ["aspectRatio", format ?? ""],
    ];
    if (qualityId) f.push(["quality", qualityId]);
    if (transparent && model.transparency) f.push(["transparent", "1"]);
    if (changing) {
      // an edit has no composition of its own; the intent only says whose picture it is
      f.push(["intent", presets[0]!.intent], ["sourceAssetId", sources[0]!.assetId]);
      f.push(["editPreset", edit.id], ["editValue", editValue]);
      if (edit.usesLook && lookId) f.push(["lookId", lookId]);
      if (direction.trim()) f.push(["direction", direction]);
    } else {
      f.push(["intent", preset.intent], ["sources", "chosen"], ["presetValue", presetValue]);
      for (const i of sources) f.push(["startAssetId", i.assetId]);
      if (lookId) f.push(["lookId", lookId]);
      f.push(["direction", direction]);
    }
    return f;
  })();
  // a refused submission (the price moved, a limit was hit) reads the price again instead of leaving a stale one
  const [requote, setRequote] = useState(0);
  const fieldsKey = fields ? JSON.stringify([requote, fields]) : "";

  // The price and exactly what will be sent, for the request as it stands. A read: nothing is queued.
  const [quoted, setQuoted] = useState<{ key: string; quote: ReferenceQuote } | null>(null);
  useEffect(() => {
    if (!fieldsKey) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const form = new FormData();
      const [, pairs] = JSON.parse(fieldsKey) as [number, Array<[string, string]>];
      for (const [k, v] of pairs) form.append(k, v);
      let quote: ReferenceQuote;
      try {
        quote = await quoteReferenceImage(form);
      } catch {
        quote = { ok: false, reasons: ["The price could not be worked out. Try again in a moment."] };
      }
      if (!cancelled) setQuoted({ key: fieldsKey, quote });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fieldsKey]);
  const quote = quoted && quoted.key === fieldsKey ? quoted.quote : null;
  const pricing = !!fieldsKey && !quote;
  const typical =
    quote?.ok && quote.paid && model
      ? typicalCost(state.costHistory, {
          provider: model.provider,
          model: model.modelId,
          quality: qualityId || model.defaultQuality,
          references: quote.sending.length,
        })
      : null;

  const active = state.takes.some((t) => ACTIVE.has(t.status));
  const focused = state.takes.find((t) => t.attemptId === focusId) ?? state.takes[0] ?? null;

  const toggleSource = (assetId: string) => {
    if (changing) setSourceIds([assetId]);
    else
      setSourceIds((ids) => (ids.includes(assetId) ? ids.filter((x) => x !== assetId) : [...ids, assetId]));
  };
  const startFrom = (assetId: string) => {
    setMode("make");
    setSourceIds([assetId]);
  };
  const change = (assetId: string) => {
    setMode("change");
    setSourceIds([assetId]);
  };
  /** Loads a take's request back into the brief (nothing is sent until Generate is pressed). */
  const reuse = (take: StudioTake) => {
    const s = take.settings;
    const keep = (ids: string[]) => ids.filter((id) => images.some((i) => i.assetId === id));
    if (take.operation === "cutout") {
      setMode("change");
      setSourceIds(keep(take.inputs.slice(0, 1).map((i) => i.assetId)));
      setEditId("cutout");
      return;
    }
    if (s.editSourceAssetId) {
      setMode("change");
      setSourceIds(keep([s.editSourceAssetId]));
      const id = edits.find((e) => e.id === s.composer.editPreset)?.id ?? "custom";
      setEditId(id);
      setEditValue(s.composer.editValue ?? "");
    } else {
      setMode("make");
      setSourceIds(keep(s.sourceAssetIds));
      if (presets.some((p) => p.intent === s.intent)) setIntent(s.intent);
      setPresetValue(s.composer.presetValue ?? "");
    }
    setLookId(s.lookId && subject.looks.some((l) => l.id === s.lookId) ? s.lookId : "");
    setDirection(s.composer.direction ?? "");
    setModelChoice(`${take.provider}/${take.model}`);
    setQuality(s.quality ?? "");
    setFormatChoice(s.aspectRatio ?? "auto");
    setTransparent(s.transparent);
  };

  const chip = (on: boolean) =>
    cn(
      "rounded-[3px] border px-2 py-1 text-left text-[12px] transition-colors",
      on ? "border-accent bg-accent/10 text-fg" : "border-line2 text-muted hover:border-muted hover:text-fg",
    );
  const param = cuttingOut ? undefined : changing ? edit.param : preset.param;

  return (
    <div
      className="grid gap-4 p-6 xl:grid-cols-[minmax(340px,400px)_1fr]"
      data-testid="reference-studio"
      data-subject={`${kind}:${subject.id}`}
      onDragOver={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        upload.add(Array.from(e.dataTransfer.files));
      }}
    >
      <RefreshWhileActive active={active} />

      {/* ───────── the brief ───────── */}
      <section
        className="self-start rounded-[3px] border border-line bg-panel"
        aria-label="Brief"
        data-testid="studio-brief"
      >
        <div className="space-y-4 p-3">
          <SourcePicker
            subject={subject}
            images={images}
            selected={sourceIds}
            single={changing}
            maxUploadBytes={maxUploadBytes}
            upload={upload}
            dragging={dragging}
            onToggle={toggleSource}
            onClear={() => setSourceIds([])}
          />

          <div>
            <div className="mb-2 flex gap-1" role="tablist" aria-label="What to do">
              {(
                [
                  ["make", "Make a reference"],
                  ["change", "Change an image"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={mode === id}
                  data-testid={`studio-mode-${id}`}
                  onClick={() => setMode(id)}
                  className={cn(
                    "rounded-[3px] px-2.5 py-1 text-[12px] font-medium",
                    mode === id ? "bg-panel2 text-fg" : "text-muted hover:text-fg",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div
              className="grid grid-cols-2 gap-1.5"
              data-testid={changing ? "studio-edits" : "studio-presets"}
            >
              {changing
                ? edits.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      aria-pressed={editChosen(e.id)}
                      data-testid={`studio-edit-${e.id}`}
                      onClick={() => {
                        setEditId(e.id);
                        setEditValue("");
                      }}
                      className={chip(editChosen(e.id))}
                    >
                      <span className="block font-medium">{e.label}</span>
                      <span className="block text-[10.5px] text-faint">{e.hint}</span>
                    </button>
                  ))
                : null}
              {changing && kind === "character" ? (
                <button
                  type="button"
                  aria-pressed={cuttingOut}
                  data-testid="studio-edit-cutout"
                  onClick={() => setEditId("cutout")}
                  className={chip(cuttingOut)}
                >
                  <span className="block font-medium">Cut out the person</span>
                  <span className="block text-[10.5px] text-faint">
                    Original pixels, transparent background
                  </span>
                </button>
              ) : null}
              {changing
                ? null
                : presets.map((p) => (
                    <button
                      key={p.intent}
                      type="button"
                      aria-pressed={p.intent === preset.intent}
                      data-testid={`studio-preset-${p.intent}`}
                      onClick={() => {
                        setIntent(p.intent);
                        setPresetValue("");
                      }}
                      className={chip(p.intent === preset.intent)}
                    >
                      <span className="block font-medium">{p.label}</span>
                      <span className="block text-[10.5px] text-faint">{p.hint}</span>
                    </button>
                  ))}
            </div>
          </div>

          {param ? (
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted">{param.label}</span>
              {changing && edit.id === "custom" ? (
                <textarea
                  rows={3}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  placeholder={param.placeholder}
                  data-testid="studio-value"
                />
              ) : (
                <input
                  value={changing ? editValue : presetValue}
                  onChange={(e) => (changing ? setEditValue : setPresetValue)(e.target.value)}
                  placeholder={param.placeholder}
                  list="studio-suggestions"
                  data-testid="studio-value"
                />
              )}
              <datalist id="studio-suggestions">
                {param.suggestions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </label>
          ) : null}

          {kind === "character" && subject.looks.length > 0 && !cuttingOut && (!changing || edit.usesLook) ? (
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted">
                {changing ? "Or apply a Look" : "Wardrobe"}
              </span>
              <select value={lookId} onChange={(e) => setLookId(e.target.value)} data-testid="studio-look">
                <option value="">
                  {changing || sources.length === 0 ? "No Look" : "As in the starting image"}
                </option>
                {subject.looks.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.references > 0 ? ` (${l.references} image${l.references === 1 ? "" : "s"})` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className={cn("block", cuttingOut ? "hidden" : "")}>
            <span className="mb-1 block text-[11px] text-muted">
              {changing ? "Anything else to change (optional)" : "Direction (optional)"}
            </span>
            <textarea
              rows={3}
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
              placeholder={
                changing
                  ? "Leave empty to change only what you chose above"
                  : "Anything the picture should show that the preset does not say"
              }
              data-testid="studio-direction"
            />
          </label>

          <div className={cn("grid grid-cols-2 gap-2", cuttingOut ? "hidden" : "")}>
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted">Format</span>
              <select
                value={
                  formatChoice !== "auto" && model?.formats.includes(formatChoice) ? formatChoice : "auto"
                }
                onChange={(e) => setFormatChoice(e.target.value)}
                data-testid="studio-format"
              >
                <option value="auto">{autoFormat ? `Auto: ${formatLabel(autoFormat)}` : "Auto"}</option>
                {(model?.formats ?? []).map((r) => (
                  <option key={r} value={r}>
                    {formatLabel(r)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted">Quality</span>
              <select
                value={qualityId}
                onChange={(e) => setQuality(e.target.value)}
                disabled={(model?.qualities.length ?? 0) === 0}
                data-testid="studio-quality"
              >
                <option value="">
                  {model?.qualities.length
                    ? `Standard (${model.qualities.find((q) => q.id === model.defaultQuality)?.label ?? "default"})`
                    : "One quality"}
                </option>
                {(model?.qualities ?? []).map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="col-span-2 block">
              <span className="mb-1 block text-[11px] text-muted">Model</span>
              <select
                value={model?.value ?? ""}
                onChange={(e) => setModelChoice(e.target.value)}
                data-testid="studio-model"
              >
                {state.models.map((m) => (
                  <option key={m.value} value={m.value} disabled={!m.available}>
                    {m.label}
                    {m.test ? " (test)" : m.paid ? " (paid)" : ""}
                    {m.available ? "" : ` — ${m.unavailable}`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {reframed ? (
            <p className="text-[11px] text-muted" data-testid="studio-reframed">
              {reframed}
            </p>
          ) : null}
          {model?.transparency && !cuttingOut ? (
            <label className="flex items-center gap-1.5 text-[12px] text-muted">
              <input
                type="checkbox"
                checked={transparent}
                onChange={(e) => setTransparent(e.target.checked)}
                data-testid="studio-transparent"
              />
              Transparent background
            </label>
          ) : null}
        </div>
        <div
          className={cn(
            "sticky bottom-0 space-y-2 rounded-b-[3px] border-t border-line bg-panel p-3",
            cuttingOut ? "" : "hidden",
          )}
        >
          {problem ? (
            <p className="text-[12px] text-warn" data-testid="studio-problem">
              {problem}
            </p>
          ) : (
            <p className="text-[12px] text-muted" data-testid="studio-cutout-note">
              No charge. Prism&apos;s own tool keeps the original pixels and removes a plain background. A
              busy background is refused; &ldquo;Clean studio background&rdquo; redraws it instead.
            </p>
          )}
          <ActionForm action={removeBackground} successMessage="Queued" quiet>
            <input type="hidden" name="projectSlug" value={slug} />
            <input type="hidden" name="subjectId" value={subject.id} />
            <input type="hidden" name="sourceAssetId" value={sources[0]?.assetId ?? ""} />
            <Button
              type="submit"
              variant="primary"
              className="h-9 w-full text-[13px]"
              disabled={!!problem}
              onClick={() => setFocusId(null)}
              data-testid="studio-cutout"
            >
              Remove background
            </Button>
          </ActionForm>
        </div>
        <div
          className={cn(
            "sticky bottom-0 space-y-2 rounded-b-[3px] border-t border-line bg-panel p-3",
            cuttingOut ? "hidden" : "",
          )}
        >
          <Price
            problem={problem}
            pricing={pricing}
            quote={quote}
            model={model}
            typical={typical}
            images={state.images}
          />

          <ActionForm
            action={startSubjectImage}
            successMessage="Queued"
            quiet
            onResult={(r) => {
              if (!r.ok) setRequote((n) => n + 1);
            }}
          >
            {(fields ?? []).map(([k, v], i) => (
              <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
            ))}
            {quote?.ok && quote.paid && quote.estimateUsd != null ? (
              <input type="hidden" name="confirmedTotalUsd" value={String(quote.estimateUsd)} />
            ) : null}
            <Button
              type="submit"
              variant="primary"
              className="h-9 w-full text-[13px]"
              disabled={!quote?.ok}
              onClick={() => setFocusId(null)}
              data-testid="studio-generate"
              data-paid={quote?.ok && quote.paid ? "true" : "false"}
            >
              {quote?.ok && quote.paid
                ? `${changing ? "Change" : "Generate"} · up to ${usd(quote.estimateUsd)}`
                : changing
                  ? "Change image"
                  : "Generate"}
            </Button>
          </ActionForm>
        </div>
      </section>

      {/* ───────── the stage ───────── */}
      <Stage
        slug={slug}
        subject={subject}
        takes={state.takes}
        images={state.images}
        focused={focused}
        starting={sources}
        hostedMatting={state.hostedMatting}
        locationViewKinds={locationViewKinds}
        shots={state.shots}
        onFocus={setFocusId}
        onStartFrom={startFrom}
        onChange={change}
        onReuse={reuse}
        onChoosePhotos={upload.choose}
        dragging={dragging}
      />
    </div>
  );
}

/** The dollar line: what this request costs at most, what images like it really cost here, and what will be sent. */
function Price({
  problem,
  pricing,
  quote,
  model,
  typical,
  images,
}: {
  problem: string | null;
  pricing: boolean;
  quote: ReferenceQuote | null;
  model: StudioModel | null;
  typical: ReturnType<typeof typicalCost>;
  images: StudioState["images"];
}) {
  if (problem)
    return (
      <p className="text-[12px] text-warn" data-testid="studio-problem">
        {problem}
      </p>
    );
  if (pricing || !quote)
    return (
      <p className="text-[12px] text-muted" data-testid="studio-price" data-state="pricing">
        Working out the price…
      </p>
    );
  if (!quote.ok)
    return (
      <p className="text-[12px] text-warn" role="alert" data-testid="studio-problem">
        {quote.reasons.join(" ")}
      </p>
    );
  const thumb = new Map(images.map((i) => [i.assetId, i.url]));
  return (
    <div className="space-y-1.5 text-[12px]" data-testid="studio-price" data-state="ready">
      {quote.paid ? (
        <p>
          <span className="font-medium" data-testid="studio-estimate">
            Up to {usd(quote.estimateUsd)}
          </span>
          <span className="text-muted">
            {" "}
            for this image.{" "}
            {typical ? (
              <span data-testid="studio-typical">
                Images like it have cost about {usd(typical.usd)} here ({typical.samples} so far
                {typical.nearest ? ", with a different number of starting images" : ""}).
              </span>
            ) : (
              <span data-testid="studio-typical">Nothing comparable has been made here yet.</span>
            )}
          </span>
        </p>
      ) : (
        <p className="text-muted" data-testid="studio-estimate">
          {model?.test
            ? "No charge: a test model. It draws a placeholder pattern, not a real picture."
            : "No charge."}
        </p>
      )}
      <details data-testid="studio-sent">
        <summary className="text-muted hover:text-fg">
          {quote.sending.length === 0
            ? "Sends no image, only the written description"
            : `Sends ${quote.sending.length} image${quote.sending.length === 1 ? "" : "s"}`}
          {quote.notSent > 0 ? ` (${quote.notSent} more did not fit this model)` : ""} · show
        </summary>
        <div className="mt-2 space-y-2 rounded-[3px] border border-line bg-bg p-2">
          {quote.sending.length > 0 ? (
            <ol className="flex flex-wrap gap-2">
              {quote.sending.map((s, i) => (
                <li key={s.assetId} className="w-20 text-[10.5px] text-muted">
                  {thumb.get(s.assetId) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumb.get(s.assetId)!} alt="" className="mb-0.5 w-full rounded-[2px]" />
                  ) : null}
                  {i + 1}. {s.label}
                </li>
              ))}
            </ol>
          ) : null}
          <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed" data-testid="studio-prompt">
            {quote.prompt}
          </p>
          {quote.paid ? (
            // in dollars and words: the estimator's own arithmetic is in provider credits, which say nothing here
            <p className="text-[10.5px] text-faint" data-testid="studio-basis">
              Upper bound from the provider&rsquo;s published prices. It covers the picture
              {quote.sending.length === 0
                ? ""
                : quote.sending.length === 1
                  ? ", the image sent with it"
                  : `, the ${quote.sending.length} images sent with it`}{" "}
              and the prompt text.
            </p>
          ) : null}
        </div>
      </details>
    </div>
  );
}

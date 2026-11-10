import { z } from "zod";
import type { GenerationPackage } from "../generation-package";
import { catalogModel } from "./models/catalog";
import type { GenerationPurpose } from "./schemas";

/**
 * Provider-prompt adaptation (Phase 5B).
 *
 *   authoritative Shot intent (GenerationPackage) → deterministic provider-prompt policy → provider request
 *
 * The Shot's story data stays the source of truth. A provider prompt is an EXECUTION representation derived from it:
 * concise, visually observable instructions a video model can render, without Prism's internal metadata (Shot codes,
 * Production Frame versions, purpose labels, scores, Look/Lock names...). The policy is pure and deterministic (no AI
 * rewriting), versioned, and its full result is frozen in the immutable request (`providerOptions.prismProviderPrompt`)
 * so a later audit can answer "why exactly was this prompt sent?".
 *
 * Budget: sections carry a priority. Required sections are always kept and never cut; optional sections are added in
 * priority order only while the prompt stays within the policy's TARGET length (comfortably below the provider limit).
 * Sections are dropped whole — a sentence or field is never cut part-way — and every omission is recorded. When the
 * required content alone exceeds the provider limit the result is not `ok` and the request is refused (never truncated).
 */

export const PROVIDER_PROMPT_SCHEMA = "prism.provider-prompt.v1" as const;
export const VISIBLE_MOTION_POLICY = { id: "visible-motion", version: 1 } as const;

export const PROVIDER_PROMPT_SECTION_KEYS = [
  "subject",
  "visible_action",
  "performance",
  "camera",
  "composition",
  "continuity",
  "look_detail",
  "setting",
] as const;
export type ProviderPromptSectionKey = (typeof PROVIDER_PROMPT_SECTION_KEYS)[number];

const SECTION_LABEL: Record<ProviderPromptSectionKey, string> = {
  subject: "Subject",
  visible_action: "Visible action",
  performance: "Performance",
  camera: "Camera",
  composition: "Composition",
  continuity: "Continuity",
  look_detail: "Look detail",
  setting: "Setting",
};

/** Lower number = more important. Required sections are always included; optional ones fill the target in this order. */
const SECTION_PRIORITY: Record<ProviderPromptSectionKey, { priority: number; required: boolean }> = {
  continuity: { priority: 1, required: true },
  visible_action: { priority: 2, required: true },
  subject: { priority: 3, required: true },
  camera: { priority: 3, required: true },
  composition: { priority: 3, required: true },
  performance: { priority: 4, required: false },
  look_detail: { priority: 5, required: false },
  setting: { priority: 6, required: false },
};

/** Internal Prism information this policy deliberately keeps out of provider prose (it stays in provenance). */
export const VISIBLE_MOTION_EXCLUDED = [
  "Shot code and title",
  "dramatic purpose label",
  "Production Frame version",
  "performance intensity score",
  "spoken dialogue text",
  "aspect-ratio prose (carried by the request ratio)",
  "Look and Continuity Lock names",
  "timing segments (carried by the duration parameter)",
  "lens and aperture (established by the first frame)",
] as const;

const adaptationSchema = z.object({
  field: z.string(),
  source: z.string(),
  provider: z.string().nullable(),
  rule: z.string(),
});
export type ProviderPromptAdaptation = z.infer<typeof adaptationSchema>;

export const adaptedProviderPromptSchema = z.object({
  schema: z.literal(PROVIDER_PROMPT_SCHEMA),
  policy: z.object({ id: z.string(), version: z.number().int().positive() }),
  provider: z.string(),
  modelId: z.string(),
  purpose: z.string(),
  /** The authoritative package this prompt was derived from (`GenerationPackage.provenance.fingerprint`). */
  sourceFingerprint: z.string(),
  text: z.string(),
  length: z.number().int().nonnegative(),
  budget: z.object({ limit: z.number().int().positive(), target: z.number().int().positive() }),
  sections: z.array(
    z.object({
      key: z.enum(PROVIDER_PROMPT_SECTION_KEYS),
      label: z.string(),
      required: z.boolean(),
      priority: z.number().int(),
      included: z.boolean(),
      length: z.number().int().nonnegative(),
    }),
  ),
  omitted: z.array(
    z.object({
      key: z.enum(PROVIDER_PROMPT_SECTION_KEYS),
      label: z.string(),
      reason: z.literal("over_budget"),
    }),
  ),
  adaptations: z.array(adaptationSchema),
  excluded: z.array(z.string()),
  ok: z.boolean(),
  problem: z.string().nullable(),
});
export type AdaptedProviderPrompt = z.infer<typeof adaptedProviderPromptSchema>;

/** The frozen provider prompt of a request, or null when absent or malformed (a malformed one is a validation error). */
export function parseFrozenProviderPrompt(raw: unknown): AdaptedProviderPrompt | null {
  const r = adaptedProviderPromptSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export interface ProviderPromptPolicyChoice {
  policy: { id: string; version: number };
  budget: { limit: number; target: number };
}

/**
 * Which provider-prompt policy applies to a request (null = the provider's existing prompt compilation is used,
 * unchanged). Table-driven so further video providers/models opt in explicitly, each with its own budget.
 */
const POLICY_TABLE: ReadonlyArray<{
  provider: string;
  modelIds: readonly string[];
  purposes: readonly GenerationPurpose[];
  policy: { id: string; version: number };
  /** Aim well below the provider ceiling: a concise prompt, not the maximum the field accepts. */
  target: number;
}> = [
  {
    provider: "runway",
    modelIds: ["gen4_turbo", "gen4.5"],
    purposes: ["animate_production_frame"],
    policy: VISIBLE_MOTION_POLICY,
    target: 900,
  },
];

export function providerPromptPolicyFor(args: {
  provider: string;
  modelId: string;
  purpose: GenerationPurpose | undefined;
}): ProviderPromptPolicyChoice | null {
  const row = POLICY_TABLE.find(
    (r) =>
      r.provider === args.provider &&
      r.modelIds.includes(args.modelId) &&
      (r.purposes as readonly string[]).includes(args.purpose ?? "shot_output"),
  );
  if (!row) return null;
  const limit = catalogModel(args.provider, args.modelId)?.promptMaxChars ?? null;
  if (!limit) return null;
  return { policy: row.policy, budget: { limit, target: Math.min(row.target, limit) } };
}

// ───────────────────────── visible-motion v1: abstract story language → visible behaviour ─────────────────────────

/** Figurative terms a video model may render literally (a "mask" becomes a face covering). Never sent as-is. */
const FIGURATIVE = /\b(mask|masks|masked|composure|fa[cç]ade|poise)\b/i;

interface Voice {
  /** Subject: "she" / "he" / the Character's name. */
  s: string;
  /** Possessive: "her" / "his" / "Yumeko's". */
  p: string;
}

const BODY =
  "eyes|eye|shoulders|shoulder|head|hands|hand|gaze|lips|mouth|chin|jaw|brow|brows|breath|fingers|arms|face";

type Phase = "begin" | "change" | "end";

interface Rule {
  id: string;
  test: RegExp;
  /** The visible clause (subject-led, lower-case start), or a STATE adjective for begin/end poses. */
  render: (v: Voice) => string;
  /** A state adjective folds into "a calm, guarded, neutral expression" instead of being its own clause. */
  state?: string;
}

/** Ordered: the first matching rule wins. Restoration/slip rules come before the single-word emotions they contain. */
const RULES: Rule[] = [
  {
    id: "restore-to-neutral",
    test: /\b((composure|mask|poise|fa[cç]ade)\s+(restored|returns|regained|back|reset|on again)|regains\s+\w*\s*(composure|poise)|recompos\w*)\b/i,
    render: (v) => `${v.s} returns to a calm, controlled neutral expression`,
  },
  {
    id: "slip-softens",
    test: /\b((composure|mask|poise|fa[cç]ade)\s+(slips|slipping|drops|dropping|falls|cracks|breaks|crumbles)|lets\s+the\s+(mask|fa[cç]ade)\s+(slip|drop|fall))\b/i,
    render: (v) => `${v.p} expression briefly softens`,
  },
  {
    id: "state-mask-on",
    test: /^(mask on|mask in place)$/i,
    render: () => "controlled",
    state: "controlled",
  },
  { id: "state-composed", test: /^(composed|poised)$/i, render: () => "calm", state: "calm" },
  { id: "state-calm", test: /^calm$/i, render: () => "calm", state: "calm" },
  { id: "state-controlled", test: /^controlled$/i, render: () => "controlled", state: "controlled" },
  { id: "state-guarded", test: /^guarded$/i, render: () => "guarded", state: "guarded" },
  {
    id: "state-impassive",
    test: /^(stoic|impassive|poker[- ]?faced?)$/i,
    render: () => "impassive",
    state: "impassive",
  },
  { id: "state-neutral", test: /^neutral$/i, render: () => "neutral", state: "neutral" },
  {
    id: "exhaustion-visible",
    test: /\b(exhausted|exhaustion|tired|weary|drained|fatigued)\b/i,
    render: (v) => `${v.s} looks visibly exhausted`,
  },
  {
    id: "tension-visible",
    test: /\b(tension|tense)\b/i,
    render: (v) => `${v.s} shows visible tension in ${v.p} jaw and shoulders`,
  },
  {
    id: "confidence-visible",
    test: /\b(confident|confidence)\b/i,
    render: (v) => `${v.s} holds an upright posture and a steady gaze`,
  },
  {
    id: "hesitation-visible",
    test: /\b(hesitat\w*)\b/i,
    render: (v) => `${v.s} pauses briefly before moving`,
  },
  {
    id: "shoulders-lower",
    test: /^shoulders\s+(fall|drop|slump|sag|sink)\w*$/i,
    render: (v) => `${v.p} shoulders lower subtly`,
  },
];

const STATE_ORDER = ["calm", "controlled", "guarded", "impassive", "neutral"];

const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
const upperFirst = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** "a; b, c" → ["a", "b", "c"] (a pose/expression field is short comma/semicolon separated notes). */
function atoms(text: string): string[] {
  return text
    .split(/[;,]/)
    .map((x) => x.trim().replace(/\.$/, ""))
    .filter(Boolean);
}

/** A concrete note that matched no rule, made into a clause: "Closes eyes briefly" → "she closes her eyes briefly". */
function concreteClause(atom: string, v: Voice): string {
  const a = lowerFirst(atom.trim());
  if (new RegExp(`^(${BODY})\\b`, "i").test(a)) return `${v.p} ${a}`;
  const words = a.split(/\s+/);
  if (/s$/.test(words[0]!) && words.length > 1) {
    // a verb-led note: give a bare body part its owner ("closes eyes" → "closes her eyes")
    return `${v.s} ${a.replace(new RegExp(`^(\\w+) (${BODY})\\b`, "i"), `$1 ${v.p} $2`)}`;
  }
  return `${v.s} looks ${a}`;
}

function joinClauses(clauses: string[]): string {
  if (clauses.length <= 2) return clauses.join(" and ");
  return `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
}

interface Translated {
  clauses: string[];
  states: string[];
}

function translate(
  field: string,
  text: string,
  v: Voice,
  phase: Phase,
  out: ProviderPromptAdaptation[],
): Translated {
  const res: Translated = { clauses: [], states: [] };
  for (const raw of atoms(text)) {
    const atom = raw.replace(/\s+expression$/i, "").trim();
    const rule = RULES.find((r) => r.test.test(atom));
    if (rule) {
      if (rule.state) {
        res.states.push(rule.state);
        out.push({ field, source: raw, provider: `${rule.state} expression`, rule: rule.id });
      } else {
        const clause = rule.render(v);
        res.clauses.push(clause);
        out.push({ field, source: raw, provider: clause, rule: rule.id });
      }
      continue;
    }
    if (FIGURATIVE.test(atom)) {
      // never send a figurative term a model could render literally; keep the omission auditable
      out.push({ field, source: raw, provider: null, rule: "figurative-omitted" });
      continue;
    }
    const clause = concreteClause(atom, v);
    res.clauses.push(clause);
    if (phase !== "change" || clause.toLowerCase() !== lowerFirst(raw).toLowerCase())
      out.push({ field, source: raw, provider: clause, rule: "concrete-kept" });
  }
  return res;
}

const stateExpression = (states: string[]) => {
  const ordered = STATE_ORDER.filter((s) => states.includes(s));
  return ordered.length ? `a ${ordered.join(", ")} expression` : null;
};

function voiceFor(pkg: GenerationPackage): { voice: Voice; descriptor: string | null } {
  const c = pkg.characters.length === 1 ? pkg.characters[0]! : null;
  if (!c) return { voice: { s: "the subject", p: "the subject's" }, descriptor: null };
  const lock = pkg.references.characterContinuity?.find((l) => l.characterId === c.characterId);
  const physical = (lock?.facts.physicalDescription || c.physicalDescription || "").trim();
  const descriptor = physical.split(/[,.]/)[0]?.trim() || null;
  if (/\b(woman|girl|female|lady)\b/i.test(physical)) return { voice: { s: "she", p: "her" }, descriptor };
  if (/\b(man|boy|male|gentleman)\b/i.test(physical)) return { voice: { s: "he", p: "his" }, descriptor };
  return { voice: { s: c.name, p: `${c.name}'s` }, descriptor };
}

const article = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");

const replaceNames = (text: string, pkg: GenerationPackage, v: Voice) =>
  pkg.characters.length === 1
    ? text.replace(new RegExp(`\\b${pkg.characters[0]!.name}\\b`, "g"), upperFirst(v.s))
    : text;

function timeOfDay(tod: string): string | null {
  const t = tod.trim().toLowerCase();
  if (!t) return null;
  if (t === "night") return "at night";
  if (t === "day" || t === "daytime") return "during the day";
  return `at ${t}`;
}

function cameraSentence(pkg: GenerationPackage, out: ProviderPromptAdaptation[]): string {
  const cam = pkg.camera;
  const height = cam.cameraHeight.trim() ? ` at ${cam.cameraHeight.trim().toLowerCase()}` : "";
  const movement = cam.movement.trim();
  const source = [movement, cam.movementSpeed && `(${cam.movementSpeed})`].filter(Boolean).join(" ");
  if (
    !movement ||
    /^(static|locked)/i.test(movement) ||
    /\b(imperceptible|barely|almost static|very subtle)\b/i.test(movement)
  ) {
    const sentence = `Keep the camera locked${height} with no push-in, pan or reframing.`;
    if (movement)
      out.push({
        field: "camera.movement",
        source,
        provider: sentence,
        rule: "imperceptible-movement-locked",
      });
    return sentence;
  }
  const speed = cam.movementSpeed.trim() ? `${cam.movementSpeed.trim().toLowerCase()} ` : "";
  return `The camera makes a ${speed}${movement.toLowerCase()}${height}; no other reframing.`;
}

const sentence = (s: string) => {
  const t = upperFirst(s.trim());
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/**
 * visible-motion v1 for an image-to-video animation of the selected Production Frame. Builds the provider prose from
 * the package's structured fields (never from Prism's rendered prompt plan), so internal labels cannot leak.
 */
export function adaptAnimationProviderPrompt(
  pkg: GenerationPackage,
  args: { provider: string; modelId: string; purpose: GenerationPurpose; choice: ProviderPromptPolicyChoice },
): AdaptedProviderPrompt {
  const adaptations: ProviderPromptAdaptation[] = [];
  const { voice: v, descriptor } = voiceFor(pkg);
  const c = pkg.characters.length === 1 ? pkg.characters[0]! : null;
  const blk = pkg.blocking;
  const sections: Record<ProviderPromptSectionKey, string[]> = {
    subject: [],
    visible_action: [],
    performance: [],
    camera: [],
    composition: [],
    continuity: [],
    look_detail: [],
    setting: [],
  };

  // Subject: who and where, in plain words
  const who = descriptor ? `${article(descriptor)} ${lowerFirst(descriptor)}` : c ? c.name : "The subject";
  const where = pkg.set ? ` in the ${pkg.set.name}` : "";
  const when = timeOfDay(pkg.continuity.timeOfDay) ?? "";
  const alone = pkg.characters.length === 1 ? " is alone" : " is";
  sections.subject.push(sentence(`${who}${alone}${where}${when ? ` ${when}` : ""}`));

  // Visible action: held orientation, then begin → change → end, all as observable behaviour
  const side = blk.screenDirection.match(/screen[- ]?(left|right)/i)?.[1]?.toLowerCase() ?? null;
  const eyelines = blk.eyelines.trim();
  const towardCamera = /\b(camera|lens)\b/i.test(eyelines);
  if (side || eyelines) {
    const eyes = eyelines
      ? /^(down|up|lowered|closed|toward|towards|away|off|left|right)/i.test(eyelines)
        ? ` with ${v.p} eyes ${eyelines.toLowerCase()}`
        : ` with ${v.p} eyeline ${lowerFirst(eyelines)}`
      : "";
    const hold = side
      ? `${v.s} keeps ${v.p} head turned toward screen-${side}${eyes} throughout`
      : `${v.s} keeps${eyes.replace(/^ with/, "")} throughout`;
    sections.visible_action.push(sentence(towardCamera ? hold : `${hold} and never looks into the camera`));
  }
  const begin = translate("timing.beginningPose", pkg.timing.beginningPose, v, "begin", adaptations);
  const beginExpr = stateExpression(begin.states);
  const beginClauses = [beginExpr && `${v.s} begins with ${beginExpr}`, ...begin.clauses].filter(
    Boolean,
  ) as string[];
  if (beginClauses.length) sections.visible_action.push(sentence(joinClauses(beginClauses)));

  const change: string[] = [];
  for (const b of pkg.timing.beats)
    change.push(...translate("timing.beat", b.description, v, "change", adaptations).clauses);
  if (c) {
    for (const [field, text] of [
      ["expression", c.expression],
      ["posture", c.posture],
      ["gestures", c.gestures],
    ] as const) {
      if (text.trim())
        change.push(...translate(`characters.${field}`, text, v, "change", adaptations).clauses);
    }
  }
  // a held picture is not a frozen one: natural breathing is always asked for (policy, not story)
  change.push(`${v.s} breathes naturally`);
  sections.visible_action.push(sentence(joinClauses(change)));

  const end = translate("timing.endingPose", pkg.timing.endingPose, v, "end", adaptations);
  const endExpr = stateExpression(end.states);
  const endClauses = [...end.clauses, endExpr && `${v.s} settles into ${endExpr}`].filter(
    Boolean,
  ) as string[];
  if (endClauses.length) sections.visible_action.push(sentence(`then ${joinClauses(endClauses)}`));

  // Performance (optional): how the motion is played, not what is felt
  const pace = pkg.performance
    .map((p) => (p.pace ?? "").trim())
    .find(Boolean)
    ?.toLowerCase();
  sections.performance.push(
    sentence(`keep facial movement restrained${pace ? ` and the pace ${pace}` : ""}`),
  );

  // Camera
  sections.camera.push(cameraSentence(pkg, adaptations));

  // Composition: the first frame's framing and blocking, held
  if (blk.subjectBlocking.trim())
    sections.composition.push(sentence(replaceNames(blk.subjectBlocking.trim(), pkg, v)));
  if (pkg.camera.framing.trim() || pkg.camera.shotSize.trim())
    adaptations.push({
      field: "camera.framing",
      source: [pkg.camera.shotSize, pkg.camera.framing].filter((x) => x.trim()).join(" "),
      provider: null,
      rule: "framing-established-by-first-frame",
    });

  // Continuity (required): what must not change, naming the Look by its head phrases (full Look text: look_detail)
  const lock = c
    ? pkg.references.characterContinuity?.find((l) => l.characterId === c.characterId)
    : undefined;
  const look = c ? (lock ? lock.facts.look : c.look) : null;
  const head = (field: string, text: string | undefined) => {
    const full = (text ?? "").trim();
    if (!full) return null;
    const first = lowerFirst(full.split(/[,;]/)[0]!.trim().replace(/\.$/, ""));
    if (first !== lowerFirst(full))
      adaptations.push({ field: `look.${field}`, source: full, provider: first, rule: "look-head-phrase" });
    return first;
  };
  const hair = head("hair", look?.hair);
  const wardrobe = head("wardrobe", look?.wardrobe);
  const jewelry = head("jewelry", look?.jewelry);
  sections.continuity.push(
    sentence(
      c
        ? `preserve the starting composition and ${v.p} identity, apparent age, facial structure, ${hair ? `hairstyle (${hair})` : "hairstyle"}, ${wardrobe ? `wardrobe (${wardrobe})` : "wardrobe"}, ${jewelry ? `jewelry (${jewelry})` : "jewelry"}, lighting and background exactly as in the first frame`
        : "preserve the starting composition, the subjects, lighting and background exactly as in the first frame",
    ),
    "Do not introduce new objects or people.",
  );

  // Look detail (optional): the complete Look fields, when the budget has room for them
  if (look) {
    const parts = [
      look.hair && `hair: ${lowerFirst(look.hair)}`,
      look.wardrobe && `wardrobe: ${lowerFirst(look.wardrobe)}`,
      look.jewelry && `jewelry: ${lowerFirst(look.jewelry)}`,
    ].filter(Boolean) as string[];
    if (parts.length) sections.look_detail.push(sentence(parts.join("; ")));
  }

  // Setting (optional): the established lighting and mood, briefly
  const settingBits = [
    pkg.set?.lighting?.trim().replace(/\.$/, ""),
    pkg.lighting.mood.trim() && `${pkg.lighting.mood.trim().toLowerCase()} mood`,
  ].filter(Boolean) as string[];
  if (settingBits.length) sections.setting.push(sentence(settingBits.join("; ")));

  // figurative safety net on the final prose (a rule gap must never reach the provider)
  for (const key of PROVIDER_PROMPT_SECTION_KEYS) {
    sections[key] = sections[key].filter((s) => {
      if (!FIGURATIVE.test(s)) return true;
      adaptations.push({ field: `section.${key}`, source: s, provider: null, rule: "figurative-omitted" });
      return false;
    });
  }

  return applyBudget(pkg, args, sections, adaptations);
}

const RENDER_ORDER: readonly ProviderPromptSectionKey[] = PROVIDER_PROMPT_SECTION_KEYS;

function applyBudget(
  pkg: GenerationPackage,
  args: { provider: string; modelId: string; purpose: GenerationPurpose; choice: ProviderPromptPolicyChoice },
  sections: Record<ProviderPromptSectionKey, string[]>,
  adaptations: ProviderPromptAdaptation[],
): AdaptedProviderPrompt {
  const { limit, target } = args.choice.budget;
  const textOf = (key: ProviderPromptSectionKey) => sections[key].join(" ");
  const render = (keys: Set<ProviderPromptSectionKey>) =>
    RENDER_ORDER.filter((k) => keys.has(k) && sections[k].length > 0)
      .map(textOf)
      .join(" ");

  const present = RENDER_ORDER.filter((k) => sections[k].length > 0);
  const included = new Set(present.filter((k) => SECTION_PRIORITY[k].required));
  const requiredLength = render(included).length;
  const omitted: AdaptedProviderPrompt["omitted"] = [];
  const optional = present
    .filter((k) => !SECTION_PRIORITY[k].required)
    .sort((a, b) => SECTION_PRIORITY[a].priority - SECTION_PRIORITY[b].priority);
  for (const key of optional) {
    const next = new Set(included).add(key);
    if (render(next).length <= target) included.add(key);
    else omitted.push({ key, label: SECTION_LABEL[key], reason: "over_budget" });
  }
  const text = render(included);
  const ok = requiredLength <= limit;
  return {
    schema: PROVIDER_PROMPT_SCHEMA,
    policy: { ...args.choice.policy },
    provider: args.provider,
    modelId: args.modelId,
    purpose: args.purpose,
    sourceFingerprint: pkg.provenance.fingerprint,
    text,
    length: text.length,
    budget: { limit, target },
    sections: present.map((key) => ({
      key,
      label: SECTION_LABEL[key],
      required: SECTION_PRIORITY[key].required,
      priority: SECTION_PRIORITY[key].priority,
      included: included.has(key),
      length: textOf(key).length,
    })),
    omitted,
    adaptations,
    excluded: [...VISIBLE_MOTION_EXCLUDED],
    ok,
    problem: ok
      ? null
      : `The required provider prompt is ${requiredLength} characters; ${args.provider}/${args.modelId} accepts at most ${limit}. Shorten the Shot's action or blocking notes (nothing is truncated).`,
  };
}

/** The provider prompt a request should freeze, or null when no policy applies to this provider/model/purpose. */
export function adaptProviderPrompt(
  pkg: GenerationPackage,
  args: { provider: string; modelId: string; purpose: GenerationPurpose | undefined },
): AdaptedProviderPrompt | null {
  const choice = providerPromptPolicyFor(args);
  if (!choice || args.purpose !== "animate_production_frame") return null;
  if (
    choice.policy.id === VISIBLE_MOTION_POLICY.id &&
    choice.policy.version === VISIBLE_MOTION_POLICY.version
  )
    return adaptAnimationProviderPrompt(pkg, { ...args, purpose: args.purpose, choice });
  return null;
}

import type { Asset, CharacterLook, IdentityRef, ProjectData } from "./schemas";

/**
 * Phase 5B-I4: the Character Visual Bible, built on records Prism already has (no migration):
 *
 *   Canonical identity   an IdentityRef with `metadata.visualRole = "canonical"` (at most one per Character)
 *   Identity references  IdentityRefs in their slots (front, three-quarter, profile, full body, additional)
 *   Looks                CharacterLook records and their `referenceAssetIds`
 *   Expressions          IdentityRefs (slot "additional") with `metadata.visualRole = "expression"` and
 *                        `metadata.expression` (a suggested name or a custom one)
 *   Cutout               an IdentityRef with `metadata.visualRole = "cutout"` pointing at an existing transparent Asset
 *
 * A designation is a POINTER to an existing immutable Asset: nothing is copied, and while it exists the Asset is
 * pinned by the existing asset-usage rules (an identity reference). Removing the designation removes only the pointer.
 * Only an explicit creator action sets or replaces a designation; generation never does.
 */
export const VISUAL_ROLES = ["canonical", "cutout", "expression"] as const;
export type VisualRole = (typeof VISUAL_ROLES)[number];
export const SUGGESTED_EXPRESSIONS = [
  "neutral",
  "happy",
  "concerned",
  "angry",
  "crying",
  "surprised",
] as const;
export const MAX_EXPRESSION_NAME = 40;

export const visualRoleOf = (r: Pick<IdentityRef, "metadata">): VisualRole | null => {
  const v = (r.metadata as { visualRole?: unknown } | undefined)?.visualRole;
  return (VISUAL_ROLES as readonly unknown[]).includes(v) ? (v as VisualRole) : null;
};
export const expressionOf = (r: Pick<IdentityRef, "metadata">): string | null => {
  const v = (r.metadata as { expression?: unknown } | undefined)?.expression;
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

/** Normalized expression name: a suggested one, or a short custom label. */
export function normalizeExpression(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/\s+/g, " ").slice(0, MAX_EXPRESSION_NAME);
  return v || null;
}

/**
 * The deterministic order a Character's identity references are SENT in (live appearance and Character images):
 * the canonical identity first, then the ordinary slot references in their existing order, then the cutout, then
 * expressions. Stable: with no Visual Bible roles the order is exactly the library order (unchanged behaviour).
 */
export function orderedIdentityRefs<T extends Pick<IdentityRef, "metadata">>(refs: readonly T[]): T[] {
  const rank = (r: T) => {
    const role = visualRoleOf(r);
    return role === "canonical" ? 0 : role === null ? 1 : role === "cutout" ? 2 : 3;
  };
  return refs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map((x) => x.r);
}

export function canonicalRefOf(
  data: Pick<ProjectData, "identityRefs">,
  characterId: string,
): IdentityRef | null {
  return (
    data.identityRefs.find((r) => r.characterId === characterId && visualRoleOf(r) === "canonical") ?? null
  );
}

export function cutoutRefOf(
  data: Pick<ProjectData, "identityRefs">,
  characterId: string,
): IdentityRef | null {
  return data.identityRefs.find((r) => r.characterId === characterId && visualRoleOf(r) === "cutout") ?? null;
}

const stored = (a: Asset | undefined) => !!a && a.type === "image" && !!a.objectPath && !!a.checksum;

export interface VisualBibleItem {
  key: string;
  label: string;
  done: boolean;
  /** The Asset that fulfils it (when done). */
  assetId: string | null;
  /** Guidance, never a gate. */
  suggestion: string | null;
  /** The Generate preset that would fill it (I1/I2 intents). */
  generateIntent:
    "portrait" | "three_quarter" | "profile" | "full_body" | "expression_variant" | "look_sheet" | null;
}

export interface VisualBibleReadiness {
  characterId: string;
  canonicalAssetId: string | null;
  cutoutAssetId: string | null;
  items: VisualBibleItem[];
  looks: Array<{ look: CharacterLook; storedReferences: number; suggestion: string | null }>;
  expressions: Array<{ refId: string; expression: string; assetId: string | null }>;
  /** Completed items / all items: guidance only. */
  done: number;
  total: number;
}

/** What the Character's Visual Bible has and what Prism suggests next (guidance, never a hard gate). */
export function visualBibleReadiness(data: ProjectData, characterId: string): VisualBibleReadiness {
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const refs = data.identityRefs.filter((r) => r.characterId === characterId);
  const has = (r: IdentityRef | undefined) => !!r && !!r.assetId && stored(assets.get(r.assetId));
  const bySlot = (slot: IdentityRef["slot"]) =>
    refs.find((r) => r.slot === slot && visualRoleOf(r) === null && has(r));
  const canonical = refs.find((r) => visualRoleOf(r) === "canonical" && has(r));
  const cutout = refs.find((r) => visualRoleOf(r) === "cutout" && has(r));
  const expressions = refs
    .filter((r) => visualRoleOf(r) === "expression")
    .map((r) => ({ refId: r.id, expression: expressionOf(r) ?? "expression", assetId: r.assetId }));
  const looks = data.looks
    .filter((l) => l.characterId === characterId)
    .map((look) => {
      const n = look.referenceAssetIds.filter((id) => stored(assets.get(id))).length;
      return {
        look,
        storedReferences: n,
        suggestion:
          n === 0
            ? `The Look "${look.name}" has no reference image yet.`
            : n === 1
              ? `The Look "${look.name}" has only one reference.`
              : null,
      };
    });
  const item = (
    key: string,
    label: string,
    ref: IdentityRef | undefined,
    suggestion: string,
    generateIntent: VisualBibleItem["generateIntent"],
  ): VisualBibleItem => ({
    key,
    label,
    done: !!ref,
    assetId: ref?.assetId ?? null,
    suggestion: ref ? null : suggestion,
    generateIntent,
  });
  const items: VisualBibleItem[] = [
    item(
      "canonical",
      "Canonical identity",
      canonical,
      "Choose the image that defines this Character's face.",
      "portrait",
    ),
    {
      key: "look",
      label: "Look with references",
      done: looks.some((l) => l.storedReferences > 0),
      assetId: null,
      suggestion:
        looks.length === 0
          ? "This Character has no Look yet."
          : (looks.find((l) => l.suggestion)?.suggestion ?? null),
      generateIntent: "look_sheet",
    },
    item("front", "Front reference", bySlot("front"), "You don't have a front reference yet.", "portrait"),
    item(
      "three_quarter",
      "3/4 reference",
      bySlot("three_quarter"),
      "You don't have a three-quarter reference yet.",
      "three_quarter",
    ),
    item(
      "profile",
      "Profile reference",
      bySlot("profile"),
      "You don't have a profile reference yet.",
      "profile",
    ),
    item(
      "full_body",
      "Full-body reference",
      bySlot("full_body"),
      "You don't have a full-body reference yet.",
      "full_body",
    ),
    item(
      "cutout",
      "Transparent cutout",
      cutout,
      "Remove the background from the canonical image to make a reusable cutout.",
      null,
    ),
    {
      key: "expressions",
      label: "Expression references",
      done: expressions.some((e) => !!e.assetId),
      assetId: null,
      suggestion: expressions.length ? null : "Optional: add expression references (happy, concerned, …).",
      generateIntent: "expression_variant",
    },
  ];
  return {
    characterId,
    canonicalAssetId: canonical?.assetId ?? null,
    cutoutAssetId: cutout?.assetId ?? null,
    items,
    looks,
    expressions,
    done: items.filter((i) => i.done).length,
    total: items.length,
  };
}

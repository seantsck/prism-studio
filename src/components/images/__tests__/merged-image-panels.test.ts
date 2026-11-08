import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildSeedProject } from "@/data/seed";
import { PHOTOROOM_PRIVACY_DETAILS, PHOTOROOM_PRIVACY_SHORT } from "@/generation/providers/photoroom/config";

/**
 * Phase 5B-I3b + I4 after integration: the Character page's Images panel and Visual Bible render BOTH feature sets,
 * with no duplicated controls. Server actions are stubbed (nothing runs; this is markup only).
 */
vi.mock("server-only", () => ({}));
vi.mock("@/components/action-form", () => ({
  ActionForm: ({ children }: { children: ReactNode }) => createElement("form", null, children),
}));
vi.mock("@/components/images/refresh-while-active", () => ({ RefreshWhileActive: () => null }));
vi.mock("@/server/subject-image-actions", () => ({
  startSubjectImage: vi.fn(),
  removeBackground: vi.fn(),
  saveAsCharacterReference: vi.fn(),
  saveAsLookReference: vi.fn(),
  saveAsLocationReference: vi.fn(),
  saveAsLocationView: vi.fn(),
}));
vi.mock("@/server/visual-bible-actions", () => ({
  setCanonicalIdentity: vi.fn(),
  setCharacterCutout: vi.fn(),
  addExpressionReference: vi.fn(),
  clearVisualBibleDesignation: vi.fn(),
}));

vi.mock("@/server/location-visual-bible-actions", () => ({
  setCanonicalLocation: vi.fn(),
  addLocationDesignation: vi.fn(),
  clearLocationDesignation: vi.fn(),
}));

const { SubjectImagePanel } = await import("../subject-image-panel");
const { LocationVisualBiblePanel } = await import("../location-visual-bible-panel");
const { VisualBiblePanel } = await import("../visual-bible-panel");

const SRC = "11111111-1111-4111-8111-111111111111";
const asset = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "image",
  mime: "image/png",
  objectPath: `p/${id}.png`,
  checksum: "c".repeat(64),
  metadata: {},
  ...extra,
});
const view = (
  n: number,
  opts: {
    provider: string;
    status: string;
    settings: Record<string, unknown>;
    error?: string;
    out?: boolean;
    alpha?: boolean;
  },
) =>
  ({
    attempt: {
      id: `att-${n}`,
      attemptNumber: n,
      status: opts.status,
      provider: opts.provider,
      model: `${opts.provider}-model`,
      modelSettings: opts.settings,
      request: {},
      createdAt: new Date(0).toISOString(),
    },
    job: opts.error ? { lastErrorCode: opts.error, lastErrorMessage: "refused" } : null,
    outputs: opts.out
      ? [
          {
            output: { role: "primary" },
            asset: asset(`out-${n}`, opts.alpha ? { metadata: { hasAlpha: true } } : {}),
          },
        ]
      : [],
    costs: [],
  }) as never;

const offer = {
  available: true,
  label: "Photoroom",
  usdPerImage: 0.02,
  privacyShort: PHOTOROOM_PRIVACY_SHORT,
  privacyDetails: PHOTOROOM_PRIVACY_DETAILS,
};
const models = [
  {
    provider: "mock",
    modelId: "mock-image",
    label: "Mock",
    aspectRatios: ["1:1"],
    available: true,
    paid: false,
    transparency: true,
    editing: true,
    qualities: [],
  },
];
const count = (html: string, testId: string) => html.split(`data-testid="${testId}"`).length - 1;
const cutoutSettings = { purpose: "background_removal", backgroundRemovalSourceAssetId: SRC };

function renderPanel(attempts: unknown[]) {
  return renderToStaticMarkup(
    createElement(SubjectImagePanel, {
      projectSlug: "ojousama",
      subject: { kind: "character", id: "char-1", looks: [{ id: "look-1", name: "Formal Black" }] },
      attempts: attempts as never,
      models,
      sources: [{ assetId: SRC, label: "Portrait", url: null }],
      hostedMatting: offer,
    }),
  );
}

describe("5B-I3b + I4 merged Character image UI", () => {
  it("a locally refused busy image offers High Quality Removal with the exact price and privacy copy", () => {
    const html = renderPanel([
      view(1, {
        provider: "prism-matting",
        status: "failed",
        settings: cutoutSettings,
        error: "matting_background_not_plain",
      }),
    ]);
    expect(count(html, "high-quality-offer")).toBe(1);
    expect(html).toContain("This image has a complex background.");
    expect(html).toMatch(/High Quality Removal — (<!-- -->)?\$0\.02/);
    expect(html).toContain('name="quality" value="high"');
    expect(html).toContain('name="confirmedTotalUsd" value="0.02"');
    expect(html).toContain(PHOTOROOM_PRIVACY_SHORT);
    expect(PHOTOROOM_PRIVACY_SHORT).toBe(
      "Processed by Photoroom. The provider states API images are discarded after processing.",
    );
    // the details sit under a disclosure
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Details<\/summary>/);
    for (const d of PHOTOROOM_PRIVACY_DETAILS)
      expect(html).toContain(d.replace(/"/g, "&quot;").replace(/'/g, "&#x27;"));
    // a refused cutout offers no designation (nothing to designate)
    expect(count(html, "use-as-cutout")).toBe(0);
  });

  it("an ordinary failure, or a local success, never shows the hosted offer", () => {
    const html = renderPanel([
      view(1, { provider: "prism-matting", status: "failed", settings: cutoutSettings, error: "other" }),
      view(2, { provider: "prism-matting", status: "succeeded", settings: cutoutSettings, out: true }),
    ]);
    expect(count(html, "high-quality-offer")).toBe(0);
    expect(html).not.toContain("Processed by Photoroom");
  });

  it("each control appears exactly once per image: generated image vs local vs Photoroom cutout", () => {
    const html = renderPanel([
      view(1, { provider: "mock", status: "succeeded", settings: { intent: "portrait" }, out: true }),
      view(2, {
        provider: "prism-matting",
        status: "succeeded",
        settings: cutoutSettings,
        out: true,
        alpha: true,
      }),
      view(3, {
        provider: "photoroom",
        status: "succeeded",
        settings: cutoutSettings,
        out: true,
        alpha: true,
      }),
    ]);
    // generated image: Use as Canonical + Remove Background; the cutouts: Use as Cutout (local AND hosted)
    expect(count(html, "use-as-canonical")).toBe(1);
    expect(count(html, "remove-background")).toBe(1);
    expect(count(html, "use-as-cutout")).toBe(2);
    // every finished image can still become a Character reference or a Look
    expect(count(html, "use-as-character-reference")).toBe(3);
    expect(count(html, "use-as-look")).toBe(3);
    // only the hosted cutout carries the provider badge, once
    expect(html.split("Processed by Photoroom").length - 1).toBe(1);
    // the creator surface: Generate, Edit, Transparent background, Remove Background, each one form
    expect(count(html, "remove-background-submit")).toBe(1);
    expect(html).toContain("Edit Image");
    expect(html).toContain("Generate Image");
  });

  it("the Visual Bible renders once with readiness, presets and its designation actions", () => {
    const data = buildSeedProject();
    const y = data.characters.find((c) => c.name === "Yumeko")!;
    const html = renderToStaticMarkup(
      createElement(VisualBiblePanel, {
        data,
        characterId: y.id,
        slug: "ojousama",
        sources: [{ assetId: SRC, label: "Portrait", url: null }],
        models,
      }),
    );
    expect(count(html, "visual-bible")).toBe(1);
    expect(count(html, "vb-readiness")).toBe(1);
    for (const key of [
      "canonical",
      "look",
      "front",
      "three_quarter",
      "profile",
      "full_body",
      "cutout",
      "expressions",
    ])
      expect(count(html, `vb-item-${key}`)).toBe(1);
    expect(count(html, "vb-use-as-canonical")).toBe(1);
    expect(count(html, "vb-add-expression")).toBe(1);
    expect(count(html, "vb-generate-portrait")).toBeGreaterThanOrEqual(1);
    // the hosted offer belongs to the Images panel only, never duplicated into the Visual Bible
    expect(html).not.toContain("High Quality Removal");
  });

  it("5B-I5: a Location image offers Use as Canonical and a NAMED Location View (no default name)", () => {
    const html = renderToStaticMarkup(
      createElement(SubjectImagePanel, {
        projectSlug: "ojousama",
        subject: { kind: "location", id: "loc-1" },
        attempts: [
          view(1, {
            provider: "mock",
            status: "succeeded",
            settings: { intent: "alternate_angle" },
            out: true,
          }),
        ] as never,
        models,
        sources: [],
      }),
    );
    expect(count(html, "use-as-canonical-location")).toBe(1);
    expect(count(html, "use-as-location-view")).toBe(1);
    expect(count(html, "use-as-location-reference")).toBe(1);
    expect(count(html, "use-as-canonical")).toBe(0);
    expect(html).toMatch(/<input(?=[^>]*name="lv_name")(?=[^>]*required)[^>]*>/);
    expect(html).not.toContain("Generated view #");
    expect(html).toContain('name="lv_kind"');
  });

  it("5B-I5: the Location Visual Bible renders readiness, presets, views and designations once", () => {
    const data = buildSeedProject();
    const lobby = data.locations.find((l) => l.name === "Grand Celeste Lobby")!;
    const unlocked = {
      ...data,
      locations: data.locations.map((l) => (l.id === lobby.id ? { ...l, locked: false } : l)),
    };
    const html = renderToStaticMarkup(
      createElement(LocationVisualBiblePanel, {
        data: { ...unlocked, locationViews: [] },
        locationId: lobby.id,
        slug: "ojousama",
        sources: [{ assetId: SRC, label: "Lobby photo", url: null }],
        models,
      }),
    );
    expect(count(html, `location-visual-bible-${lobby.id}`)).toBe(1);
    for (const key of ["canonical", "establishing", "view", "reverse", "variant", "plate"])
      expect(count(html, `lvb-item-${key}`)).toBe(1);
    for (const intent of [
      "location_concept",
      "establishing_view",
      "alternate_angle",
      "interior_view",
      "exterior_view",
      "background",
      "time_variant",
    ])
      expect(count(html, `lvb-generate-${intent}`)).toBe(1);
    expect(count(html, "lvb-use-as-canonical")).toBe(1);
    expect(count(html, "lvb-add-designation")).toBe(1);
    expect(html).toContain("Grand Celeste Lobby");
    // locked: shown, but no designation controls
    const locked = renderToStaticMarkup(
      createElement(LocationVisualBiblePanel, {
        data: { ...data, locationViews: [] },
        locationId: lobby.id,
        slug: "ojousama",
        sources: [{ assetId: SRC, label: "Lobby photo", url: null }],
        models,
      }),
    );
    expect(count(locked, "lvb-locked")).toBe(1);
    expect(count(locked, "lvb-use-as-canonical")).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { buildPrevisDocument } from "@/domain/previs/document";
import { buildHotelCanopyEngineScene } from "@/domain/previs/hotel-canopy";
import { assetTokenFor } from "@/domain/previs/document";
import { expectedManifest } from "@/domain/previs/spatial-passes";
import {
  hasVisibleSplat,
  SPLAT_PASSES_BLOCKED_MESSAGE,
  SPLAT_USER_DATA,
  UNKNOWN_CALIBRATION,
} from "@/domain/previs/splat";
import type { SpatialSceneAdapter } from "../scene-adapter";
import { renderSpatialCapture, SpatialCaptureError } from "../spatial-capture";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function docWithSplat(visible: boolean) {
  const s = buildHotelCanopyEngineScene();
  s.scene.push({
    ...clone(s.scene[1]),
    object_uuid: "00000000-0000-4000-8000-0000000051a7",
    object_name: "environment",
    media_file_token: assetTokenFor("asset-splat"),
    visible,
    user_data: {
      [SPLAT_USER_DATA.reconstructionId]: "recon-1",
      [SPLAT_USER_DATA.calibration]: { ...UNKNOWN_CALIBRATION },
    },
  });
  return buildPrevisDocument({ engineScene: s, assetChecksums: { "asset-splat": "sum" } });
}

describe("M2C spatial control passes with a Gaussian splat environment", () => {
  const captureWith = (splats: Array<{ id: string; name: string }>) => {
    let rendered = false;
    const adapter = {
      productionEntities: () => ({ setObjects: [{ id: "box", name: "Box" }], splats, characterIds: [] }),
      captureSpatialPasses: () => {
        rendered = true;
        throw new Error("must not render");
      },
    } as unknown as SpatialSceneAdapter;
    const run = () =>
      renderSpatialCapture({
        adapter,
        shotId: "shot",
        scene: { documentId: "d", revision: 1, fingerprint: "f".repeat(64) },
        blockingFingerprint: null,
        source: {} as never,
        savedFigures: [],
      });
    return { run, rendered: () => rendered };
  };

  it("a VISIBLE splat blocks the capture with the exact message, before anything is rendered", () => {
    const c = captureWith([{ id: "s", name: "environment" }]);
    expect(c.run).toThrow(SpatialCaptureError);
    expect(c.run).toThrow(SPLAT_PASSES_BLOCKED_MESSAGE);
    expect(c.rendered()).toBe(false);
    expect(SPLAT_PASSES_BLOCKED_MESSAGE).toBe(
      "Spatial control passes for Gaussian splat environments are not supported yet. Hide the splat or use mesh geometry to capture exact depth and object masks.",
    );
  });

  it("with no visible splat the capture proceeds past the splat gate", () => {
    const c = captureWith([]);
    // it reaches the renderer (which this fake refuses), proving the splat gate did not stop it
    expect(c.run).toThrow("must not render");
    expect(c.rendered()).toBe(true);
  });

  it("the saved Set is checked the same way (the server uses these helpers)", () => {
    expect(hasVisibleSplat(docWithSplat(true).objects)).toBe(true);
    expect(hasVisibleSplat(docWithSplat(false).objects)).toBe(false);
  });

  it("a splat is never a mesh entry in the object-id manifest, hidden or visible", () => {
    for (const visible of [true, false]) {
      const manifest = expectedManifest(docWithSplat(visible), [], {});
      expect(manifest.objects.some((o) => o.sceneObjectId === "00000000-0000-4000-8000-0000000051a7")).toBe(
        false,
      );
      expect(manifest.objects.every((o) => o.category !== "set_object" || o.sceneObjectId !== null)).toBe(
        true,
      );
    }
  });
});

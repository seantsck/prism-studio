import { describe, expect, it } from "vitest";
import nextConfig from "../../../../next.config";
import { buildObjectManifest, checkUploadShape, expectedUploadParts } from "../spatial-passes";

const MB = 1024 * 1024;

describe("request-size ceilings", () => {
  it("the proxy body buffer equals the server-action limit (one explicit ceiling, not a bigger hidden one)", () => {
    const exp = nextConfig.experimental as {
      serverActions?: { bodySizeLimit?: string };
      proxyClientMaxBodySize?: string;
    };
    expect(exp.proxyClientMaxBodySize).toBe("55mb");
    expect(exp.proxyClientMaxBodySize).toBe(exp.serverActions?.bodySizeLimit);
  });

  it("55 MB covers the largest existing upload (a 50 MB previs) but is never what a spatial capture is allowed to use", () => {
    const previsCap = 50 * MB;
    expect(55 * MB).toBeGreaterThan(previsCap);
    const m = buildObjectManifest({
      setObjects: [{ id: "s" }],
      characters: [
        { characterId: "a", blockingId: "1" },
        { characterId: "b", blockingId: "2" },
      ],
    });
    const total = expectedUploadParts(m, 1912, 800).reduce((n, p) => n + p.size, 0);
    expect(total).toBeLessThan(16 * MB); // a realistic two-Character capture is ~15.3 MB
    // the server accepts exactly that payload and nothing larger, whatever the proxy would let through
    expect(checkUploadShape([{ key: "depth", size: 55 * MB }], m, 1912, 800).ok).toBe(false);
  });
});

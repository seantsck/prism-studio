import type { GenerationAdaptationPlan } from "../framing/adaptation";
import { parseAspectRatio, sameRatio } from "../framing/ratio";
import type { ContinuityCriterion, FindingResult } from "./model";

/** Technical facts about one media file (a subset of the media probe: the domain stays tool-agnostic). */
export interface MediaFacts {
  assetId: string;
  checksum: string | null;
  kind: "video" | "image" | "audio" | "unknown";
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  durationMs: number | null;
  hasAudio: boolean;
  byteSize: number | null;
}

export interface DeterministicInput {
  /** The asset being judged: the delivery master, or the provider original when none was conformed. */
  subject: MediaFacts;
  /** True when `subject` is the provider's own file (no conform). */
  subjectIsOriginal: boolean;
  /** How many outputs the attempt produced (primary + variants). */
  outputCount: number;
  adaptation: GenerationAdaptationPlan | null;
  production: {
    aspectRatio: string | null;
    durationMs: number | null;
    fps: number | null;
    deliverySize: { width: number; height: number } | null;
    expectsAudio: boolean;
  };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
const WEB_CONTAINERS = /mp4|mov|matroska|webm/i;
const WEB_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1", "hevc"]);

const res = (
  criterionKey: string,
  result: FindingResult["result"],
  actual: string,
  notes = "",
): FindingResult => ({
  criterionKey,
  result,
  actual,
  source: "deterministic",
  confidence: 1,
  notes,
  evidence: {},
});

/**
 * Checks that need no AI: they compare production numbers with probed media facts. Anything that needs
 * understanding of the picture is NOT answered here (it stays `unchecked` until an analyzer or a person does).
 */
export function runDeterministicChecks(
  criteria: ContinuityCriterion[],
  input: DeterministicInput,
): FindingResult[] {
  const s = input.subject;
  const out: FindingResult[] = [];
  for (const c of criteria) {
    if (c.handler !== "deterministic") continue;
    switch (c.key) {
      case "output": {
        const ok = s.kind !== "unknown" && (s.byteSize ?? 1) > 0 && s.width != null && s.height != null;
        out.push(
          res(c.key, ok ? "pass" : "fail", ok ? `${s.kind} ${s.width}×${s.height}` : "No readable picture"),
        );
        break;
      }
      case "duration": {
        const want = input.production.durationMs;
        if (s.kind === "image") {
          out.push(res(c.key, "n_a", "still image"));
        } else if (want == null || s.durationMs == null) {
          out.push(res(c.key, "unchecked", s.durationMs != null ? secs(s.durationMs) : "unknown"));
        } else {
          const frame = s.fps ? 1000 / s.fps : 42;
          const tolerance = Math.max(frame * 1.5, 80);
          const delta = Math.abs(s.durationMs - want);
          out.push(
            delta <= tolerance
              ? res(c.key, "pass", secs(s.durationMs))
              : res(
                  c.key,
                  "fail",
                  secs(s.durationMs),
                  `Expected ${secs(want)} (±${Math.round(tolerance)} ms); the file is ${s.durationMs > want ? "longer" : "shorter"}.${
                    s.durationMs > want &&
                    input.subjectIsOriginal &&
                    input.adaptation?.conform.trimToMs != null
                      ? " Create the delivery conform to trim it."
                      : ""
                  }`,
                ),
          );
        }
        break;
      }
      case "aspect_ratio": {
        const want = parseAspectRatio(input.production.aspectRatio);
        if (!want || !s.width || !s.height) {
          out.push(res(c.key, "unchecked", s.width && s.height ? `${s.width}×${s.height}` : "unknown"));
          break;
        }
        const actual = s.width / s.height;
        out.push(
          sameRatio(actual, want.value)
            ? res(c.key, "pass", `${actual.toFixed(3)}:1 (${s.width}×${s.height})`)
            : res(
                c.key,
                "fail",
                `${actual.toFixed(3)}:1 (${s.width}×${s.height})`,
                `Production frame is ${input.production.aspectRatio}${
                  input.subjectIsOriginal
                    ? "; this is the provider original, not a conformed delivery master"
                    : ""
                }.`,
              ),
        );
        break;
      }
      case "resolution": {
        const want = input.production.deliverySize;
        if (!want)
          out.push(
            res(
              c.key,
              "n_a",
              s.width ? `${s.width}×${s.height}` : "unknown",
              "No explicit production pixel size is set.",
            ),
          );
        else if (!s.width || !s.height) out.push(res(c.key, "unchecked", "unknown"));
        else if (s.width === want.width && s.height === want.height)
          out.push(res(c.key, "pass", `${s.width}×${s.height}`));
        else
          out.push(
            res(
              c.key,
              "warn",
              `${s.width}×${s.height}`,
              `Production delivery size is ${want.width}×${want.height}; generated media is smaller or different.`,
            ),
          );
        break;
      }
      case "fps": {
        const want = input.production.fps;
        if (s.kind === "image") out.push(res(c.key, "n_a", "still image"));
        else if (!want || !s.fps)
          out.push(res(c.key, "unchecked", s.fps ? `${s.fps.toFixed(2)} fps` : "unknown"));
        else if (Math.abs(s.fps - want) <= 0.5) out.push(res(c.key, "pass", `${s.fps.toFixed(2)} fps`));
        else
          out.push(
            res(
              c.key,
              "warn",
              `${s.fps.toFixed(2)} fps`,
              `Production rate is ${want} fps; the file is ${s.fps.toFixed(2)} fps.`,
            ),
          );
        break;
      }
      case "container": {
        if (s.kind === "image") {
          out.push(res(c.key, "pass", s.container ?? "image"));
          break;
        }
        const okContainer = s.container ? WEB_CONTAINERS.test(s.container) : false;
        const okCodec = s.videoCodec ? WEB_VIDEO_CODECS.has(s.videoCodec) : false;
        out.push(
          okContainer && okCodec
            ? res(
                c.key,
                "pass",
                `${s.container} / ${s.videoCodec}${s.audioCodec ? ` + ${s.audioCodec}` : ""}`,
              )
            : res(
                c.key,
                "warn",
                `${s.container ?? "unknown"} / ${s.videoCodec ?? "unknown"}`,
                "May not play in every browser.",
              ),
        );
        break;
      }
      case "audio_stream": {
        if (s.kind === "image") out.push(res(c.key, "n_a", "still image"));
        else if (!input.production.expectsAudio)
          out.push(res(c.key, "n_a", s.hasAudio ? (s.audioCodec ?? "audio") : "no audio"));
        else if (s.hasAudio) out.push(res(c.key, "pass", s.audioCodec ?? "audio"));
        else
          out.push(
            res(
              c.key,
              "warn",
              "no audio stream",
              "The generated clip has no audio; performed dialogue is combined in audio post.",
            ),
          );
        break;
      }
      case "delivery_master": {
        out.push(
          input.subjectIsOriginal
            ? res(
                c.key,
                "fail",
                "provider original",
                "The adaptation plan requires a conform; none has been selected as the delivery master.",
              )
            : res(c.key, "pass", "conformed delivery master"),
        );
        break;
      }
      default:
        break;
    }
  }
  if (input.outputCount > 1) {
    // Informational: variants exist beside the primary output.
    const c = criteria.find((x) => x.key === "output");
    if (c) {
      const r = out.find((x) => x.criterionKey === c.key);
      if (r && r.result === "pass")
        r.notes = `${input.outputCount} outputs recorded; the primary one was judged.`;
    }
  }
  return out;
}

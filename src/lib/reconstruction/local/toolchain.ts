import { SUPPORTED_BRUSH } from "./brush";
import { APPROVED_COLMAP, checkColmapProvenance, type ColmapProvenanceState } from "./colmap-provenance";
import type { ToolCommand } from "./process";
import { parseSemver, probeOutput, resolveExecutable, vulkanLoaderPresent } from "./resolve";

/**
 * The REAL local toolchain probe (M2D.3A). Side-effect-light: it resolves configured paths, runs each tool's version
 * command once with a short timeout (no shell), hashes the COLMAP build against its provenance manifest, and checks
 * for a Vulkan loader. It never installs, downloads or builds anything.
 *
 * Policy:
 *   COLMAP   verified only through a Prism provenance manifest (PRISM_COLMAP_PROVENANCE_PATH) for the approved
 *            operator-built 4.2.1 profile. A PATH-found or official prebuilt COLMAP is reported but stays
 *            `unverified`, and an unverified COLMAP never makes the toolchain ready.
 *   Brush    v0.3.x (its CLI semantics differ in later, unreleased versions; other versions are refused, not guessed).
 *   GPU      Brush's backend is wgpu/Vulkan; only the loader's presence can be checked here (a usable device is only
 *            known when Brush starts: no adapter → gpu_unavailable).
 *
 * The web job service does NOT use this to activate Local Capture yet: execution belongs to the M2D.3B worker.
 */

export interface ColmapFacts {
  installed: boolean;
  absolutePath: string | null;
  source: "configured" | "path" | null;
  version: string | null;
  provenance: ColmapProvenanceState;
  compatible: boolean;
  reason: string | null;
}

export interface BrushFacts {
  installed: boolean;
  absolutePath: string | null;
  version: string | null;
  compatible: boolean;
  reason: string | null;
}

export interface LocalToolchainProbe {
  colmap: ColmapFacts;
  brush: BrushFacts;
  gpu: { backend: "vulkan"; loaderPresent: boolean | null; reason: string };
  overall: "ready" | "incomplete" | "incompatible";
  /** how to run each tool (absolute executable, no shell); only meaningful when `overall` is ready */
  commands: { colmap: ToolCommand | null; brush: ToolCommand | null };
}

export interface ProbeOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** maps a resolved executable to the command that runs it (production: the executable itself) */
  commandFor?: (tool: "colmap" | "brush", absolutePath: string) => ToolCommand;
}

const direct = (_tool: string, p: string): ToolCommand => ({ executable: p, prefixArgs: [] });

export async function probeLocalToolchain(opts: ProbeOptions = {}): Promise<LocalToolchainProbe> {
  const env = opts.env ?? process.env;
  const commandFor = opts.commandFor ?? direct;
  const pathEnv = env.PATH ?? env.Path;

  // ── COLMAP ──
  const colmap: ColmapFacts = {
    installed: false,
    absolutePath: null,
    source: null,
    version: null,
    provenance: "missing",
    compatible: false,
    reason: null,
  };
  let colmapCmd: ToolCommand | null = null;
  const cr = await resolveExecutable({
    configured: env.PRISM_COLMAP_PATH,
    envVar: "PRISM_COLMAP_PATH",
    names: ["colmap"],
    pathEnv,
    platform: opts.platform,
  });
  if (cr.status !== "found") {
    colmap.provenance = cr.status === "invalid" ? "incompatible" : "missing";
    colmap.reason = cr.reason;
  } else {
    colmap.installed = true;
    colmap.absolutePath = cr.path;
    colmap.source = cr.source;
    colmapCmd = commandFor("colmap", cr.path);
    const v = await probeOutput(colmapCmd.executable, colmapCmd.prefixArgs, ["version"], colmapCmd.env);
    const version = /^COLMAP (\d+\.\d+\.\d+)/m.exec(v.text)?.[1] ?? null;
    colmap.version = version;
    if (!v.ok || !version) {
      colmap.provenance = "incompatible";
      colmap.reason = v.reason ?? "COLMAP did not report a version.";
    } else if (version !== APPROVED_COLMAP.version) {
      colmap.provenance = "incompatible";
      colmap.reason = `COLMAP ${version} is not supported; Prism Local Capture supports ${APPROVED_COLMAP.version} only.`;
    } else {
      const p = await checkColmapProvenance(cr.path, env.PRISM_COLMAP_PROVENANCE_PATH);
      colmap.provenance = p.state;
      colmap.reason = p.reason;
      colmap.compatible = p.state === "verified";
    }
  }

  // ── Brush ──
  const brush: BrushFacts = {
    installed: false,
    absolutePath: null,
    version: null,
    compatible: false,
    reason: null,
  };
  let brushCmd: ToolCommand | null = null;
  const br = await resolveExecutable({
    configured: env.PRISM_BRUSH_PATH,
    envVar: "PRISM_BRUSH_PATH",
    names: ["brush_app", "brush"],
    pathEnv,
    platform: opts.platform,
  });
  if (br.status !== "found") brush.reason = br.reason;
  else {
    brush.installed = true;
    brush.absolutePath = br.path;
    brushCmd = commandFor("brush", br.path);
    const v = await probeOutput(brushCmd.executable, brushCmd.prefixArgs, ["--version"], brushCmd.env);
    const sv = v.ok ? parseSemver(v.text) : null;
    brush.version = sv?.text ?? null;
    if (!sv) brush.reason = v.reason ?? "Brush did not report a version.";
    else if (sv.major !== SUPPORTED_BRUSH.major || sv.minor !== SUPPORTED_BRUSH.minor)
      brush.reason = `Brush ${sv.text} is not supported; Prism supports Brush ${SUPPORTED_BRUSH.major}.${SUPPORTED_BRUSH.minor}.x.`;
    else brush.compatible = true;
  }

  // ── GPU ──
  const loader = await vulkanLoaderPresent(opts.platform, env);
  const gpu = {
    backend: "vulkan" as const,
    loaderPresent: loader,
    reason:
      loader === false
        ? "No Vulkan loader was found; Brush needs a Vulkan-capable GPU and driver."
        : "A usable GPU is only confirmed when Brush starts (no adapter is reported as gpu_unavailable).",
  };

  const incompatible =
    colmap.provenance === "incompatible" || (brush.installed && !brush.compatible && brush.version !== null);
  const ready = colmap.compatible && brush.compatible && loader !== false;
  return {
    colmap,
    brush,
    gpu,
    overall: ready ? "ready" : incompatible ? "incompatible" : "incomplete",
    commands: ready ? { colmap: colmapCmd, brush: brushCmd } : { colmap: null, brush: null },
  };
}

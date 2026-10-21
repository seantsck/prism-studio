import { stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "../local/process";
import { resolveExecutable } from "../local/resolve";

/**
 * Phase 2F M2D.3D1: a local, read-only hardware audit for real-tool acceptance. It reads facts the operating system
 * already exposes (Node's `os`, `statfs`, Windows CIM through a FIXED PowerShell query, `vulkaninfo --summary`) and
 * nothing else: no telemetry, no upload, no network, no driver change. It never reports the user name, the host name
 * or a path (the disk figure belongs to "the work root's volume").
 *
 * What it does NOT know is said so rather than guessed: VRAM is not reliably detectable from these sources
 * (Win32_VideoController.AdapterRAM is a 32-bit field and, for an integrated GPU, a shared aperture), and a Vulkan
 * device that enumerates is not proof that Brush can train on it (only the REAL_SMOKE run proves that).
 */

export type VulkanDeviceType = "discrete" | "integrated" | "virtual" | "cpu" | "other";

export interface VulkanDevice {
  name: string;
  type: VulkanDeviceType;
  apiVersion: string | null;
  driverName: string | null;
  driverInfo: string | null;
  vendorId: string | null;
}

export interface GpuAdapter {
  name: string;
  driverVersion: string | null;
  /** Win32_VideoController.AdapterRAM: a 32-bit field (wraps above 4 GB; a shared aperture for integrated GPUs) */
  reportedMemoryBytes: number | null;
}

export interface HardwareFacts {
  os: { platform: NodeJS.Platform; release: string; arch: string; caption: string | null };
  cpu: { model: string | null; logicalCores: number; physicalCores: number | null };
  memory: { totalBytes: number; freeBytes: number };
  /** the volume that holds the acceptance workspace (no path is reported) */
  disk: { freeBytes: number | null; totalBytes: number | null };
  gpus: GpuAdapter[];
  vulkan: {
    loaderPresent: boolean | null;
    vulkaninfo: "ok" | "missing" | "failed";
    instanceVersion: string | null;
    devices: VulkanDevice[];
  };
  /** facts that could not be read, and why (never guessed) */
  notes: string[];
}

export type Exec = (executable: string, args: string[]) => Promise<{ ok: boolean; text: string }>;

export interface HardwareProbeOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** the directory whose volume must hold the workspace (statfs) */
  diskPath: string;
  exec?: Exec;
  /** test seams */
  osFacts?: () => Pick<HardwareFacts, "cpu" | "memory"> & { release: string; arch: string };
  statfs?: (
    p: string,
  ) => Promise<{ bavail: number | bigint; blocks: number | bigint; bsize: number | bigint }>;
}

const defaultExec: Exec = async (executable, args) => {
  const r = await runProcess({
    executable,
    args,
    cwd: path.dirname(executable),
    timeoutMs: 30_000,
    maxOutputBytes: 256 * 1024,
  });
  return { ok: r.outcome === "exited" && r.exitCode === 0, text: `${r.stdout}\n${r.stderr}` };
};

/** `vulkaninfo --summary` → instance version and devices. Unknown lines are ignored; nothing is invented. */
export function parseVulkanSummary(text: string): {
  instanceVersion: string | null;
  devices: VulkanDevice[];
} {
  const instanceVersion = /Vulkan Instance Version:\s*([\d.]+)/.exec(text)?.[1] ?? null;
  const devices: VulkanDevice[] = [];
  const blocks = text.split(/^GPU\d+:\s*$/m).slice(1);
  for (const b of blocks) {
    const field = (k: string) => new RegExp(`^\\s*${k}\\s*=\\s*(.+?)\\s*$`, "m").exec(b)?.[1] ?? null;
    const name = field("deviceName");
    if (!name) continue;
    const t = field("deviceType") ?? "";
    const type: VulkanDeviceType = t.includes("DISCRETE")
      ? "discrete"
      : t.includes("INTEGRATED")
        ? "integrated"
        : t.includes("VIRTUAL")
          ? "virtual"
          : t.includes("CPU")
            ? "cpu"
            : "other";
    const api = field("apiVersion");
    devices.push({
      name,
      type,
      apiVersion: api ? (/\(([\d.]+)\)/.exec(api)?.[1] ?? api) : null,
      driverName: field("driverName"),
      driverInfo: field("driverInfo"),
      vendorId: field("vendorID"),
    });
  }
  // vulkaninfo can list one physical device twice (e.g. two ICD manifests for the same driver)
  const seen = new Set<string>();
  return {
    instanceVersion,
    devices: devices.filter((d) => {
      const k = `${d.name}|${d.type}|${d.apiVersion}|${d.driverInfo}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
  };
}

/** The fixed CIM query's JSON (single object or array) → adapters and the OS caption. Malformed → empty. */
export function parseWindowsCim(text: string): {
  caption: string | null;
  physicalCores: number | null;
  gpus: GpuAdapter[];
} {
  try {
    const j = JSON.parse(text.slice(text.indexOf("{"))) as {
      caption?: unknown;
      cores?: unknown;
      gpus?: unknown;
    };
    const list = Array.isArray(j.gpus) ? j.gpus : j.gpus ? [j.gpus] : [];
    const coreList = Array.isArray(j.cores) ? j.cores : [j.cores];
    const cores = coreList.reduce<number>((n, c) => n + (typeof c === "number" ? c : 0), 0);
    return {
      caption: typeof j.caption === "string" ? j.caption.slice(0, 120) : null,
      physicalCores: cores > 0 ? cores : null,
      gpus: list
        .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
        .filter((g) => typeof g.Name === "string")
        .map((g) => ({
          name: String(g.Name).slice(0, 120),
          driverVersion: typeof g.DriverVersion === "string" ? g.DriverVersion.slice(0, 40) : null,
          reportedMemoryBytes: typeof g.AdapterRAM === "number" && g.AdapterRAM > 0 ? g.AdapterRAM : null,
        })),
    };
  } catch {
    return { caption: null, physicalCores: null, gpus: [] };
  }
}

/** One fixed, read-only query: OS caption, physical cores per CPU, display adapters. No user, host or path. */
export const WINDOWS_CIM_QUERY = [
  "$ErrorActionPreference='Stop';",
  "$o=Get-CimInstance Win32_OperatingSystem;",
  "$c=@(Get-CimInstance Win32_Processor | ForEach-Object { $_.NumberOfCores });",
  "$g=@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM);",
  "[pscustomobject]@{caption=$o.Caption;cores=$c;gpus=$g} | ConvertTo-Json -Compress -Depth 3",
].join(" ");

export async function probeHardware(o: HardwareProbeOptions): Promise<HardwareFacts> {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const exec = o.exec ?? defaultExec;
  const notes: string[] = [];

  const base = o.osFacts?.() ?? {
    release: os.release(),
    arch: os.arch(),
    cpu: { model: os.cpus()[0]?.model?.trim() ?? null, logicalCores: os.cpus().length, physicalCores: null },
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
  };

  // disk: the volume of the workspace directory
  let disk: HardwareFacts["disk"] = { freeBytes: null, totalBytes: null };
  try {
    const s = await (o.statfs ?? statfs)(o.diskPath);
    disk = {
      freeBytes: Number(s.bavail) * Number(s.bsize),
      totalBytes: Number(s.blocks) * Number(s.bsize),
    };
  } catch {
    notes.push("Free disk space could not be read for the workspace volume.");
  }

  // Windows: OS caption, physical cores, display adapters (fixed CIM query, no shell)
  let caption: string | null = null;
  let physicalCores: number | null = base.cpu.physicalCores;
  let gpus: GpuAdapter[] = [];
  if (platform === "win32") {
    const ps = path.join(
      env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const r = await exec(ps, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CIM_QUERY]).catch(() => ({
      ok: false,
      text: "",
    }));
    if (r.ok) ({ caption, physicalCores, gpus } = parseWindowsCim(r.text));
    else notes.push("The Windows display-adapter query did not run; GPU adapters come from Vulkan only.");
  }

  // Vulkan: loader + enumerated devices (vulkaninfo ships with the Vulkan runtime / SDK)
  const loader =
    platform === "win32"
      ? await fileExists(path.join(env.SystemRoot ?? "C:\\Windows", "System32", "vulkan-1.dll"))
      : platform === "linux"
        ? (await fileExists("/usr/lib/x86_64-linux-gnu/libvulkan.so.1")) ||
          (await fileExists("/usr/lib/libvulkan.so.1")) ||
          (await fileExists("/usr/lib64/libvulkan.so.1"))
        : null;
  const vi = await resolveExecutable({
    configured: undefined,
    envVar: "PATH",
    names: ["vulkaninfo"],
    pathEnv: env.PATH ?? env.Path,
    platform,
  });
  let vulkan: HardwareFacts["vulkan"] = {
    loaderPresent: loader,
    vulkaninfo: "missing",
    instanceVersion: null,
    devices: [],
  };
  if (vi.status === "found") {
    const r = await exec(vi.path, ["--summary"]).catch(() => ({ ok: false, text: "" }));
    if (r.ok) vulkan = { loaderPresent: loader, vulkaninfo: "ok", ...parseVulkanSummary(r.text) };
    else {
      vulkan = { ...vulkan, vulkaninfo: "failed" };
      notes.push("vulkaninfo did not complete; no Vulkan device could be enumerated.");
    }
  } else
    notes.push(
      "vulkaninfo is not installed; Vulkan devices cannot be enumerated (install the Vulkan runtime/SDK).",
    );
  notes.push("VRAM is not reliably detectable from these sources and is not reported.");

  return {
    os: { platform, release: base.release, arch: base.arch, caption },
    cpu: { ...base.cpu, physicalCores },
    memory: base.memory,
    disk,
    gpus,
    vulkan,
    notes,
  };
}

async function fileExists(p: string): Promise<boolean> {
  return !!(await stat(p).catch(() => null))?.isFile();
}

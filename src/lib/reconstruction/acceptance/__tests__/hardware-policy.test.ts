import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  parseVulkanSummary,
  parseWindowsCim,
  probeHardware,
  WINDOWS_CIM_QUERY,
  type HardwareFacts,
} from "../hardware";
import { assessHardware, HARDWARE_POLICY, roomDiskRequirement } from "../policy";

const GiB = 1024 ** 3;

// the shape `vulkaninfo --summary` prints (this one lists the same integrated device twice, as some drivers do)
const INTEGRATED_SUMMARY = `==========
VULKANINFO
==========

Vulkan Instance Version: 1.3.204

Devices:
========
GPU0:
	apiVersion         = 4206807 (1.3.215)
	driverVersion      = 1656899 (0x194843)
	vendorID           = 0x8086
	deviceID           = 0x191e
	deviceType         = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU
	deviceName         = Intel(R) HD Graphics 515
	driverID           = DRIVER_ID_INTEL_PROPRIETARY_WINDOWS
	driverName         = Intel Corporation
	driverInfo         = Intel driver
GPU1:
	apiVersion         = 4206807 (1.3.215)
	vendorID           = 0x8086
	deviceType         = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU
	deviceName         = Intel(R) HD Graphics 515
	driverName         = Intel Corporation
	driverInfo         = Intel driver
`;
const DISCRETE_SUMMARY = `Vulkan Instance Version: 1.3.280

Devices:
========
GPU0:
	apiVersion         = 1.3.277
	vendorID           = 0x10de
	deviceType         = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU
	deviceName         = NVIDIA GeForce RTX 4070
	driverName         = NVIDIA
	driverInfo         = 551.86
GPU1:
	apiVersion         = 1.3.274
	deviceType         = PHYSICAL_DEVICE_TYPE_CPU
	deviceName         = llvmpipe (LLVM 17.0.6, 256 bits)
	driverName         = llvmpipe
`;
const CPU_ONLY_SUMMARY = `Vulkan Instance Version: 1.3.250
GPU0:
	deviceType         = PHYSICAL_DEVICE_TYPE_CPU
	deviceName         = llvmpipe (LLVM 15.0.7, 256 bits)
`;

function machine(
  o: Partial<{
    platform: NodeJS.Platform;
    arch: string;
    logical: number;
    ram: number;
    free: number | null;
    vulkan: HardwareFacts["vulkan"];
  }> = {},
): HardwareFacts {
  return {
    os: {
      platform: o.platform ?? "win32",
      release: "10.0.22631",
      arch: o.arch ?? "x64",
      caption: "Windows 11 Pro",
    },
    cpu: { model: "Fictional CPU", logicalCores: o.logical ?? 16, physicalCores: 8 },
    memory: { totalBytes: o.ram ?? 32 * GiB, freeBytes: 20 * GiB },
    disk: { freeBytes: o.free === undefined ? 500 * GiB : o.free, totalBytes: 1000 * GiB },
    gpus: [],
    vulkan: o.vulkan ?? {
      loaderPresent: true,
      vulkaninfo: "ok",
      ...parseVulkanSummary(DISCRETE_SUMMARY),
    },
    notes: [],
  };
}

describe("hardware probe parsing", () => {
  it("reads vulkaninfo --summary devices; duplicates collapse; device types are kept", () => {
    const i = parseVulkanSummary(INTEGRATED_SUMMARY);
    expect(i.instanceVersion).toBe("1.3.204");
    expect(i.devices).toEqual([
      {
        name: "Intel(R) HD Graphics 515",
        type: "integrated",
        apiVersion: "1.3.215",
        driverName: "Intel Corporation",
        driverInfo: "Intel driver",
        vendorId: "0x8086",
      },
    ]);
    expect(parseVulkanSummary(DISCRETE_SUMMARY).devices.map((d) => [d.name, d.type])).toEqual([
      ["NVIDIA GeForce RTX 4070", "discrete"],
      ["llvmpipe (LLVM 17.0.6, 256 bits)", "cpu"],
    ]);
    expect(parseVulkanSummary("").devices).toEqual([]);
    expect(parseVulkanSummary("garbage\nGPU0:\n\tnothing useful").devices).toEqual([]);
  });

  it("reads the fixed Windows CIM query (one adapter or several; malformed → nothing invented)", () => {
    expect(
      parseWindowsCim(
        '{"caption":"Microsoft Windows 11 Pro","cores":[2],"gpus":{"Name":"Intel(R) HD Graphics 515","DriverVersion":"31.0.101.2115","AdapterRAM":1073741824}}',
      ),
    ).toEqual({
      caption: "Microsoft Windows 11 Pro",
      physicalCores: 2,
      gpus: [
        { name: "Intel(R) HD Graphics 515", driverVersion: "31.0.101.2115", reportedMemoryBytes: 1073741824 },
      ],
    });
    expect(
      parseWindowsCim(
        '{"caption":"x","cores":[8,8],"gpus":[{"Name":"A","DriverVersion":null,"AdapterRAM":null},{"Name":"B"}]}',
      ).gpus.map((g) => g.name),
    ).toEqual(["A", "B"]);
    expect(parseWindowsCim('{"caption":"x","cores":[8,8],"gpus":[]}').physicalCores).toBe(16);
    expect(parseWindowsCim("not json")).toEqual({ caption: null, physicalCores: null, gpus: [] });
    // the query is fixed and read-only (no user, host or path is asked for)
    expect(WINDOWS_CIM_QUERY).not.toMatch(/UserName|CSName|ComputerName|Path|Set-|Remove-|Invoke-/i);
  });

  it("probeHardware reports facts without a user name, host name or path; missing vulkaninfo is said, not guessed", async () => {
    const calls: string[][] = [];
    const facts = await probeHardware({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows", PATH: "" },
      diskPath: "C:\\fictional",
      statfs: async () => ({ bavail: 10, blocks: 100, bsize: 1024 }),
      osFacts: () => ({
        release: "10.0.22631",
        arch: "x64",
        cpu: { model: "Fictional CPU", logicalCores: 4, physicalCores: null },
        memory: { totalBytes: 16 * GiB, freeBytes: 6 * GiB },
      }),
      exec: async (exe, args) => {
        calls.push([exe, ...args]);
        return { ok: true, text: '{"caption":"Windows 11 Pro","cores":[2],"gpus":{"Name":"Fictional GPU"}}' };
      },
    });
    expect(calls).toHaveLength(1); // the CIM query only: vulkaninfo was not found on PATH
    expect(calls[0]![0]).toMatch(/powershell\.exe$/i);
    expect(calls[0]).toContain("-NonInteractive");
    expect(facts.disk).toEqual({ freeBytes: 10 * 1024, totalBytes: 100 * 1024 });
    expect(facts.cpu.physicalCores).toBe(2);
    expect(facts.vulkan.vulkaninfo).toBe("missing");
    expect(facts.notes.join(" ")).toMatch(/vulkaninfo is not installed/);
    expect(facts.notes.join(" ")).toMatch(/VRAM is not reliably detectable/);
    const text = JSON.stringify(facts);
    expect(text).not.toContain(os.hostname());
    expect(text).not.toContain(os.userInfo().username);
    expect(text).not.toContain("C:\\fictional");
  });
});

describe("hardware acceptance policy", () => {
  it("a discrete Vulkan GPU, 16 logical cores, 32 GB and room on disk: PRACTICAL → READY_FOR_REAL_RUN", () => {
    const a = assessHardware(machine());
    expect(a).toMatchObject({
      tier: "PRACTICAL",
      decision: "READY_FOR_REAL_RUN",
      smokeEligible: true,
      reasons: [],
    });
    // the CPU rasteriser is never counted as a usable device
    expect(a.usableVulkanDevices).toEqual(["NVIDIA GeForce RTX 4070 (discrete, Vulkan 1.3.277)"]);
  });

  it("an integrated GPU, 4 logical cores, 16 GB: SUPPORTED_FOR_TEST (smoke only) → NOT_READY_FOR_REAL_RUN", () => {
    const a = assessHardware(
      machine({
        logical: 4,
        ram: 15.9 * GiB,
        free: 94 * GiB,
        vulkan: { loaderPresent: true, vulkaninfo: "ok", ...parseVulkanSummary(INTEGRATED_SUMMARY) },
      }),
    );
    expect(a.tier).toBe("SUPPORTED_FOR_TEST");
    expect(a.decision).toBe("NOT_READY_FOR_REAL_RUN");
    expect(a.smokeEligible).toBe(true);
    expect(a.reasons.join(" ")).toMatch(/integrated GPU/);
    expect(a.reasons.join(" ")).toMatch(/4 logical CPU cores/);
    // a nominal 16 GB machine (15.9 GiB usable) is not penalised for its reserved memory
    expect(a.reasons.join(" ")).not.toMatch(/RAM/);
  });

  it("a Vulkan DLL alone is not evidence: no vulkaninfo, no loader, or only a CPU device → UNSUPPORTED", () => {
    const noTool = assessHardware(
      machine({ vulkan: { loaderPresent: true, vulkaninfo: "missing", instanceVersion: null, devices: [] } }),
    );
    expect(noTool.tier).toBe("UNSUPPORTED");
    expect(noTool.reasons.join(" ")).toMatch(/loader on disk is not enough evidence/);
    const noLoader = assessHardware(
      machine({
        vulkan: { loaderPresent: false, vulkaninfo: "missing", instanceVersion: null, devices: [] },
      }),
    );
    expect(noLoader.reasons.join(" ")).toMatch(/No Vulkan loader/);
    const cpuOnly = assessHardware(
      machine({ vulkan: { loaderPresent: true, vulkaninfo: "ok", ...parseVulkanSummary(CPU_ONLY_SUMMARY) } }),
    );
    expect(cpuOnly).toMatchObject({
      tier: "UNSUPPORTED",
      smokeEligible: false,
      decision: "NOT_READY_FOR_REAL_RUN",
    });
    expect(cpuOnly.reasons.join(" ")).toMatch(/software\/virtual Vulkan device/);
    const failed = assessHardware(
      machine({ vulkan: { loaderPresent: true, vulkaninfo: "failed", instanceVersion: null, devices: [] } }),
    );
    expect(failed.tier).toBe("UNSUPPORTED");
  });

  it("unsupported platform, architecture or memory", () => {
    expect(assessHardware(machine({ platform: "darwin" })).reasons[0]).toMatch(
      /darwin is not a supported platform/,
    );
    expect(assessHardware(machine({ arch: "arm64" })).tier).toBe("UNSUPPORTED");
    expect(assessHardware(machine({ ram: 4 * GiB })).reasons.join(" ")).toMatch(/below Prism's minimum/);
  });

  it("disk: below the smoke need is UNSUPPORTED; below a room's conservative need is a limitation; unknown refuses", () => {
    expect(assessHardware(machine({ free: 1 * GiB })).tier).toBe("UNSUPPORTED");
    const tight = assessHardware(machine({ free: 20 * GiB }));
    expect(tight.tier).toBe("SUPPORTED_FOR_TEST");
    expect(tight.reasons.join(" ")).toMatch(/needs about 35\.0 GiB/);
    // a bigger dataset needs more
    expect(assessHardware(machine({ free: 59 * GiB }), { roomInputBytes: 2 * GiB }).tier).toBe(
      "SUPPORTED_FOR_TEST",
    );
    expect(assessHardware(machine({ free: 60 * GiB }), { roomInputBytes: 2 * GiB }).tier).toBe("PRACTICAL");
    expect(assessHardware(machine({ free: null })).tier).toBe("UNSUPPORTED");
    expect(roomDiskRequirement(0)).toBe(HARDWARE_POLICY.roomFixedBytes);
    expect(roomDiskRequirement(1 * GiB)).toBe(10 * GiB + 25 * GiB);
  });
});

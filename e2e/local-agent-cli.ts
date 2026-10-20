import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fakeMachine, machineEnv } from "../src/lib/reconstruction/local/__tests__/fake-machine";

/**
 * Runs the REAL remote Local Agent CLI (`scripts/local-agent.mts`) as a separate process, the way a user's workstation
 * would: with a MINIMAL environment (no Supabase, database, worker, Storage or provider credential) and its identity in
 * a throwaway agent home. `--fake-tools` makes its toolchain probe report the M2D.3A fake tools (NODE_ENV=test only).
 */
export async function agentCli(home: string) {
  const start = await agentProcess(home);
  return async (args: string[], withTools = false) => {
    const p = start(args, withTools);
    const code = await p.exit;
    return { code, out: p.output() };
  };
}

/**
 * The same, started in the BACKGROUND (a long-running `run` that leases and executes remote jobs): returns the process,
 * its output so far and its exit. `extra` adds test-only variables (e.g. FAKE_BRUSH_MODE=slow).
 */
export async function agentProcess(home: string) {
  const machine = await fakeMachine(path.join(home, "machine"));
  const toolEnv = {
    ...machineEnv(machine),
    SystemRoot: process.env.SystemRoot ?? "",
    PRISM_LOCAL_TEST_SYSTEM_ROOT: machine.sysRoot,
  };
  return (args: string[], withTools = false, extra: Record<string, string> = {}) => {
    const child: ChildProcess = spawn(
      process.execPath,
      [path.resolve("node_modules/tsx/dist/cli.mjs"), "scripts/local-agent.mts", ...args],
      {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          TEMP: process.env.TEMP ?? os.tmpdir(),
          TMP: process.env.TMP ?? os.tmpdir(),
          NODE_ENV: "test",
          PRISM_LOCAL_AGENT_HOME: path.join(home, "agent"),
          ...(withTools ? toolEnv : {}),
          ...extra,
        },
      },
    );
    let out = "";
    child.stdout!.on("data", (d: Buffer) => (out += String(d)));
    child.stderr!.on("data", (d: Buffer) => (out += String(d)));
    const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    return { child, exit, output: () => out };
  };
}

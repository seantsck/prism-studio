import path from "node:path";
import type { ToolCommand } from "../process";

/**
 * TEST-ONLY commands for the fake external tools. Each runs the Node binary with a fake tool script, so the fake is a
 * REAL child process going through Prism's process runner exactly like colmap.exe / brush_app.exe would.
 */
const FAKES = path.join(__dirname, "fakes");
const tool = (script: string, env: Record<string, string>): ToolCommand => ({
  executable: process.execPath,
  prefixArgs: [path.join(FAKES, script)],
  env,
});

export const fakeColmap = (mode = "success", extraEnv: Record<string, string> = {}) =>
  tool("fake-colmap.mjs", { FAKE_COLMAP_MODE: mode, ...extraEnv });
export const fakeBrush = (mode = "success") => tool("fake-brush.mjs", { FAKE_BRUSH_MODE: mode });
export const fakeGit = (mode = "clean") => tool("fake-git.mjs", { FAKE_GIT_MODE: mode });

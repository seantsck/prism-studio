/**
 * How the calibration and smoke wrappers end the process. `process.exit(code)` inside the CLI's promise callback
 * tears Node down while the SDK's sockets are still closing; on Windows that has aborted the process with a libuv
 * `UV_HANDLE_CLOSING` assertion AFTER a valid report was written, so the shell saw 127 instead of the CLI's code.
 * Setting `exitCode` lets the event loop drain and exit with the CLI's code. A handle that never closes must not
 * hang an operator's terminal, so an unref'd timer (which never keeps the loop alive itself) forces the same code
 * after a grace period.
 */
export const EXIT_GRACE_MS = 10_000;

export interface ExitTarget {
  exitCode?: number | string | null;
  exit(code: number): void;
}

export function exitGracefully(
  code: number,
  target: ExitTarget = process,
  schedule: (fn: () => void, ms: number) => { unref(): unknown } = setTimeout,
): void {
  target.exitCode = code;
  schedule(() => target.exit(code), EXIT_GRACE_MS).unref();
}

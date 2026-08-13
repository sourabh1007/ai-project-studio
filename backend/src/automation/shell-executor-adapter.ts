import { exec } from 'node:child_process';
import type { ShellExecutor } from './automation-ports.js';

/**
 * Real {@link ShellExecutor} backed by `child_process.exec`. Thin IO adapter
 * (excluded from unit coverage like other process adapters); the engine logic
 * that consumes it is fully tested against the port with in-memory fakes.
 */
export function createShellExecutor(timeoutMs: number): ShellExecutor {
  return {
    exec(command, cwd) {
      return new Promise((resolve) => {
        exec(
          command,
          {
            cwd,
            timeout: timeoutMs,
            windowsHide: true,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            // Inherit the app's full environment so CLI tools (az, gh, …) reuse
            // the credentials the user already established on this machine — a
            // prior `az login` / `gh auth login` or an IDE-provided token — with
            // no separate sign-in for the monitor.
            env: process.env,
          },
          (err, stdout, stderr) => {
            const code =
              err && typeof (err as { code?: unknown }).code === 'number'
                ? (err as { code: number }).code
                : err
                  ? 1
                  : 0;
            resolve({
              code,
              stdout: stdout ?? '',
              stderr: stderr ?? '',
            });
          },
        );
      });
    },
  };
}

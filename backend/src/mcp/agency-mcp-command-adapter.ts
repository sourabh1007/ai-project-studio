import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AgencyMcpConfigRunner } from './agency-mcp-config-store.js';

/** Direct argv invocation only: native MCP arguments never become a shell command. */
export function createAgencyMcpCommandRunner(deps: {
  executable: () => string; cwd: string; timeoutMs: number;
}): AgencyMcpConfigRunner {
  return {
    run: (args) => new Promise((resolve, reject) => {
      const executable = deps.executable();
      if (!existsSync(executable) || /\.(cmd|bat)$/i.test(executable)) {
        reject(new Error('Agency executable unavailable for direct configuration access'));
        return;
      }
      execFile(executable, args, {
        cwd: deps.cwd, timeout: deps.timeoutMs, killSignal: 'SIGKILL',
        maxBuffer: 1_048_576, windowsHide: true, shell: false,
      }, (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(new Error('Agency configuration command failed or timed out'));
          return;
        }
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      });
    }),
  };
}

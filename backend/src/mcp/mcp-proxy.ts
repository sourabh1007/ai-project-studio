import { spawn } from 'node:child_process';
import { createMcpMeter } from './mcp-proxy-meter.js';
import { postMcpUsage } from './mcp-proxy-report.js';

/**
 * MCP launch proxy. The CLI runs `node mcp-proxy.js <realCommand> [...args]`
 * (see wrapServerSpec). This process spawns the real MCP server, passes stdio
 * through transparently while metering it, and on exit posts the measured
 * per-server usage to the control API. It is a strict pass-through: if metering
 * or reporting fails, the wrapped server keeps working unaffected.
 */
const [, , command, ...args] = process.argv;

if (!command) {
  process.stderr.write('mcp-proxy: missing target command\n');
  process.exit(2);
}

const meter = createMcpMeter();
const child = spawn(command, args, {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
  // On Windows, npm-family launchers (npx/npm) are `.cmd` shims that Node's
  // shell-less spawn cannot resolve, so the raw session launch fails with
  // `spawn npx ENOENT` even though the MCP manager's probe — which spawns with
  // a shell — reports the same server as connected. Use a shell here too so the
  // real launch matches the probe and the two never disagree.
  shell: process.platform === 'win32',
  windowsHide: true,
});

process.stdin.on('data', (chunk: Buffer) => {
  meter.onClientData(chunk);
  child.stdin.write(chunk);
});
process.stdin.on('end', () => child.stdin.end());

child.stdout.on('data', (chunk: Buffer) => {
  meter.onServerData(chunk);
  process.stdout.write(chunk);
});

child.on('error', (error) => {
  process.stderr.write(`mcp-proxy: failed to launch server: ${error.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  void postMcpUsage(fetch, process.env, meter.snapshot()).finally(() => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
});

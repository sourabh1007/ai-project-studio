import { spawn } from 'node:child_process';
import { createMcpMeter } from './mcp-proxy-meter.js';
import { postMcpUsage } from './mcp-proxy-report.js';
import { mcpInspectorLaunch } from './mcp-inspector-launch.js';

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
const launch = (() => {
  try { return mcpInspectorLaunch(command, args, process.platform); }
  catch (error) {
    process.stderr.write(`mcp-proxy: ${(error as Error).message}\n`);
    process.exit(2);
  }
})();
const child = spawn(launch.command, launch.args, {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
  shell: launch.shell,
  windowsVerbatimArguments: launch.windowsVerbatimArguments,
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

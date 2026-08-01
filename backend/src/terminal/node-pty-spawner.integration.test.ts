import { describe, it, expect } from 'vitest';
import { createNodePtySpawner } from './node-pty-spawner.js';
import { createTerminalSession } from './terminal-session.js';
import { resolveExecutable } from './executable-resolver.js';

/**
 * End-to-end guarantee that the interactive terminal actually launches a real
 * process and streams its output back — the exact promise that broke when
 * "the terminal won't open". Unlike the unit tests that mock the PtySpawner,
 * this exercises the real native `node-pty` adapter, real PATH resolution and
 * the terminal-session fan-out together, so a regression in spawning, resolving
 * or piping is caught automatically.
 *
 * Uses the current Node runtime (a bare `node` command, resolved via the real
 * system PATH exactly like `agency`/`copilot`) as a stand-in CLI so the test is
 * cross-platform and needs no external tooling installed.
 */
const MARKER = 'PTY_PIPELINE_OK';

interface RunResult {
  output: string;
  transcript: string;
  exitCode: number | null;
}

function runInteractive(command: string, args: string[]): Promise<RunResult> {
  const spawner = createNodePtySpawner();
  const pty = spawner.spawn({
    command,
    args,
    env: process.env as Record<string, string>,
    cols: 80,
    rows: 24,
  });

  return new Promise<RunResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pty.kill();
      reject(new Error('terminal did not exit in time'));
    }, 15000);

    let output = '';
    const session = createTerminalSession({
      sessionId: 'integration',
      pty,
      scrollbackBytes: 1 << 16,
      transcriptBytes: 1 << 20,
      onExit: (exitCode) => {
        clearTimeout(timeout);
        resolve({ output, transcript: session.transcriptText(), exitCode });
      },
    });
    session.attach({
      send: (data) => {
        output += data;
      },
      exit: () => {},
    });
  });
}

describe('node-pty terminal pipeline (integration)', () => {
  it('resolves a bare command name against the real system PATH', () => {
    // `node` is guaranteed present (we are running under it). This is the same
    // resolution path a bare `agency` executable takes on a user machine.
    const resolved = resolveExecutable('node');
    expect(resolved).not.toBe('node');
    expect(resolved.toLowerCase()).toContain('node');
  });

  it('spawns a real PTY, streams stdout, and reports a clean exit', async () => {
    const result = await runInteractive('node', [
      '-e',
      `process.stdout.write('${MARKER}')`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.transcript).toContain(MARKER);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('propagates a non-zero exit code from the launched process', async () => {
    const result = await runInteractive('node', ['-e', 'process.exit(3)']);
    expect(result.exitCode).toBe(3);
  });
});

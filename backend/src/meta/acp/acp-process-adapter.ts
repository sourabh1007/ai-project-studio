import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { LineAssembler } from '../../provider/process-kernel/stream-reader.js';
import type { AcpProcess } from './acp-client.js';

export interface AcpSpawnOptions {
  /** Absolute path to the copilot executable. */
  executable: string;
  /** Extra args appended after the base `--acp` flags. */
  extraArgs?: string[];
  /** Environment for the child; defaults to the current process env. */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the child process. */
  cwd?: string;
}

/**
 * Real `copilot --acp` child process adapted to the {@link AcpProcess} port.
 *
 * This is an IO/native boundary (like `node-pty-spawner.ts`) and is excluded
 * from unit-test coverage; the pure protocol/client/pool logic that drives it is
 * fully unit-tested against fakes.
 */
export class AcpProcessAdapter implements AcpProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdout = new LineAssembler();
  private lineHandler: ((line: string) => void) | null = null;
  private exitHandler: ((code: number | null) => void) | null = null;
  private exited = false;

  constructor(options: AcpSpawnOptions) {
    const args = ['--acp', '--disable-builtin-mcps', ...(options.extraArgs ?? [])];
    this.child = spawn(options.executable, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: 'pipe',
      shell: false,
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      for (const line of this.stdout.push(chunk)) {
        this.lineHandler?.(line);
      }
    });

    const onDone = (code: number | null): void => {
      if (this.exited) {
        return;
      }
      this.exited = true;
      this.exitHandler?.(code);
    };
    this.child.on('close', onDone);
    this.child.on('error', () => onDone(null));
  }

  write(line: string): void {
    this.child.stdin.write(line);
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandler = handler;
  }

  kill(): void {
    this.child.kill();
  }
}

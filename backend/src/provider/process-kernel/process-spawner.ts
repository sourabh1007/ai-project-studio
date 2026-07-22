import { spawn as nodeSpawn } from 'node:child_process';
import type { Clock } from '../../kernel/clock.js';
import { LineAssembler } from './stream-reader.js';
import {
  ProcessLifecycle,
  type ProcessLifecycleSnapshot,
} from './process-lifecycle.js';

export interface SpawnRequest {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

/** Handle to a running process exposing line-oriented output and lifecycle. */
export interface ProcessHandle {
  onStdoutLine(cb: (line: string) => void): void;
  onStderrLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
  readonly done: Promise<number | null>;
  snapshot(): ProcessLifecycleSnapshot;
}

export interface ProcessSpawner {
  spawn(request: SpawnRequest): ProcessHandle;
}

/** Minimal shape of a spawned child process this kernel depends on. */
export interface RawStream {
  on(event: 'data', cb: (chunk: Buffer | string) => void): void;
}

export interface RawChildProcess {
  stdout: RawStream | null;
  stderr: RawStream | null;
  on(event: 'close', cb: (code: number | null) => void): void;
  kill(): void;
}

export type RawSpawn = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; cwd?: string },
) => RawChildProcess;

const defaultRawSpawn: RawSpawn = (command, args, options) =>
  nodeSpawn(command, args, {
    env: options.env,
    cwd: options.cwd,
    stdio: 'pipe',
    shell: false,
  }) as unknown as RawChildProcess;

export function createProcessSpawner(
  clock: Clock,
  rawSpawn: RawSpawn = defaultRawSpawn,
): ProcessSpawner {
  return {
    spawn(request) {
      const lifecycle = new ProcessLifecycle(clock);
      const stdoutCbs: ((line: string) => void)[] = [];
      const stderrCbs: ((line: string) => void)[] = [];
      const exitCbs: ((code: number | null) => void)[] = [];
      const stdoutAssembler = new LineAssembler();
      const stderrAssembler = new LineAssembler();

      const child = rawSpawn(request.command, request.args, {
        env: request.env,
        cwd: request.cwd,
      });
      lifecycle.markRunning();

      const pump = (
        stream: RawStream | null,
        assembler: LineAssembler,
        cbs: ((line: string) => void)[],
      ): void => {
        if (!stream) {
          return;
        }
        stream.on('data', (chunk) => {
          for (const line of assembler.push(String(chunk))) {
            for (const cb of cbs) {
              cb(line);
            }
          }
        });
      };

      pump(child.stdout, stdoutAssembler, stdoutCbs);
      pump(child.stderr, stderrAssembler, stderrCbs);

      const done = new Promise<number | null>((resolve) => {
        child.on('close', (code) => {
          const flushTrailing = (
            assembler: LineAssembler,
            cbs: ((line: string) => void)[],
          ): void => {
            const trailing = assembler.flush();
            if (trailing !== undefined) {
              for (const cb of cbs) {
                cb(trailing);
              }
            }
          };
          flushTrailing(stdoutAssembler, stdoutCbs);
          flushTrailing(stderrAssembler, stderrCbs);
          lifecycle.markExited(code);
          for (const cb of exitCbs) {
            cb(code);
          }
          resolve(code);
        });
      });

      return {
        onStdoutLine: (cb) => stdoutCbs.push(cb),
        onStderrLine: (cb) => stderrCbs.push(cb),
        onExit: (cb) => exitCbs.push(cb),
        kill: () => child.kill(),
        done,
        snapshot: () => lifecycle.snapshot(),
      };
    },
  };
}

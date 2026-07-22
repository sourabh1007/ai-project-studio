import * as pty from 'node-pty';
import type {
  PtyProcess,
  PtySpawnRequest,
  PtySpawner,
} from './pty-contract.js';
import { resolveExecutable } from './executable-resolver.js';

/**
 * Real {@link PtySpawner} backed by the native `node-pty` module (ConPTY on
 * Windows). This is the only place the native dependency is touched, so the
 * terminal module's logic stays testable against the {@link PtyProcess} port.
 * Excluded from coverage like other IO/native adapters.
 */
export function createNodePtySpawner(): PtySpawner {
  return {
    spawn(request: PtySpawnRequest): PtyProcess {
      const file = resolveExecutable(request.command);
      const proc = pty.spawn(file, request.args, {
        name: 'xterm-color',
        cols: request.cols,
        rows: request.rows,
        cwd: request.cwd,
        env: request.env,
      });
      return {
        write: (data) => proc.write(data),
        resize: (cols, rows) => proc.resize(cols, rows),
        onData: (cb) => {
          proc.onData(cb);
        },
        onExit: (cb) => {
          proc.onExit(({ exitCode }) => cb(exitCode ?? null));
        },
        kill: () => proc.kill(),
      };
    },
  };
}

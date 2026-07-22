import { describe, it, expect } from 'vitest';
import {
  createProcessSpawner,
  type RawChildProcess,
  type RawStream,
} from './process-spawner.js';
import { createClock } from '../../kernel/clock.js';

class FakeStream implements RawStream {
  private handler?: (chunk: Buffer | string) => void;
  on(_event: 'data', cb: (chunk: Buffer | string) => void): void {
    this.handler = cb;
  }
  emit(chunk: string): void {
    this.handler?.(chunk);
  }
}

class FakeChild implements RawChildProcess {
  stdout: FakeStream | null;
  stderr: FakeStream | null;
  killed = false;
  private closeCb?: (code: number | null) => void;
  constructor(withStreams = true) {
    this.stdout = withStreams ? new FakeStream() : null;
    this.stderr = withStreams ? new FakeStream() : null;
  }
  on(_event: 'close', cb: (code: number | null) => void): void {
    this.closeCb = cb;
  }
  kill(): void {
    this.killed = true;
  }
  close(code: number | null): void {
    this.closeCb?.(code);
  }
}

const clock = createClock(() => 0);

describe('process-spawner', () => {
  it('pumps stdout/stderr lines, flushes trailing text, and resolves done', async () => {
    const child = new FakeChild();
    const spawner = createProcessSpawner(clock, () => child);
    const handle = spawner.spawn({ command: 'x', args: [], env: {} });

    const out: string[] = [];
    const out2: string[] = [];
    const err: string[] = [];
    const exits: (number | null)[] = [];
    handle.onStdoutLine((l) => out.push(l));
    handle.onStdoutLine((l) => out2.push(l));
    handle.onStderrLine((l) => err.push(l));
    handle.onExit((c) => exits.push(c));

    child.stdout!.emit('hello\nwor');
    child.stderr!.emit('boom\n');
    child.close(0);

    const code = await handle.done;
    expect(out).toEqual(['hello', 'wor']);
    expect(out2).toEqual(['hello', 'wor']);
    expect(err).toEqual(['boom']);
    expect(exits).toEqual([0]);
    expect(code).toBe(0);
    expect(handle.snapshot().phase).toBe('exited');
  });

  it('tolerates a child with no stdout/stderr streams', async () => {
    const child = new FakeChild(false);
    const spawner = createProcessSpawner(clock, () => child);
    const handle = spawner.spawn({ command: 'x', args: [], env: {} });
    child.close(0);
    await expect(handle.done).resolves.toBe(0);
  });

  it('kill delegates to the child process', () => {
    const child = new FakeChild();
    const spawner = createProcessSpawner(clock, () => child);
    const handle = spawner.spawn({ command: 'x', args: [], env: {} });
    handle.kill();
    expect(child.killed).toBe(true);
  });

  it('spawns a real process with the default spawn implementation', async () => {
    const spawner = createProcessSpawner(clock);
    const lines: string[] = [];
    const handle = spawner.spawn({
      command: process.execPath,
      args: ['-e', "process.stdout.write('l1\\nl2\\n')"],
      env: process.env as Record<string, string>,
    });
    handle.onStdoutLine((l) => lines.push(l));
    const code = await handle.done;
    expect(code).toBe(0);
    expect(lines).toEqual(['l1', 'l2']);
  });
});

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
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
  pid?: number;
  stdin?: RawChildProcess['stdin'];
  stdout: FakeStream | null;
  stderr: FakeStream | null;
  killed = false;
  private closeCb?: (code: number | null) => void;
  private errorCb?: (error: Error) => void;
  constructor(withStreams = true) {
    this.stdout = withStreams ? new FakeStream() : null;
    this.stderr = withStreams ? new FakeStream() : null;
  }
  on(event: 'close' | 'error', cb: (arg: never) => void): void {
    if (event === 'close') {
      this.closeCb = cb as (code: number | null) => void;
    } else {
      this.errorCb = cb as (error: Error) => void;
    }
  }
  kill(): void {
    this.killed = true;
  }
  close(code: number | null): void {
    this.closeCb?.(code);
  }
  error(err: Error): void {
    this.errorCb?.(err);
  }
}

const clock = createClock(() => 0);

describe('process-spawner', () => {
  it('delivers an exact multiline task above the Windows argv limit on stdin and closes the pipe', async () => {
    const input = ('a "quoted" path\\file\n\u00e9\u4e16\u754c\u{1f600}\n').repeat(4000);
    const lines: string[] = [];
    const handle = createProcessSpawner(clock).spawn({ command: process.execPath,
      args: ['-e', "const c=require('node:crypto').createHash('sha256');process.stdin.on('data',x=>c.update(x));process.stdin.on('end',()=>console.log(c.digest('hex')));"],
      env: process.env as Record<string, string>, input });
    handle.onStdoutLine((line) => lines.push(line));
    expect(await handle.done).toBe(0);
    expect(lines).toEqual([createHash('sha256').update(input).digest('hex')]);
  });
  it.each(['error', 'throw'] as const)('reports stdin %s and terminates only its owned child without leaking task text', async (failure) => {
    const child = new FakeChild();
    let onError: (() => void) | undefined;
    child.stdin = { on: (_event, callback) => { onError = () => callback(new Error('secret task')); },
      end: () => { if (failure === 'throw') throw new Error('secret task'); } };
    const handle = createProcessSpawner(clock, () => child).spawn({ command: 'x', args: [], env: {}, input: 'secret task' });
    const errors: string[] = [];
    handle.onStderrLine((line) => errors.push(line));
    if (failure === 'error') onError!();
    await Promise.resolve();
    expect(child.killed).toBe(true);
    expect(errors).toEqual(['Provider could not receive the task on standard input.']);
    child.close(1);
    expect(await handle.done).toBe(1);
  });
  it('fails delivery when a spawned process has no input pipe instead of leaving it waiting', async () => {
    const handle = createProcessSpawner(clock).spawn({ command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'], env: process.env as Record<string, string>, stdin: 'ignore', input: 'task' });
    const errors: string[] = [];
    handle.onStderrLine((line) => errors.push(line));
    expect(await handle.done).not.toBe(0);
    expect(errors).toContain('Provider could not receive the task on standard input.');
  });
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

  it('closes native stdin for prompt-only commands instead of waiting indefinitely for input', async () => {
    const spawner = createProcessSpawner(clock);
    const lines: string[] = [];
    const handle = spawner.spawn({
      command: process.execPath,
      args: ['-e', "process.stdin.on('end', () => process.stdout.write('eof\\n')); process.stdin.resume();"],
      env: process.env as Record<string, string>,
      stdin: 'ignore',
    });
    handle.onStdoutLine((line) => lines.push(line));
    expect(await handle.done).toBe(0);
    expect(lines).toEqual(['eof']);
  });

  it('settles done with a null exit code for a real missing executable instead of crashing the process', async () => {
    const spawner = createProcessSpawner(clock);
    const handle = spawner.spawn({
      command: 'this-cli-definitely-does-not-exist-anywhere',
      args: [],
      env: process.env as Record<string, string>,
    });
    await expect(handle.done).resolves.toBeNull();
  });

  it('settles done with a null exit code on a spawn error instead of crashing', async () => {
    const child = new FakeChild();
    const spawner = createProcessSpawner(clock, () => child);
    const handle = spawner.spawn({ command: 'missing-cli', args: [], env: {} });

    const exits: (number | null)[] = [];
    const diagnostics: string[] = [];
    handle.onExit((c) => exits.push(c));
    handle.onStderrLine((line) => diagnostics.push(line));

    child.error(Object.assign(new Error('spawn missing-cli ENOENT'), { code: 'ENOENT' }));

    const code = await handle.done;
    expect(code).toBeNull();
    expect(exits).toEqual([null]);
    expect(handle.snapshot().phase).toBe('exited');
    expect(diagnostics).toContain('Could not start provider process: spawn missing-cli ENOENT');
  });

  it('does not manufacture exit proof for an error after a process has started', async () => {
    const child = new FakeChild();
    child.pid = 12345;
    const handle = createProcessSpawner(clock, () => child).spawn({ command: 'x', args: [], env: {} });
    const errors: string[] = [];
    const exits: Array<number | null> = [];
    handle.onStderrLine((line) => errors.push(line));
    handle.onExit((code) => exits.push(code));
    child.error(new Error('native process error'));
    expect(exits).toEqual([]);
    expect(handle.snapshot().phase).toBe('running');
    expect(errors).toEqual(['Provider process reported an error; waiting for confirmed native exit.']);
    child.close(1);
    expect(await handle.done).toBe(1);
    expect(exits).toEqual([1]);
  });

  it('settles done with a null exit code when spawn throws synchronously instead of crashing', async () => {
    const einval = Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
    const spawner = createProcessSpawner(clock, () => { throw einval; });
    const handle = spawner.spawn({ command: 'copilot.cmd', args: ['--version'], env: {} });

    const exits: (number | null)[] = [];
    const diagnostics: string[] = [];
    handle.onExit((c) => exits.push(c));
    handle.onStderrLine((line) => diagnostics.push(line));
    // The synthetic child exposes a no-op kill and ignores non-error events.
    expect(() => handle.kill()).not.toThrow();

    const code = await handle.done;
    expect(code).toBeNull();
    expect(exits).toEqual([null]);
    expect(handle.snapshot().phase).toBe('exited');
    expect(diagnostics).toContain('Could not start provider process: spawn EINVAL');
  });

  it('ignores a close event that arrives after a spawn error already settled done', async () => {
    const child = new FakeChild();
    const spawner = createProcessSpawner(clock, () => child);
    const handle = spawner.spawn({ command: 'missing-cli', args: [], env: {} });

    const exits: (number | null)[] = [];
    handle.onExit((c) => exits.push(c));

    child.error(new Error('spawn missing-cli ENOENT'));
    child.close(1);

    const code = await handle.done;
    expect(code).toBeNull();
    expect(exits).toEqual([null]);
  });

  it('ignores a duplicate/late error event that arrives after close already settled done', async () => {
    const child = new FakeChild();
    const spawner = createProcessSpawner(clock, () => child);
    const handle = spawner.spawn({ command: 'x', args: [], env: {} });

    const exits: (number | null)[] = [];
    const diagnostics: string[] = [];
    handle.onExit((c) => exits.push(c));
    handle.onStderrLine((line) => diagnostics.push(line));

    child.close(0);
    child.error(new Error('late error after exit'));

    const code = await handle.done;
    expect(code).toBe(0);
    expect(exits).toEqual([0]);
    expect(diagnostics).toEqual([]);
  });
});

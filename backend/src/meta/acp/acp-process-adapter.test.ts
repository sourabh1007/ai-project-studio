import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  AcpProcessAdapter,
  type AcpChildProcess,
  type AcpReadableStream,
  type AcpWritableStream,
} from './acp-process-adapter.js';

const fixturePath = fileURLToPath(
  new URL('./acp-process-adapter-fixture.cjs', import.meta.url),
);
const noNewlineFixturePath = fileURLToPath(
  new URL('./acp-process-adapter-no-newline-fixture.cjs', import.meta.url),
);

class FakeReadable extends EventEmitter implements AcpReadableStream {
  encoding: BufferEncoding | null = null;

  setEncoding(encoding: BufferEncoding): void {
    this.encoding = encoding;
  }

  emitData(chunk: string): void {
    this.emit('data', chunk);
  }
}

class FakeWritable extends EventEmitter implements AcpWritableStream {
  readonly writes: string[] = [];
  failAsync: Error | null = null;

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(chunk);
    if (this.failAsync) {
      const error = this.failAsync;
      callback?.(error);
      this.emit('error', error);
    } else {
      callback?.(null);
    }
    return true;
  }
}

class FakeChild extends EventEmitter implements AcpChildProcess {
  pid?: number;
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly stdin = new FakeWritable();
  killed = 0;

  kill(): void {
    this.killed += 1;
  }

  close(code: number | null): void {
    this.emit('close', code);
  }
}

describe('AcpProcessAdapter', () => {
  it('drains noisy stderr from a real child without blocking stdout and redacts diagnostics', async () => {
    const adapter = new AcpProcessAdapter({
      executable: process.execPath,
      baseArgs: [],
      extraArgs: [fixturePath],
    });
    const lines: string[] = [];
    const done = new Promise<number | null>((resolve) => {
      adapter.onLine((line) => lines.push(line));
      adapter.onExit(resolve);
    });

    await expect(done).resolves.toBe(0);
    expect(lines).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"ok":true}}']);

    const diagnostic = adapter.diagnostic();
    expect(diagnostic).toContain('token=[REDACTED]');
    expect(diagnostic).toContain('Authorization=[REDACTED]');
    expect(diagnostic).toContain('[REDACTED]');
    expect(diagnostic).toContain('plain stderr line');
    expect(diagnostic).toContain('more line');
    expect(diagnostic).not.toContain('secret123');
    expect(diagnostic).not.toContain('super-secret-token');
    expect(diagnostic).not.toContain('github_pat_1234567890_secret_secret');
  });

  it('bounds a giant no-newline stderr line and still forwards protocol stdout', async () => {
    const adapter = new AcpProcessAdapter({
      executable: process.execPath,
      baseArgs: [],
      extraArgs: [noNewlineFixturePath],
    });
    const lines: string[] = [];
    const done = new Promise<number | null>((resolve) => {
      adapter.onLine((line) => lines.push(line));
      adapter.onExit(resolve);
    });

    await expect(done).resolves.toBe(0);
    expect(lines).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"ok":true}}']);

    const diagnostic = adapter.diagnostic();
    expect(diagnostic).toContain('stderr line(s) omitted');
    expect(diagnostic).not.toContain('split-secret');
    expect(diagnostic).not.toContain('Authorization');
  });

  it('handles async stdin EPIPE-like failures without crashing and waits for close to exit', async () => {
    const child = new FakeChild();
    child.pid = 42;
    const adapter = new AcpProcessAdapter({
      executable: 'copilot',
      spawnImpl: () => child,
    });
    let exited: number | null | undefined;
    adapter.onExit((code) => {
      exited = code;
    });

    child.stdin.failAsync = new Error('write EPIPE');
    adapter.write('{"jsonrpc":"2.0","id":1}\n');
    expect(child.killed).toBe(1);
    expect(exited).toBeUndefined();
    child.close(23);
    expect(exited).toBe(23);
    expect(adapter.diagnostic()).toContain('write EPIPE');
  });

  it('does not synthesize exit for a live-process error before close', () => {
    const child = new FakeChild();
    child.pid = 42;
    const adapter = new AcpProcessAdapter({
      executable: 'copilot',
      spawnImpl: () => child,
    });
    let exited: number | null | undefined;
    adapter.onExit((code) => {
      exited = code;
    });

    child.emit('error', new Error('kill EPERM'));
    expect(exited).toBeUndefined();
    expect(adapter.diagnostic()).toContain('kill EPERM');

    child.close(null);
    expect(exited).toBeNull();
  });

  it('treats a pre-start child error as startup failure and ignores later duplicate close', () => {
    const child = new FakeChild();
    const adapter = new AcpProcessAdapter({
      executable: 'copilot',
      spawnImpl: () => child,
    });
    const exits: Array<number | null> = [];
    adapter.onExit((code) => {
      exits.push(code);
    });

    child.emit('error', new Error('spawn EACCES'));
    child.close(1);

    expect(exits).toEqual([null]);
    expect(adapter.diagnostic()).toContain('spawn EACCES');
  });
});

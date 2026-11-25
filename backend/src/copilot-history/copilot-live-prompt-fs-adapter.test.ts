import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LivePromptTurn } from './copilot-history-contract.js';
import {
  createLivePromptFsReader,
  scanLiveLog,
  spawnLiveScanWorker,
  type LiveScanInput,
  type LiveScanSpawn,
} from './copilot-live-prompt-fs-adapter.js';

const event = (type: string, data: unknown, timestamp: string) => JSON.stringify({ type, data, timestamp });

let root: string;
const reader = (tailBytes = 1_000_000, maxScanBytes = 0) => ({
  latest: (session: string) =>
    scanLiveLog({ path: join(root, session, 'events.jsonl'), tailBytes, maxScanBytes }),
});
const writeLog = (session: string, body: string) => {
  mkdirSync(join(root, session), { recursive: true });
  writeFileSync(join(root, session, 'events.jsonl'), body);
};

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'cw live prompts é-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('scanLiveLog', () => {
  it('returns null for a missing log or a state path that is not a directory', async () => {
    expect(await reader().latest('absent')).toBeNull();
    writeFileSync(join(root, 'file-not-dir'), 'x');
    expect(await reader().latest('file-not-dir')).toBeNull();
  });

  it('returns null for an empty log', async () => {
    writeLog('empty', '');
    expect(await reader().latest('empty')).toBeNull();
  });

  it.each([['LF', '\n'], ['CRLF (Windows writers)', '\r\n']])('parses a %s log with unicode text', async (_name, eol) => {
    writeLog(`eol-${eol.length}`, [
      event('user.message', { content: 'Zażółć 你好', messageId: 'm1' }, '2024-01-01T00:00:00Z'),
      event('assistant.message', { originatingMessageId: 'm1', content: 'ok 🎉' }, '2024-01-01T00:00:01Z'),
    ].join(eol) + eol);
    expect(await reader().latest(`eol-${eol.length}`)).toMatchObject({ text: 'Zażółć 你好', response: 'ok 🎉' });
  });

  it('ignores a half-written trailing line from a live writer', async () => {
    writeLog('partial', event('user.message', { content: 'ask', messageId: 'm1' }, '2024-01-01T00:00:00Z') +
      '\n{"type":"assistant.message","data":{"originatingMessageId":"m1","content":"trunc');
    expect(await reader().latest('partial')).toMatchObject({ text: 'ask', response: null });
  });

  it('reads only the bounded tail and drops its leading partial line', async () => {
    const old = event('user.message', { content: 'old prompt', messageId: 'm0' }, '2024-01-01T00:00:00Z');
    const filler = event('tool.execution_complete', { output: 'x'.repeat(400) }, '2024-01-01T00:00:01Z');
    const latest = event('user.message', { content: 'new prompt', messageId: 'm1' }, '2024-01-01T00:00:02Z');
    writeLog('tail', [old, filler, latest].join('\n') + '\n');
    expect(await reader(latest.length + 10).latest('tail')).toMatchObject({ text: 'new prompt' });
    expect(await reader(20).latest('tail')).toBeNull();
  });

  it('scans past a newly queued prompt to recover the earlier prompt that is still answering', async () => {
    writeLog('queued-long', [
      event('user.message', { content: 'First request', messageId: 'a' }, '2024-01-01T00:00:00Z'),
      event('assistant.turn_start', { turnId: 'ta' }, '2024-01-01T00:00:01Z'),
      ...Array.from({ length: 20 }, () => event('tool.execution_complete', { output: 'x'.repeat(300) }, '2024-01-01T00:00:02Z')),
      event('user.message', { content: 'Queued request', messageId: 'b' }, '2024-01-01T00:00:03Z'),
      event('assistant.message', { originatingMessageId: 'a', content: 'First answer' }, '2024-01-01T00:00:04Z'),
    ].join('\n') + '\n');
    const snapshot = await reader(500, 20_000).latest('queued-long');
    expect(snapshot).toMatchObject({ text: 'Queued request', response: null, queued: true });
    expect(snapshot?.preceding).toMatchObject([{ text: 'First request', response: 'First answer' }]);
  });

  describe('latest user message beyond the first tail window', () => {
    const user = (content: string, id: string, at: string) => event('user.message', { content, messageId: id }, at);
    const reply = (id: string, content: string, at: string) => event('assistant.message', { originatingMessageId: id, content }, at);
    const filler = (n: number) => Array.from({ length: n }, (_, i) =>
      event('tool.execution_complete', { output: 'x'.repeat(300), i }, '2024-01-01T00:00:05Z'));

    it('recovers the latest prompt and its early reply after long tool output, within the cap', async () => {
      writeLog('long', [user('older', 'm0', '2024-01-01T00:00:00Z'), user('latest', 'm1', '2024-01-01T00:00:01Z'),
        reply('m1', 'early words', '2024-01-01T00:00:02Z'), ...filler(40)].join('\n') + '\n');
      expect(await reader(1000).latest('long')).toBeNull();
      expect(await reader(1000, 100_000).latest('long')).toMatchObject({ text: 'latest', response: 'early words' });
    });

    it('stays bounded: gives up when the message is beyond the scan cap', async () => {
      writeLog('capped', [user('latest', 'm1', '2024-01-01T00:00:01Z'), ...filler(40)].join('\n') + '\n');
      expect(await reader(1000, 3000).latest('capped')).toBeNull();
    });

    it('prefers a newer prompt over an older one found in an earlier window', async () => {
      writeLog('newer', [user('older', 'm0', '2024-01-01T00:00:00Z'), ...filler(10),
        user('newest', 'm1', '2024-01-01T00:00:09Z'), ...filler(10)].join('\n') + '\n');
      expect(await reader(1000, 100_000).latest('newer')).toMatchObject({ text: 'newest' });
    });

    it('is not confused across sessions or a rotated (shorter) log', async () => {
      writeLog('sess-a', [user('prompt a', 'a1', '2024-01-01T00:00:01Z'), ...filler(10)].join('\n') + '\n');
      writeLog('sess-b', [user('prompt b', 'b1', '2024-01-01T00:00:01Z')].join('\n') + '\n');
      const r = reader(1000, 100_000);
      expect(await r.latest('sess-a')).toMatchObject({ text: 'prompt a' });
      expect(await r.latest('sess-b')).toMatchObject({ text: 'prompt b' });
      writeLog('sess-a', user('after rotation', 'a2', '2024-01-02T00:00:00Z') + '\n');
      expect(await r.latest('sess-a')).toMatchObject({ text: 'after rotation' });
    });

    it('handles multibyte text split across chunk boundaries and CRLF', async () => {
      writeLog('mb', [user('日本語 🎉 prompt', 'm1', '2024-01-01T00:00:01Z'), ...filler(10)].join('\r\n') + '\r\n');
      expect(await reader(777, 100_000).latest('mb')).toMatchObject({ text: '日本語 🎉 prompt' });
    });
  });

  it('rejects rather than reporting nothing when the log exists but cannot be read', async () => {
    // A directory in place of the log: POSIX opens it and fails the read
    // (EISDIR); Windows opens it as a zero-length handle, which is "no turn".
    mkdirSync(join(root, 'unreadable', 'events.jsonl'), { recursive: true });
    const result = reader().latest('unreadable');
    if (process.platform === 'win32') {
      expect(await result).toBeNull();
    } else {
      await expect(result).rejects.toMatchObject({ code: 'EISDIR' });
    }
  });
});

describe('createLivePromptFsReader (worker pool wiring)', () => {
  const workerConfig = { maxWorkers: 1, maxQueued: 1, timeoutMs: 5000, workerMemoryMb: 64 };
  const make = (spawn: LiveScanSpawn, worker = workerConfig) => createLivePromptFsReader({
    sessionStateDir: join('state', 'dir with space'), eventsFile: 'events.jsonl',
    tailBytes: 100, maxScanBytes: 1000, worker,
  }, spawn);
  const turn: LivePromptTurn = { text: 'hi', at: '', response: null };

  it('runs each scan off-thread with the session log path and configured bounds', async () => {
    const inputs: LiveScanInput[] = [];
    const reader = make((input) => { inputs.push(input); return { result: Promise.resolve(turn), terminate: async () => undefined }; });
    expect(await reader.latest('abc')).toEqual(turn);
    expect(inputs).toEqual([{ path: join('state', 'dir with space', 'abc', 'events.jsonl'), tailBytes: 100, maxScanBytes: 1000 }]);
    expect(reader.stats()).toMatchObject({ active: 0, queued: 0, maxWorkers: 1, maxQueued: 1 });
  });

  it('terminates the worker when the caller aborts, and does not overlap the next scan with it', async () => {
    let terminated = 0;
    let running = 0;
    let maxRunning = 0;
    const reader = make(() => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      return {
        result: new Promise<never>(() => undefined),
        terminate: async () => { terminated += 1; running -= 1; },
      };
    });
    const controller = new AbortController();
    const first = reader.latest('a', controller.signal);
    const second = reader.latest('b');
    const secondOutcome = second.catch((error: Error) => error.message);
    controller.abort();
    await expect(first).rejects.toThrow('cancelled');
    await reader.close();
    expect(await secondOutcome).toContain('cancelled');
    expect(terminated).toBe(2);
    expect(maxRunning).toBe(1);
  });

  it('stops a scan that exceeds the runner timeout and terminates its worker', async () => {
    let terminated = false;
    const reader = make(() => ({
      result: new Promise<never>(() => undefined),
      terminate: async () => { terminated = true; },
    }), { ...workerConfig, timeoutMs: 20 });
    await expect(reader.latest('slow')).rejects.toThrow('exceeded 20ms');
    expect(terminated).toBe(true);
    expect(reader.stats().active).toBe(0);
  });

  it('bounds the queue, rejecting excess concurrent polls instead of growing', async () => {
    const reader = make(() => ({ result: new Promise<never>(() => undefined), terminate: async () => undefined }));
    const pending = [reader.latest('a'), reader.latest('b')].map((p) => p.catch((e: Error) => e.message));
    await expect(reader.latest('c')).rejects.toThrow('queue is full');
    expect(reader.stats()).toMatchObject({ active: 1, queued: 1 });
    await reader.close();
    expect((await Promise.all(pending)).every((m) => String(m).includes('shutdown'))).toBe(true);
  });

  it('refuses new scans after close', async () => {
    const reader = make(() => ({ result: Promise.resolve(turn), terminate: async () => undefined }));
    await reader.close();
    await expect(reader.latest('a')).rejects.toThrow('stopped');
  });

  it('forwards bounded shutdown and refuses later scans', async () => {
    const reader = make(() => ({ result: Promise.resolve(turn), terminate: async () => undefined }));
    expect(await reader.latest('a')).toEqual(turn);
    expect(await reader.closeWithin(1000)).toBe(true);
    await expect(reader.latest('a')).rejects.toThrow('stopped');
  });
});

describe('spawnLiveScanWorker (native worker threads)', () => {
  const fixture = new URL('./copilot-live-prompt-worker-fixture.mjs', import.meta.url);
  const spawn = (mode: string) => spawnLiveScanWorker({ path: mode, tailBytes: 1, maxScanBytes: 1 }, 64, fixture);

  it('delivers the worker result and a null result', async () => {
    const ok = spawn('ok');
    expect(await ok.result).toEqual({ text: 'hi', at: '', response: null });
    await ok.terminate();
    const none = spawn('null');
    expect(await none.result).toBeNull();
    await none.terminate();
  });

  it('rejects with the worker-reported code, uncaught errors and unexpected exits', async () => {
    const failed = spawn('fail');
    await expect(failed.result).rejects.toMatchObject({ message: 'resource busy', code: 'EBUSY' });
    await failed.terminate();
    const thrown = spawn('throw');
    await expect(thrown.result).rejects.toThrow('boom');
    await thrown.terminate();
    const exited = spawn('exit');
    await expect(exited.result).rejects.toThrow('exited before completion (code 3)');
    await exited.terminate();
  });

  it('keeps the event loop responsive while a worker hangs, and terminate really stops it', async () => {
    const hung = spawn('hang');
    hung.result.catch(() => undefined);
    const lags: number[] = [];
    let last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); lags.push(now - last); last = now; }, 10);
    await new Promise((resolve) => setTimeout(resolve, 200));
    clearInterval(timer);
    expect(lags.length).toBeGreaterThan(5);
    expect(Math.max(...lags)).toBeLessThan(150);
    await hung.terminate();
    await expect(hung.result).rejects.toThrow('exited before completion');
  });

  it('works through the pool: timeout terminates a hung native worker and the pool recovers', async () => {
    const reader = createLivePromptFsReader({
      sessionStateDir: 'ok', eventsFile: 'x', tailBytes: 1, maxScanBytes: 1,
      worker: { maxWorkers: 1, maxQueued: 0, timeoutMs: 300, workerMemoryMb: 64 },
    }, (input) => spawnLiveScanWorker({ ...input, path: input.path.includes('hang') ? 'hang' : 'ok' }, 64, fixture));
    await expect(reader.latest('hang')).rejects.toThrow('exceeded 300ms');
    expect(reader.stats().active).toBe(0);
    expect(await reader.latest('fine')).toMatchObject({ text: 'hi' });
    await reader.close();
  });
});

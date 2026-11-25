import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { claudeDefaults } from './config.js';
import { createClaudeHistoryCache, type ClaudeHistorySnapshot } from './claude-history-cache.js';
import { buildClaudeInstallCommand, claudeInstallationPlan } from './claude-commands.js';
import {
  buildClaudeHistorySnapshot, claudeHistoryFs, createClaudeNativeHistoryStore,
  readClaudeHistoryFiles, runClaudeHistoryWorker, spawnClaudeHistoryWorker,
  type ClaudeHistoryFs, type ClaudeHistoryWorkInput,
} from './claude-native-history.js';

const id = '550e8400-e29b-41d4-a716-446655440000';
const fixture = resolve(`.claude-history-fixture-${randomUUID()}`);
const message = JSON.stringify({
  type: 'user', sessionId: id, uuid: 'u1', message: { content: 'synthetic fixture' },
});
const assistant = JSON.stringify({
  type: 'assistant', sessionId: id, uuid: 'a1',
  message: { id: 'm1', content: 'synthetic response', usage: { input_tokens: 1, output_tokens: 2 } },
});
const input: ClaudeHistoryWorkInput = { config: claudeDefaults, directory: fixture };
const empty: ClaudeHistorySnapshot = { sessions: [], usage: [] };
const signal = () => new AbortController().signal;

it('provides bounded Claude prompt evidence from the already-worker-populated cache', () => {
  const cache = createClaudeHistoryCache(claudeDefaults);
  expect(cache.recentPrompts('missing', 4)).toEqual([]);
  for (const limit of [0, 101, 1.5]) expect(() => cache.recentPrompts(id, limit)).toThrow('limit');
  const record = {
    nativeSessionId: id, nativeMessageId: 'message', role: 'user' as const, text: 'Request', timestamp: '2026-04-04T10:00:00Z',
    cwd: '', model: null,
  };
  cache.replace({ usage: null, sessions: [[id, [
    { ...record, role: 'assistant', text: 'Orphan' },
    record,
    { ...record, role: 'assistant', text: 'First response' },
    { ...record, role: 'assistant', text: 'More response' },
    { ...record, text: 'New request' },
  ]]] });
  expect(cache.recentPrompts(id, 1)).toEqual([expect.objectContaining({ text: 'New request', response: null })]);
  expect(cache.recentPrompts(id, 4)[0]).toMatchObject({ status: 'answered', response: 'First responseMore response' });
});

beforeAll(async () => {
  await mkdir(join(fixture, 'discovered-project', 'subagents'), { recursive: true });
  await writeFile(join(fixture, 'discovered-project', `${id}.jsonl`), `${message}\n${assistant}`);
  await writeFile(join(fixture, 'not-a-project.txt'), 'ignored');
  await writeFile(join(fixture, 'discovered-project', 'not-a-transcript.txt'), 'ignored');
  await writeFile(join(fixture, 'empty.txt'), '');
  await writeFile(join(fixture, 'long.txt'), 'abcd');
});
afterAll(async () => { await rm(fixture, { recursive: true, force: true }); });

function fileFs(options: {
  projects?: { name: string; directory: boolean; file: boolean }[];
  files?: { name: string; directory: boolean; file: boolean }[];
  text?: string;
  failure?: unknown;
} = {}): ClaudeHistoryFs {
  return {
    async *entries(path) {
      if ('failure' in options) throw options.failure;
      const entries = path === fixture
        ? options.projects ?? [{ name: 'project', directory: true, file: false }]
        : options.files ?? [{ name: 'session.jsonl', directory: false, file: true }];
      for (const entry of entries) yield entry;
    },
    read: async () => options.text ?? message,
  };
}

class FakeWorker extends EventEmitter {
  terminate = vi.fn(async () => 0);
}

describe('Claude bounded native filesystem discovery', () => {
  it('streams real directory entries and bounded bytes without reading unrelated files', async () => {
    const files = await readClaudeHistoryFiles(input, claudeHistoryFs);
    expect(files).toEqual([{ path: join(fixture, 'discovered-project', `${id}.jsonl`), jsonl: `${message}\n${assistant}` }]);
    expect(await claudeHistoryFs.read(join(fixture, 'empty.txt'), 0)).toBe('');
    expect(await claudeHistoryFs.read(join(fixture, 'long.txt'), 4)).toBe('abcd');
    await expect(claudeHistoryFs.read(join(fixture, 'long.txt'), 2)).rejects.toThrow('byte limit');
    await expect(claudeHistoryFs.read(join(fixture, 'missing'), 2)).rejects.toThrow();
    const snapshot = await buildClaudeHistorySnapshot(input, claudeHistoryFs);
    expect(snapshot.sessions[0][0]).toBe(id);
    expect(snapshot.usage?.[0][1][0]).toMatchObject({ nativeMessageId: 'm1', inputTokens: 1 });
    await expect(readClaudeHistoryFiles({ ...input, directory: join(fixture, 'missing') }, claudeHistoryFs)).resolves.toEqual([]);
  });
  it('enforces traversal, session and total-byte limits even against a misbehaving injected reader', async () => {
    await expect(readClaudeHistoryFiles({ ...input, config: { ...claudeDefaults, historyMaxEntries: 1 } }, fileFs())).rejects.toThrow('traversal limit');
    await expect(readClaudeHistoryFiles({ ...input, config: { ...claudeDefaults, historyMaxSessions: 1 } },
      fileFs({ files: [
        { name: 'a.jsonl', directory: false, file: true },
        { name: 'b.jsonl', directory: false, file: true },
      ] }))).rejects.toThrow('session limit');
    await expect(readClaudeHistoryFiles({ ...input, config: { ...claudeDefaults, historyMaxBytes: 1 } }, fileFs())).rejects.toThrow('byte limit');
    expect(await readClaudeHistoryFiles(input, fileFs({ projects: [{ name: 'file', directory: false, file: true }] }))).toEqual([]);
    expect(await readClaudeHistoryFiles(input, fileFs({ files: [
      { name: 'dir', directory: true, file: false },
      { name: 'notes.txt', directory: false, file: true },
    ] }))).toEqual([]);
  });
  it('only treats a missing root as empty, never a disappearing project or permission error', async () => {
    await expect(readClaudeHistoryFiles(input, fileFs({ failure: { code: 'ENOENT' } }))).resolves.toEqual([]);
    await expect(readClaudeHistoryFiles(input, fileFs({ failure: null }))).rejects.toBeNull();
    await expect(readClaudeHistoryFiles(input, fileFs({ failure: { code: 'EACCES' } }))).rejects.toEqual({ code: 'EACCES' });
    const disappearing: ClaudeHistoryFs = {
      async *entries(path) {
        if (path !== fixture) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        yield { name: 'project', directory: true, file: false };
      },
      read: async () => '',
    };
    await expect(readClaudeHistoryFiles(input, disappearing)).rejects.toThrow('gone');
  });
});

describe('Claude native worker protocol', () => {
  it('validates worker snapshots and forwards lifecycle completion and termination', async () => {
    const fake = new FakeWorker();
    const worker = spawnClaudeHistoryWorker(input, () => fake);
    fake.emit('message', { type: 'progress' });
    fake.emit('message', null);
    fake.emit('message', { type: 'result', snapshot: empty });
    fake.emit('exit', 0);
    expect(await worker.result).toEqual(empty);
    await worker.terminate();
    expect(fake.terminate).toHaveBeenCalledOnce();
  });
  it('fails closed on malformed results, worker failures, errors and early exit', async () => {
    for (const value of [
      { type: 'result' }, { type: 'result', snapshot: { sessions: [], usage: null } },
      { type: 'result', snapshot: { sessions: null, usage: [] } },
      { type: 'result', snapshot: { sessions: [], usage: {} } },
      { type: 'result', snapshot: { sessions: [['invalid']], usage: [] } },
      { type: 'failure' },
    ]) {
      const fake = new FakeWorker();
      const worker = spawnClaudeHistoryWorker(input, () => fake);
      fake.emit('message', value);
      await expect(worker.result).rejects.toThrow();
      await worker.terminate();
    }
    for (const event of ['error', 'exit']) {
      const fake = new FakeWorker();
      const worker = spawnClaudeHistoryWorker(input, () => fake);
      fake.emit(event, event === 'error' ? new Error('native failure') : 4);
      await expect(worker.result).rejects.toThrow(event === 'error' ? 'native failure' : 'before completion');
      await worker.terminate();
    }
  });
  it('handles native entrypoint success, input validation and IO failure without exposing details', async () => {
    const port = { postMessage: vi.fn(), close: vi.fn() };
    await runClaudeHistoryWorker(null, { kind: 'claude-native-history' }, fileFs());
    await runClaudeHistoryWorker(port, null, fileFs());
    await runClaudeHistoryWorker(port, {}, fileFs());
    await runClaudeHistoryWorker(port, { kind: 'other' }, fileFs());
    expect(port.close).not.toHaveBeenCalled();
    await runClaudeHistoryWorker(port, { kind: 'claude-native-history', input }, fileFs());
    expect(port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'result' }));
    for (const data of [
      { kind: 'claude-native-history' },
      { kind: 'claude-native-history', input: { directory: 1 } },
      { kind: 'claude-native-history', input: { directory: fixture, config: {} } },
    ]) {
      await runClaudeHistoryWorker(port, data, fileFs());
      expect(port.postMessage).toHaveBeenLastCalledWith({ type: 'failure' });
    }
    await runClaudeHistoryWorker(port, { kind: 'claude-native-history', input }, fileFs({ failure: new Error('private path') }));
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: 'failure' });
    expect(port.close).toHaveBeenCalledTimes(5);
  });
  it('creates and terminates a native worker without launching the Claude CLI', async () => {
    const worker = spawnClaudeHistoryWorker(input);
    const rejected = expect(worker.result).rejects.toBeInstanceOf(Error);
    await worker.terminate();
    await rejected;
  });
});

describe('Claude native store and cache hydration', () => {
  it('round-trips cache snapshots, including unavailable usage, without IO', async () => {
    const source = createClaudeHistoryCache(claudeDefaults, { read: async () => [{ path: 'a', jsonl: `${message}\n${assistant}` }] });
    const target = createClaudeHistoryCache(claudeDefaults);
    expect(target.snapshot()).toEqual({ sessions: [], usage: null });
    target.replace({ sessions: [], usage: null });
    expect(target.readUsagePage(id, null, 1)).toBeNull();
    await expect(target.refresh(signal())).rejects.toThrow('must be refreshed in a worker');
    await source.refresh(signal());
    target.replace(source.snapshot());
    expect(target.snapshot()).toEqual(source.snapshot());
    expect(target.read([id])).toEqual(source.read([id]));
    expect(target.prompts(id)).toEqual(source.prompts(id));
    expect(target.listImportable()).toEqual(source.listImportable());
    expect(target.readUsagePage(id, null, 10)).toEqual(source.readUsagePage(id, null, 10));
  });
  it('publishes only completed worker snapshots, respects configured/native directories and closes', async () => {
    for (const test of [
      { config: { ...claudeDefaults, historyDirectory: 'configured' }, deps: { baseEnv: { CLAUDE_CONFIG_DIR: 'env' } }, expected: 'configured' },
      { config: claudeDefaults, deps: { baseEnv: { CLAUDE_CONFIG_DIR: 'env' } }, expected: join('env', 'projects') },
      { config: claudeDefaults, deps: { baseEnv: {}, home: 'home' }, expected: join('home', '.claude', 'projects') },
      { config: claudeDefaults, deps: {}, expected: join(homedir(), '.claude', 'projects') },
    ]) {
      const spawnWorker = vi.fn(() => ({ result: Promise.resolve(empty), terminate: vi.fn(async () => {}) }));
      const store = createClaudeNativeHistoryStore(test.config, { ...test.deps, spawnWorker });
      expect(store.readUsagePage(id, null, 10)).toBeNull();
      await store.refresh(signal());
      expect(spawnWorker).toHaveBeenCalledWith({ config: test.config, directory: test.expected });
      expect(store.readUsagePage(id, null, 10)).toEqual({ samples: [], nextCursor: null, highWaterCursor: null });
      await store.close();
      await expect(store.refresh(signal())).rejects.toThrow('stopped');
    }
    const native = createClaudeNativeHistoryStore({ ...claudeDefaults, historyDirectory: fixture });
    const abort = new AbortController();
    const rejected = expect(native.refresh(abort.signal)).rejects.toThrow('cancelled');
    abort.abort();
    await rejected;
    await native.close();
    const defaultStore = createClaudeNativeHistoryStore(claudeDefaults);
    await defaultStore.close();
  });
  it('bounds concurrency, cancels active/aborted work, times out and retains the published cache on failure', async () => {
    let resolveWork: (snapshot: ClaudeHistorySnapshot) => void = () => {};
    const terminate = vi.fn(async () => {});
    const spawnWorker = vi.fn(() => ({
      result: new Promise<ClaudeHistorySnapshot>((resolve) => { resolveWork = resolve; }),
      terminate,
    }));
    const store = createClaudeNativeHistoryStore({ ...claudeDefaults, historyTimeoutMs: 1000 }, { spawnWorker });
    const abort = new AbortController();
    const refresh = store.refresh(abort.signal);
    await expect(store.refresh(signal())).rejects.toThrow('queue is full');
    abort.abort();
    await expect(refresh).rejects.toThrow('cancelled');
    expect(terminate).toHaveBeenCalledOnce();
    expect(store.readUsagePage(id, null, 1)).toBeNull();
    await expect(store.refresh(AbortSignal.abort())).rejects.toThrow('cancelled');
    const successful = store.refresh(signal());
    resolveWork(empty);
    await successful;
    expect(store.readUsagePage(id, null, 1)).toEqual({ samples: [], nextCursor: null, highWaterCursor: null });
    const stopped = store.refresh(signal());
    const rejection = expect(stopped).rejects.toThrow('shutdown');
    await store.close();
    await rejection;
    expect(store.readUsagePage(id, null, 1)).toEqual({ samples: [], nextCursor: null, highWaterCursor: null });
    const timed = createClaudeNativeHistoryStore({ ...claudeDefaults, historyTimeoutMs: 1 }, { spawnWorker });
    await expect(timed.refresh(signal())).rejects.toThrow('exceeded');
    await timed.close();
    const failed = createClaudeNativeHistoryStore(claudeDefaults, {
      spawnWorker: () => ({ result: Promise.reject(new Error('failure')), terminate: async () => {} }),
    });
    await expect(failed.refresh(signal())).rejects.toThrow('failure');
    expect(failed.listImportable()).toEqual([]);
    await failed.close();
  });
});

describe('Claude installation requires explicit consent, not a legal prohibition', () => {
  it('builds official configurable installation commands without executing them', () => {
    expect(claudeInstallationPlan(claudeDefaults, 'win32')).toMatchObject({ requiresConsent: true, automaticInstall: false });
    expect(buildClaudeInstallCommand(claudeDefaults, 'win32')).toEqual({
      command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'winget install --id Anthropic.ClaudeCode --exact --silent --disable-interactivity --accept-package-agreements --accept-source-agreements'],
    });
    expect(buildClaudeInstallCommand(claudeDefaults, 'linux')).toEqual({
      command: 'bash', args: ['-lc', claudeDefaults.installPosixCommand],
    });
    expect(buildClaudeInstallCommand({ ...claudeDefaults, installPosixCommand: 'custom-approved-command' }, 'darwin')?.args).toContain('custom-approved-command');
    expect(buildClaudeInstallCommand(claudeDefaults, 'unsupported')).toBeNull();
  });
});

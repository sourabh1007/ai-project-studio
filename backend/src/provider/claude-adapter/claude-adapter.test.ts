import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionSpec } from '../provider-contract.js';
import type { ProcessHandle, SpawnRequest } from '../process-kernel/process-spawner.js';
import { claudeConfigSchema, claudeDefaults } from './config.js';
import { buildClaudeArgs, buildClaudeEnv, claudeInstallationPlan } from './claude-commands.js';
import { assertClaudeHeadlessAuth, claudeProbeCommands, claudeVersionCapabilities, createClaudeProvider, parseClaudeAuthStatus } from './claude-provider.js';
import { claudeRecord, claudeResultText, parseClaudeHistory, parseClaudeLine, parseClaudeUsage } from './claude-protocol.js';
import { createClaudeHistoryCache } from './claude-history-cache.js';
import { ProviderError, ValidationError } from '../../kernel/error-types.js';

const id = '550e8400-e29b-41d4-a716-446655440000';
const spec: SessionSpec = {
  sessionId: id, featureId: 'feature', prompt: 'hello', model: 'auto',
  kind: 'dev', otelFilePath: 'usage.jsonl', cwd: 'C:\\repo',
};
const line = (value: unknown) => JSON.stringify(value);
const user = (overrides: Record<string, unknown> = {}) => ({
  type: 'user', sessionId: id, uuid: 'user1', timestamp: '2026-01-01T00:00:00Z',
  cwd: 'C:\\repo', message: { content: 'question' }, ...overrides,
});
const assistant = (overrides: Record<string, unknown> = {}) => ({
  type: 'assistant', sessionId: id, session_id: id, uuid: 'assistant1',
  timestamp: '2026-01-01T00:00:01Z', cwd: 'C:\\repo',
  message: { id: 'msg1', model: 'sonnet', content: [{ type: 'text', text: 'answer' }],
    usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 5 } },
  ...overrides,
});

describe('Claude configuration and native commands', () => {
  it('validates defaults and exposes configurable, nonexecuting platform metadata', () => {
    expect(claudeConfigSchema.parse(claudeDefaults)).toEqual(claudeDefaults);
    expect(claudeDefaults.enabled).toBe(true);
    expect(claudeDefaults.probeTimeoutMs).toBe(15_000);
    expect(claudeDefaults.installTimeoutMs).toBe(180_000);
    expect(claudeConfigSchema.safeParse({ ...claudeDefaults, probeTimeoutMs: 0 }).success).toBe(false);
    expect(claudeConfigSchema.safeParse({ ...claudeDefaults, installTimeoutMs: 1.5 }).success).toBe(false);
    expect(claudeInstallationPlan(claudeDefaults, 'win32').installCommand).toContain('winget');
    expect(claudeInstallationPlan(claudeDefaults, 'darwin').installCommand).toContain('install.sh');
    expect(claudeInstallationPlan(claudeDefaults, 'linux').supported).toBe(true);
    expect(claudeInstallationPlan(claudeDefaults, 'freebsd')).toMatchObject({ supported: false, installCommand: null });
    expect(claudeProbeCommands(claudeDefaults)).toEqual({
      version: { command: 'claude', args: ['--version'] },
      authStatus: { command: 'claude', args: ['auth', 'status'] },
      authLogin: { command: 'claude', args: ['auth', 'login'] },
      usage: { command: '/usage', availability: 'unavailable' },
    });
  });
  it('builds native stream-json and interactive commands without skipping permissions', () => {
    expect(buildClaudeArgs(spec, claudeDefaults, false)).toEqual([
      '--session-id', id, '-p', '--output-format', 'stream-json', '--verbose', '--', 'hello',
    ]);
    expect(buildClaudeArgs(spec, claudeDefaults, true)).toEqual(['--session-id', id]);
    expect(buildClaudeArgs({ ...spec, resume: true, instructions: 'shared bootstrap' }, claudeDefaults, true)).toEqual([
      '--resume', id, '--append-system-prompt', 'shared bootstrap',
    ]);
    expect(buildClaudeArgs({ ...spec, instructions: '' }, claudeDefaults, true)).toEqual(['--session-id', id]);
    expect(buildClaudeArgs({ ...spec, instructions: 'already in prompt' }, claudeDefaults, false)).not.toContain('--append-system-prompt');
    expect(buildClaudeArgs({ ...spec, model: 'opus', noTools: true, kind: 'meta' },
      { ...claudeDefaults, extraArgs: ['--debug'], headlessArgs: ['--max-turns', '2'] }, false,
      { resumeSessionId: id })).toEqual(expect.arrayContaining([
        '--debug', '--max-turns', '2', '--model', 'opus', '--resume', id,
        '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config',
      ]));
    expect(buildClaudeArgs(spec, { ...claudeDefaults, defaultModel: 'sonnet' }, true)).toContain('sonnet');
    expect(buildClaudeArgs(spec, { ...claudeDefaults, defaultModel: 'auto' }, true)).not.toContain('--model');
    expect(buildClaudeArgs({ ...spec, attachments: ['C:\\a b.txt'] }, claudeDefaults, false).at(-1)).toContain('"C:\\\\a b.txt"');
    expect(buildClaudeArgs({ ...spec, model: 'default' }, { ...claudeDefaults, interactiveArgs: ['--debug'] }, true)).toContain('--debug');
    expect(() => buildClaudeArgs({ ...spec, sessionId: 'invalid' }, claudeDefaults, true)).toThrow('UUID');
    expect(() => buildClaudeArgs({ ...spec, sessionId: 'invalid' }, claudeDefaults, true)).toThrow(ValidationError);
    expect(() => buildClaudeArgs({ ...spec, instructions: 'x'.repeat(16_000) }, claudeDefaults, true)).toThrow('safe command-line length');
    expect(() => buildClaudeArgs({ ...spec, prompt: 'bad\0prompt' }, claudeDefaults, false)).toThrow('NUL');
    expect(() => buildClaudeArgs(spec, { ...claudeDefaults, maxCommandLineLength: 256, extraArgs: ['x'.repeat(256)] }, false)).toThrow('safe command-line length');
    expect(buildClaudeEnv({ PATH: 'bin', EMPTY: '', MISSING: undefined })).toEqual({ PATH: 'bin', EMPTY: '' });
  });
});

describe('Claude authentication and version capabilities', () => {
  it('does not treat subscription OAuth as application API auth', () => {
    for (const env of [{}, { CLAUDE_CODE_OAUTH_TOKEN: 'secret' }, { CLAUDE_CODE_USE_VERTEX: '0' }]) {
      expect(() => assertClaudeHeadlessAuth(env, null)).toThrow('Unsupported');
    }
    expect(() => assertClaudeHeadlessAuth({}, 'claude.ai')).toThrow('Unsupported');
    expect(() => assertClaudeHeadlessAuth({}, 'claude.ai')).toThrow(ProviderError);
    for (const env of [{ ANTHROPIC_API_KEY: 'key' }, { ANTHROPIC_AUTH_TOKEN: 'gateway' },
      { CLAUDE_CODE_USE_VERTEX: '1' }, { CLAUDE_CODE_USE_BEDROCK: '1' }, { CLAUDE_CODE_USE_FOUNDRY: '1' }]) {
      expect(() => assertClaudeHeadlessAuth(env, null)).not.toThrow();
    }
    for (const method of ['api_key', 'api_key_helper', 'third_party']) {
      expect(() => assertClaudeHeadlessAuth({}, method)).not.toThrow();
    }
  });
  it('fails closed on unsupported or unknown versions and missing auth state', () => {
    expect(claudeVersionCapabilities('2.1.30 (Claude Code)\n')).toMatchObject({ version: '2.1.30', status: 'supported', quota: 'unavailable' });
    expect(claudeVersionCapabilities('2.0.0').streamJson).toBe(true);
    expect(claudeVersionCapabilities('1.0.1').status).toBe('unsupported');
    expect(claudeVersionCapabilities('3.0.0').nativeInteractive).toBe(false);
    expect(claudeVersionCapabilities('garbage').status).toBe('unknown');
    for (const value of ['broken', '{}', '{"loggedIn":true}', '{"loggedIn":"yes","authMethod":"api_key"}']) {
      expect(parseClaudeAuthStatus(value)).toEqual({ authenticated: false, method: null, headlessSupported: false });
    }
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"api_key"}').headlessSupported).toBe(true);
    expect(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"api_key"}').headlessSupported).toBe(false);
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}').headlessSupported).toBe(false);
  });
});

describe('Claude native protocol', () => {
  it('safely validates JSON and extracts only successful final plaintext', () => {
    for (const value of [null, [], 1, 's']) expect(claudeRecord(value)).toBeNull();
    expect(claudeRecord({ a: 1 })).toEqual({ a: 1 });
    expect(parseClaudeLine('bad')).toBeNull();
    expect(claudeResultText('bad')).toBeNull();
    expect(claudeResultText('{"type":"assistant"}')).toBeNull();
    expect(claudeResultText('{"type":"result","is_error":true,"result":"failed"}')).toBeNull();
    expect(claudeResultText('{"type":"result","result":2}')).toBeNull();
    expect(claudeResultText('{"type":"result","result":"answer"}')).toBe('answer');
  });
  it('preserves native message tokens and separates cumulative USD estimates', () => {
    const parsed = parseClaudeUsage(line(assistant()));
    expect(parsed).toMatchObject({
      sourceId: `claude:${id}:message:msg1`, nativeSessionId: id,
      nativeMessageId: 'msg1', scope: 'message', inputTokens: 2, outputTokens: 3,
      cacheReadTokens: 4, cacheWriteTokens: 5, model: 'sonnet', charge: { status: 'unavailable' },
    });
    const result = { type: 'result', session_id: id, uuid: 'result1', usage: {}, total_cost_usd: 0.04 };
    expect(parseClaudeUsage(line(result))).toMatchObject({
      scope: 'session', model: null, inputTokens: null,
      charge: { status: 'estimated', unit: 'USD', amount: 0.04, scope: 'session' },
    });
    expect(parseClaudeUsage(line({ ...result, total_cost_usd: -1 }))).toMatchObject({ charge: { status: 'unavailable' } });
    expect(parseClaudeUsage(line({ ...result, total_cost_usd: 0 }))).toMatchObject({ charge: { amount: 0 } });
    expect(parseClaudeUsage(line(assistant({ session_id: undefined })))).not.toBeNull();
    expect(parseClaudeUsage(line(assistant({ message: { id: 'msg', usage: { input_tokens: -1, output_tokens: '3' } }, model: 'fallback' })))).toMatchObject({ model: 'fallback', inputTokens: null, outputTokens: null });
    for (const value of ['bad', '{}', line({ type: 'user' }), line(assistant({ sessionId: undefined, session_id: undefined })),
      line(assistant({ message: null })), line(assistant({ message: { id: '', usage: {} } })),
      line(assistant({ message: { id: 'msg' } })), line({ ...result, uuid: undefined })]) {
      expect(parseClaudeUsage(value)).toBeNull();
    }
  });
  it('parses bounded native history, deduplicates replay, excludes tools and injected prompts', () => {
    const input = [user(), assistant(), user(), null, { type: 'system' }, user({ isMeta: true }),
      user({ uuid: '', message: {} }), user({ uuid: 'empty', message: { content: [] } }),
      user({ uuid: 'not-text', message: { content: [null, { type: 'tool_result', content: 'secret' }, { type: 'text', text: 4 }] } }),
      user({ uuid: 'no-content', message: {} }), user({ uuid: 'number-content', message: { content: 2 } }),
      user({ uuid: 'no-message', message: null }), user({ uuid: 'no-session', sessionId: undefined }),
      user({ uuid: undefined, sessionId: undefined, session_id: id, timestamp: undefined, cwd: undefined,
        message: { id: 'fallback', content: 'last' } }),
    ].map(line).join('\r\n');
    const records = parseClaudeHistory(`${input}\ninvalid`);
    expect(records).toHaveLength(3);
    expect(records[1]).toMatchObject({ role: 'assistant', text: 'answer', model: 'sonnet' });
    expect(records[2]).toMatchObject({ text: 'last', timestamp: '', cwd: null, model: null });
    expect(() => parseClaudeHistory('é', { maxBytes: 1, maxRecords: 1 })).toThrow('byte limit');
    expect(() => parseClaudeHistory('\n', { maxBytes: 2, maxRecords: 1 })).toThrow('record limit');
  });
});

describe('Claude provider process integration', () => {
  function harness() {
    let stdout: (line: string) => void = () => {};
    let stderr: (line: string) => void = () => {};
    const exits: ((code: number | null) => void)[] = [];
    const kill = vi.fn();
    const requests: SpawnRequest[] = [];
    const handle: ProcessHandle = {
      onStdoutLine: (cb) => { stdout = cb; }, onStderrLine: (cb) => { stderr = cb; },
      onExit: (cb) => { exits.push(cb); }, kill, done: Promise.resolve(0),
      snapshot: () => ({ phase: 'running' }),
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const spawner = { spawn(request: SpawnRequest) { requests.push(request); return handle; } };
    return { spawner, logger, requests, kill, stdout: (s: string) => stdout(s), stderr: (s: string) => stderr(s),
      exit: (code: number | null) => exits.forEach((cb) => cb(code)) };
  }
  it('does not launch a CLI when listing models; launches only explicit sessions', async () => {
    const h = harness();
    const provider = createClaudeProvider(claudeDefaults, { ...h, baseEnv: { ANTHROPIC_API_KEY: 'secret', PATH: 'bin' } });
    expect(provider.id).toBe('claude');
    expect(provider.capabilities).toEqual({ interactiveBootstrap: 'command' });
    expect(await provider.listModels()).toEqual(claudeDefaults.models);
    expect(h.requests).toEqual([]);
    expect(provider.buildInteractiveCommand(spec).env.PATH).toBe('bin');
    const running = provider.startSession(spec);
    const events: SessionEvent[] = [];
    running.onEvent((event) => events.push(event));
    h.stdout('{"type":"result","result":"answer"}'); h.stderr('diagnostic'); h.exit(0);
    expect(events).toEqual([
      { type: 'stdout', line: '{"type":"assistant.message","data":{"content":"answer"}}' },
      { type: 'stdout', line: '{"type":"result","data":{}}' },
      { type: 'stderr', line: 'diagnostic' }, { type: 'exit', code: 0 },
    ]);
    running.kill();
    expect(h.kill).toHaveBeenCalledOnce();
    expect(await running.done).toBe(0);
    expect(h.requests[0]).toMatchObject({ command: 'claude', cwd: 'C:\\repo', stdin: 'ignore' });
    expect(h.logger.error).not.toHaveBeenCalled();
    h.exit(null); h.exit(1);
    expect(h.logger.error).toHaveBeenCalledWith('Claude Code session failed', { sessionId: id, exitCode: 1 });
  });
  it('supports injected native resume, cache and auth status, without modifying native interactive auth', () => {
    const h = harness();
    const provider = createClaudeProvider(claudeDefaults, { ...h, baseEnv: {},
      authMethod: () => 'api_key', sessionOptions: () => ({ resumeSessionId: id }),
      listImportableSessions: () => [] });
    expect(provider.startSession(spec).sessionId).toBe(id);
    expect(h.requests[0].args).toContain('--resume');
    expect(provider.listImportableSessions?.()).toEqual([]);
    expect(provider.buildInteractiveCommand(spec).args).toContain('--resume');
    const noAuth = createClaudeProvider(claudeDefaults, { ...h, baseEnv: {} });
    expect(() => noAuth.startSession(spec)).toThrow('Unsupported');
    expect(noAuth.buildInteractiveCommand(spec).command).toBe('claude');
    expect(noAuth.listImportableSessions).toBeUndefined();
  });
  it('guards both execution paths with verified readiness without probing dormant model catalogs', async () => {
    const h = harness();
    const assertReady = vi.fn();
    const waitUntilReady = vi.fn(async () => {});
    const provider = createClaudeProvider(claudeDefaults, {
      ...h, baseEnv: { ANTHROPIC_API_KEY: 'not-real' }, assertReady, waitUntilReady,
    });
    expect(await provider.listModels()).toEqual(claudeDefaults.models);
    expect(assertReady).not.toHaveBeenCalled();
    await provider.prepareInteractiveSession?.();
    expect(waitUntilReady).toHaveBeenCalledOnce();
    provider.startSession(spec);
    provider.buildInteractiveCommand(spec);
    expect(assertReady).toHaveBeenCalledTimes(2);
    expect(h.requests).toHaveLength(1);
    const blocked = createClaudeProvider(claudeDefaults, {
      ...h, baseEnv: {}, assertReady: () => { throw new ProviderError('Version probe is not ready'); },
    });
    expect(() => blocked.startSession(spec)).toThrow('Version probe is not ready');
    expect(() => blocked.buildInteractiveCommand(spec)).toThrow('Version probe is not ready');
    expect(h.requests).toHaveLength(1);
  });
});

describe('Claude bounded history cache', () => {
  it('serves bounded usage pages with native deduplication and no cumulative-token conflation', async () => {
    const result = { type: 'result', session_id: id, uuid: 'result1', usage: { input_tokens: 100 }, total_cost_usd: 0.4 };
    const cache = createClaudeHistoryCache({ ...claudeDefaults, historyMaxRecords: 5 }, { read: async () => [
      { path: 'a', jsonl: [assistant(), assistant(), result].map(line).join('\n') },
    ] });
    expect(cache.readUsagePage(id, null, 2)).toBeNull();
    await cache.refresh(new AbortController().signal);
    expect(cache.readUsagePage(id, null, 1)).toMatchObject({ samples: [{ scope: 'message' }], nextCursor: '1', highWaterCursor: '1' });
    expect(cache.readUsagePage(id, '1', 1)).toMatchObject({ samples: [{ scope: 'session', charge: { amount: 0.4 } }], nextCursor: null, highWaterCursor: '2' });
    expect(cache.readUsagePage(id, null, 100)?.samples).toHaveLength(2);
    expect(cache.readUsagePage('missing', null, 1)).toEqual({ samples: [], nextCursor: null, highWaterCursor: null });
    expect(cache.readUsagePage(id, '50', 1)).toEqual({ samples: [], nextCursor: null, highWaterCursor: '50' });
    expect(cache.readUsagePage(id, '2', 1)).toEqual({ samples: [], nextCursor: null, highWaterCursor: '2' });
    const snapshot = cache.snapshot();
    const samples = snapshot.usage![0][1];
    snapshot.usage![0][1] = [...samples, { ...samples[0], sourceId: 'later', nativeMessageId: 'later' }];
    cache.replace(snapshot);
    expect(cache.readUsagePage(id, '2', 1)).toMatchObject({
      samples: [{ sourceId: 'later' }], nextCursor: null, highWaterCursor: '3',
    });
    for (const [cursor, limit] of [['bad', 1], ['-1', 1], ['0', 0], ['0', 1.5]] as const) {
      expect(() => cache.readUsagePage(id, cursor, limit)).toThrow('Invalid');
    }
    const extraUsage = createClaudeHistoryCache({ ...claudeDefaults, historyMaxSessions: 1 }, { read: async () => [
      { path: 'a', jsonl: [result, { ...result, session_id: 'other' }].map(line).join('\n') },
    ] });
    await expect(extraUsage.refresh(new AbortController().signal)).rejects.toThrow('Claude usage exceeds session limit');
  });
  it('refreshes atomically through injected discovery and serves cached prompts/history/imports', async () => {
    const files = [{ path: 'discovered.jsonl', jsonl: [assistant({ uuid: 'orphan' }), user(), assistant(),
      assistant({ uuid: 'assistant2', timestamp: 'bad' }), user({ uuid: 'u2', timestamp: 'bad' }),
      assistant({ uuid: 'a3', timestamp: '' }), user({ uuid: 'u3' }),
      assistant({ uuid: 'a4', timestamp: '2025-01-01' }), user({ uuid: 'u4' })].map(line).join('\n') }];
    const read = vi.fn(async () => files);
    const cache = createClaudeHistoryCache(claudeDefaults, { read });
    expect(cache.read([id])).toEqual([]);
    expect(cache.prompts(id)).toEqual([]);
    await cache.refresh(new AbortController().signal);
    expect(cache.read(['missing', id])).toEqual([{ sessionId: id, summary: null, firstUserMessage: 'question', checkpoints: [] }]);
    expect(cache.prompts(id)[0]).toMatchObject({ text: 'question', response: 'answer\nanswer', status: 'answered', durationMs: null });
    expect(cache.prompts(id)[1]).toMatchObject({ durationMs: null, answeredAt: null });
    expect(cache.prompts(id)[2].durationMs).toBeNull();
    expect(cache.prompts(id)[3].status).toBe('unanswered');
    expect(cache.listImportable()[0]).toMatchObject({ externalId: id, provider: 'claude', title: 'question', model: 'sonnet' });
    expect(read).toHaveBeenCalledOnce();
  });
  it('reports unknown metadata without inventing repository or timestamps', async () => {
    const cache = createClaudeHistoryCache(claudeDefaults, { read: async () => [
      { path: 'a', jsonl: line(assistant({ message: { content: 'orphan' } })) },
    ] });
    await cache.refresh(new AbortController().signal);
    expect(cache.read([id])[0].firstUserMessage).toBeNull();
    expect(cache.listImportable()[0]).toMatchObject({ title: 'Claude Code session', model: null, repository: null });
    const timed = createClaudeHistoryCache(claudeDefaults, { read: async () => [{ path: 'a', jsonl: [user(), assistant()].map(line).join('\n') }] });
    await timed.refresh(new AbortController().signal);
    expect(timed.prompts(id)[0].durationMs).toBe(1000);
  });
  it('bounds total bytes/session counts, aborts before publishing and retains prior cache on failures', async () => {
    const signal = AbortSignal.abort();
    const aborted = createClaudeHistoryCache(claudeDefaults, { read: async () => [] });
    await aborted.refresh(signal);
    expect(aborted.listImportable()).toEqual([]);
    const files = [{ path: 'a', jsonl: line(user()) }, { path: 'b', jsonl: line(user({ sessionId: 'other' })) }];
    await expect(createClaudeHistoryCache({ ...claudeDefaults, historyMaxSessions: 1 }, { read: async () => files }).refresh(new AbortController().signal)).rejects.toThrow('session limit');
    await expect(createClaudeHistoryCache({ ...claudeDefaults, historyMaxBytes: 1 }, { read: async () => files }).refresh(new AbortController().signal)).rejects.toThrow('byte limit');
    await expect(createClaudeHistoryCache({ ...claudeDefaults, historyMaxSessions: 1 }, { read: async () => [
      { path: 'a', jsonl: files.map((file) => file.jsonl).join('\n') },
    ] }).refresh(new AbortController().signal)).rejects.toThrow('session limit');
  });
});

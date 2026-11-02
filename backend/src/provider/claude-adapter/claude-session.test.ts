import { describe, expect, it, vi } from 'vitest';
import type { ProcessHandle } from '../process-kernel/process-spawner.js';
import type { SessionEvent, SessionSpec } from '../provider-contract.js';
import type { Session } from '../../session/session-contract.js';
import { createTranscriptCapture } from '../../session/transcript-capture.js';
import { extractResponseText } from '../../meta/meta-response-extractor.js';
import { createMetaRunner } from '../../meta/meta-runner.js';
import { metaDefaults } from '../../meta/config.js';
import { createClaudeProvider } from './claude-provider.js';
import { claudeDefaults } from './config.js';
import { normalizeClaudeSession } from './claude-session.js';

const id = '550e8400-e29b-41d4-a716-446655440000';
const spec: SessionSpec = {
  sessionId: id, featureId: 'f', model: 'default', kind: 'meta', prompt: 'hello', otelFilePath: 'unused',
};
const nativeSession: Session = {
  id, featureId: 'f', name: null, provider: 'claude', requestedModel: 'default', resolvedModel: null,
  status: 'running', kind: 'meta', scope: 'internal', prompt: 'hello', usageFilePath: 'unused',
  createdAt: '2026-01-01', startedAt: '2026-01-01', endedAt: null, exitCode: null,
};

function harness() {
  const stdout: ((line: string) => void)[] = [];
  const stderr: ((line: string) => void)[] = [];
  const exits: ((code: number | null) => void)[] = [];
  let resolveDone: (code: number | null) => void = () => {};
  const native: ProcessHandle = {
    onStdoutLine: (cb) => { stdout.push(cb); },
    onStderrLine: (cb) => { stderr.push(cb); },
    onExit: (cb) => { exits.push(cb); },
    kill: vi.fn(),
    done: new Promise((resolve) => { resolveDone = resolve; }),
    snapshot: () => ({ phase: 'running' }),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const provider = createClaudeProvider(claudeDefaults, {
    spawner: { spawn: () => native }, baseEnv: { ANTHROPIC_API_KEY: 'not-a-real-key' }, logger,
  });
  const running = provider.startSession(spec);
  const capture = createTranscriptCapture(id);
  const events: SessionEvent[] = [];
  running.onEvent((event) => { events.push(event); capture.record(event); });
  const completion = running.done.then((code): Session => ({
    ...nativeSession, exitCode: code, status: code === 0 ? 'completed' : 'failed',
  }));
  const runner = createMetaRunner({
    config: { ...metaDefaults, timeoutMs: 1000 },
    launcher: { start: async () => ({ session: nativeSession, running, completion }) },
    transcripts: { save: async () => {}, load: async () => capture.result(), delete: async () => {} },
  });
  return {
    native, running, capture, events, logger, runner,
    output: (value: unknown) => stdout.forEach((cb) => cb(JSON.stringify(value))),
    rawOutput: (line: string) => stdout.forEach((cb) => cb(line)),
    error: (line: string) => stderr.forEach((cb) => cb(line)),
    exit: (code: number | null) => { exits.forEach((cb) => cb(code)); resolveDone(code); },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('Claude headless canonical output boundary', () => {
  it('feeds successful native result plaintext to the unchanged generic meta runner/extractor', async () => {
    const h = harness();
    const answer = h.runner.run({ featureId: 'f', prompt: 'hello' });
    await tick();
    h.output({ type: 'assistant', message: { content: [{ type: 'text', text: 'draft' }] } });
    h.output({ type: 'result', subtype: 'success', result: 'final response' });
    expect(h.native.kill).toHaveBeenCalledOnce();
    expect(extractResponseText(h.capture.result(), metaDefaults.responseTextKeys)).toBe('final response');
    let settled = false;
    void answer.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    h.exit(0);
    expect(await answer).toBe('final response');
    expect(h.capture.result().exitCode).toBe(0);
    expect(h.logger.error).not.toHaveBeenCalled();
  });
  it('extracts assistant text blocks/string fallback and keeps native diagnostics on stderr', async () => {
    const h = harness();
    h.rawOutput('native diagnostic');
    h.output({ type: 'system', subtype: 'init' });
    h.output({ type: 'assistant', parent_tool_use_id: 'subagent', message: { content: 'not main reply' } });
    h.output({ type: 'assistant', message: { content: [null, { type: 'tool_use' }, { type: 'text', text: 1 }] } });
    h.output({ type: 'assistant' });
    h.output({ type: 'assistant', message: { content: 'string fallback' } });
    h.output({ type: 'assistant', parent_tool_use_id: null, message: {
      content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
    } });
    h.error('native stderr diagnostic');
    h.output({ type: 'result', subtype: 'success' });
    h.exit(0);
    expect(await h.running.done).toBe(0);
    expect(extractResponseText(h.capture.result(), metaDefaults.responseTextKeys)).toBe('first\nsecond');
    expect(h.capture.result().stderr).toHaveLength(6);
    expect(h.capture.result().stdout).toHaveLength(3);
    expect(h.logger.error).not.toHaveBeenCalled();
  });
  it('never turns a failed native result into terminal success or manufactures exit proof', async () => {
    for (const failure of [
      { type: 'result', is_error: true, result: 'native auth failed' },
      { type: 'result', subtype: 'error_max_turns', errors: ['turn limit', 5] },
      { type: 'result', subtype: 'error_during_execution', errors: [] },
      { type: 'result', subtype: 'unknown-future-result' },
    ]) {
      const h = harness();
      const answer = h.runner.run({ featureId: 'f', prompt: 'hello' });
      const rejected = expect(answer).rejects.toThrow('Provider failed');
      await tick();
      h.output(failure);
      h.output({ type: 'assistant', message: { content: 'late assistant' } });
      h.output({ type: 'result', subtype: 'success', result: 'late success must not escape' });
      expect(h.capture.result().stdout.map((line) => JSON.parse(line).type)).toEqual(['session.error']);
      expect(h.events.some((event) => event.type === 'exit')).toBe(false);
      expect(h.native.kill).not.toHaveBeenCalled();
      let done = false;
      void h.running.done.then(() => { done = true; });
      await tick();
      expect(done).toBe(false);
      expect(extractResponseText(h.capture.result(), metaDefaults.responseTextKeys)).toBe('');
      h.exit(0);
      expect(await h.running.done).toBe(1);
      await rejected;
      expect(h.capture.result().exitCode).toBe(1);
      expect(h.logger.error).toHaveBeenCalledWith('Claude Code session failed', { sessionId: id, exitCode: 1 });
    }
  });
  it('preserves actual nonzero/null exits and delegates kill/snapshots with no event subscribers', async () => {
    for (const code of [null, 7]) {
      const h = harness();
      h.output({ type: 'result', is_error: true, result: '' });
      h.exit(code);
      expect(await h.running.done).toBe(code);
      h.running.kill();
      expect(h.native.kill).toHaveBeenCalledOnce();
    }
    let complete: (code: number | null) => void = () => {};
    let output: (line: string) => void = () => {};
    let error: (line: string) => void = () => {};
    let exit: (code: number | null) => void = () => {};
    const kill = vi.fn();
    const native: ProcessHandle = {
      onStdoutLine: (cb) => { output = cb; }, onStderrLine: (cb) => { error = cb; },
      onExit: (cb) => { exit = cb; }, kill,
      done: new Promise((resolve) => { complete = resolve; }), snapshot: () => ({ phase: 'running' }),
    };
    const normalized = normalizeClaudeSession(native);
    output('diagnostic'); error('diagnostic'); exit(0); complete(0);
    expect(await normalized.done).toBe(0);
    expect(normalized.snapshot()).toEqual({ phase: 'running' });
    normalized.kill();
    expect(kill).toHaveBeenCalledOnce();
  });
});

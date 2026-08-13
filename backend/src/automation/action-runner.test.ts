import { describe, it, expect } from 'vitest';
import { createActionRunner } from './action-runner.js';
import type { RunContext, Subagent } from './automation-contract.js';
import type { AiInvoker, ShellExecutor } from './automation-ports.js';
import type { SubagentService } from './subagent-service.js';

const ctx: RunContext = {
  automationId: 'a1',
  origin: { sessionId: 's1', featureId: 'f1' },
};

const noFeatureCtx: RunContext = {
  automationId: 'a1',
  origin: { sessionId: null, featureId: null },
};

function stubSubagents(): SubagentService {
  const subagent: Subagent = {
    id: 'g1',
    automationId: 'a1',
    origin: ctx.origin,
    task: 't',
    status: 'running',
    progress: null,
    result: null,
    sessionId: null,
    createdAt: 'now',
    updatedAt: 'now',
  };
  return {
    spawn: () => ({ subagent, completion: Promise.resolve() }),
    register: () => subagent,
    get: () => subagent,
    list: () => [subagent],
    listByAutomation: () => [subagent],
    updateProgress: () => subagent,
    complete: () => subagent,
    fail: () => subagent,
  };
}

function deps(overrides: {
  ai?: AiInvoker;
  shell?: ShellExecutor;
  subagents?: SubagentService;
} = {}) {
  return {
    ai: overrides.ai ?? { run: async () => ({ text: '', sessionId: 'm1' }) },
    shell:
      overrides.shell ?? { exec: async () => ({ code: 0, stdout: '', stderr: '' }) },
    subagents: overrides.subagents ?? stubSubagents(),
  };
}

describe('createActionRunner', () => {
  it('runs a metasession action and returns truncated detail + session', async () => {
    const runner = createActionRunner(
      deps({
        ai: {
          run: async (input) => {
            expect(input.featureId).toBe('f1');
            return { text: '  analysis done  ', sessionId: 'm7' };
          },
        },
      }),
    );
    const result = await runner.run(
      { type: 'metasession', prompt: 'do it', cwd: '/w' },
      ctx,
    );
    expect(result.detail).toBe('analysis done');
    expect(result.sessionId).toBe('m7');
    expect(result.subagentId).toBeNull();
    expect(result.report).toBeNull();
  });

  it('falls back to a default detail when metasession text is empty', async () => {
    const runner = createActionRunner(
      deps({ ai: { run: async () => ({ text: '   ', sessionId: 'm' }) } }),
    );
    const result = await runner.run({ type: 'metasession', prompt: 'x' }, ctx);
    expect(result.detail).toBe('Metasession completed');
  });

  it('truncates very long metasession output', async () => {
    const long = 'x'.repeat(600);
    const runner = createActionRunner(
      deps({ ai: { run: async () => ({ text: long, sessionId: 'm' }) } }),
    );
    const result = await runner.run({ type: 'metasession', prompt: 'x' }, ctx);
    expect(result.detail.endsWith('…')).toBe(true);
    expect(result.detail.length).toBe(500);
  });

  it('runs a report action and stores the report text', async () => {
    const runner = createActionRunner(
      deps({ ai: { run: async () => ({ text: ' report body ', sessionId: 'm2' }) } }),
    );
    const result = await runner.run({ type: 'report', prompt: 'summarize' }, ctx);
    expect(result.detail).toBe('Report generated');
    expect(result.report).toBe('report body');
    expect(result.sessionId).toBe('m2');
  });

  it('runs a subagent action via the subagent service', async () => {
    const runner = createActionRunner(deps());
    const result = await runner.run(
      { type: 'subagent', task: 'Investigate', prompt: 'go' },
      ctx,
    );
    expect(result.subagentId).toBe('g1');
    expect(result.detail).toBe('Subagent started: Investigate');
    expect(result.sessionId).toBeNull();
  });

  it('runs a command action and reports the exit code + output', async () => {
    const runner = createActionRunner(
      deps({
        shell: {
          exec: async (command, cwd) => {
            expect(command).toBe('npm test');
            expect(cwd).toBe('/repo');
            return { code: 1, stdout: 'fail ', stderr: 'err' };
          },
        },
      }),
    );
    const result = await runner.run(
      { type: 'command', command: 'npm test', cwd: '/repo' },
      ctx,
    );
    expect(result.detail).toBe('Command exited 1: fail err');
  });

  it('reports a command action with no output', async () => {
    const runner = createActionRunner(
      deps({ shell: { exec: async () => ({ code: 0, stdout: '', stderr: '' }) } }),
    );
    const result = await runner.run({ type: 'command', command: 'true' }, ctx);
    expect(result.detail).toBe('Command exited 0');
  });

  it('attributes AI actions to a stable key when there is no origin feature', async () => {
    let seen = '';
    const runner = createActionRunner(
      deps({
        ai: {
          run: async (input) => {
            seen = input.featureId;
            return { text: 'x', sessionId: 'm' };
          },
        },
      }),
    );
    await runner.run({ type: 'metasession', prompt: 'x' }, noFeatureCtx);
    expect(seen).toBe('automation:a1');
  });
});

import { describe, it, expect } from 'vitest';
import {
  attributionFeatureId,
  createCheckRunner,
  isAffirmative,
} from './check-runner.js';
import type { RunContext } from './automation-contract.js';
import type {
  AiInvoker,
  CiPipelineProbe,
  HttpProbe,
  ShellExecutor,
} from './automation-ports.js';

const ctx: RunContext = {
  automationId: 'a1',
  origin: { sessionId: 's1', featureId: 'f1' },
};

const noFeatureCtx: RunContext = {
  automationId: 'a1',
  origin: { sessionId: null, featureId: null },
};

function deps(overrides: {
  shell?: ShellExecutor;
  http?: HttpProbe;
  ai?: AiInvoker;
  ci?: CiPipelineProbe;
} = {}) {
  return {
    shell: overrides.shell ?? {
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    },
    http: overrides.http ?? {
      fetch: async () => ({ status: 200, body: '' }),
    },
    ai: overrides.ai ?? {
      run: async () => ({ text: '', sessionId: 'm1' }),
    },
    ci: overrides.ci ?? {
      latestRun: async () => null,
    },
  };
}

describe('attributionFeatureId', () => {
  it('uses the origin feature when present', () => {
    expect(attributionFeatureId(ctx)).toBe('f1');
  });
  it('falls back to a stable automation key', () => {
    expect(attributionFeatureId(noFeatureCtx)).toBe('automation:a1');
  });
});

describe('isAffirmative', () => {
  it('recognizes affirmative words', () => {
    expect(isAffirmative('Yes it is done')).toBe(true);
    expect(isAffirmative('complete')).toBe(true);
  });
  it('rejects non-affirmative text', () => {
    expect(isAffirmative('no, still running')).toBe(false);
  });
});

describe('createCheckRunner', () => {
  it('runs a shell check and trims combined output', async () => {
    const runner = createCheckRunner(
      deps({
        shell: {
          exec: async (command, cwd) => {
            expect(command).toBe('echo hi');
            expect(cwd).toBe('/tmp');
            return { code: 2, stdout: 'out ', stderr: 'err ' };
          },
        },
      }),
    );
    const result = await runner.run(
      { type: 'shell', command: 'echo hi', cwd: '/tmp' },
      ctx,
    );
    expect(result).toEqual({
      code: 2,
      status: '2',
      conclusion: null,
      text: 'out err',
      occurrenceKey: null,
    });
  });

  it('runs an http check with default GET', async () => {
    const runner = createCheckRunner(
      deps({
        http: {
          fetch: async (url, method) => {
            expect(url).toBe('http://x');
            expect(method).toBe('GET');
            return { status: 503, body: ' down ' };
          },
        },
      }),
    );
    const result = await runner.run({ type: 'http', url: 'http://x' }, ctx);
    expect(result.code).toBe(503);
    expect(result.status).toBe('503');
    expect(result.text).toBe('down');
  });

  it('passes an explicit http method', async () => {
    let seen = '';
    const runner = createCheckRunner(
      deps({
        http: {
          fetch: async (_url, method) => {
            seen = method;
            return { status: 200, body: '' };
          },
        },
      }),
    );
    await runner.run({ type: 'http', url: 'http://x', method: 'POST' }, ctx);
    expect(seen).toBe('POST');
  });

  it('runs an ai check yielding an affirmative verdict', async () => {
    const runner = createCheckRunner(
      deps({
        ai: {
          run: async (input) => {
            expect(input.featureId).toBe('f1');
            expect(input.prompt).toContain('yes');
            return { text: 'YES the build passed', sessionId: 'm9' };
          },
        },
      }),
    );
    const result = await runner.run(
      { type: 'ai', prompt: 'did it pass?', cwd: '/w' },
      ctx,
    );
    expect(result.code).toBe(1);
    expect(result.status).toBe('yes');
    expect(result.text).toBe('YES the build passed');
  });

  it('runs an ai check yielding a negative verdict', async () => {
    const runner = createCheckRunner(
      deps({ ai: { run: async () => ({ text: 'still going', sessionId: 'm' }) } }),
    );
    const result = await runner.run({ type: 'ai', prompt: 'done?' }, ctx);
    expect(result.code).toBe(0);
    expect(result.status).toBe('no');
  });

  it('runs a ci-pipeline check with a run present (with conclusion)', async () => {
    const runner = createCheckRunner(
      deps({
        ci: {
          latestRun: async (spec) => {
            expect(spec.provider).toBe('github');
            return { id: 'run-7', status: 'completed', conclusion: 'success' };
          },
        },
      }),
    );
    const result = await runner.run(
      { type: 'ci-pipeline', provider: 'github', repo: 'o/r' },
      ctx,
    );
    expect(result.status).toBe('completed');
    expect(result.conclusion).toBe('success');
    expect(result.text).toBe('completed/success');
    expect(result.occurrenceKey).toBe('run-7');
  });

  it('runs a ci-pipeline check with a run that has no conclusion', async () => {
    const runner = createCheckRunner(
      deps({
        ci: {
          latestRun: async () => ({
            id: 'run-8',
            status: 'in_progress',
            conclusion: null,
          }),
        },
      }),
    );
    const result = await runner.run(
      { type: 'ci-pipeline', provider: 'azure', repo: 'o/p' },
      ctx,
    );
    expect(result.text).toBe('in_progress');
    expect(result.occurrenceKey).toBe('run-8');
  });

  it('runs a ci-pipeline check with no run found', async () => {
    const runner = createCheckRunner(deps());
    const result = await runner.run(
      { type: 'ci-pipeline', provider: 'github', repo: 'o/r' },
      ctx,
    );
    expect(result.status).toBe('none');
    expect(result.occurrenceKey).toBeNull();
    expect(result.code).toBeNull();
  });
});

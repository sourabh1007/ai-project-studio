import { describe, it, expect, vi } from 'vitest';
import { createAutomationAiInvoker } from './meta-ai-invoker.js';
import type { MetaRunner, MetaRequest } from '../meta/meta-runner.js';

describe('createAutomationAiInvoker', () => {
  it('forwards the full automation request to the shared meta runner', async () => {
    const calls: MetaRequest[] = [];
    const meta: MetaRunner = {
      run: async () => '',
      runDetailed: async (request) => {
        calls.push(request);
        return { text: 'ok', sessionId: 'm1' };
      },
    };
    const invoker = createAutomationAiInvoker(meta);
    const controller = new AbortController();
    const onStart = vi.fn();
    const onActivity = vi.fn();

    await expect(
      invoker.run({
        automationId: 'a1',
        originSessionId: 'origin',
        featureId: 'f1',
        providerId: 'copilot',
        model: 'gpt-5',
        prompt: 'go',
        attachments: ['C:\\repo\\prompt.md'],
        cwd: 'C:\\repo',
        noTools: true,
        timeoutMs: 12_345,
        purpose: 'review',
        label: 'Automation action',
        signal: controller.signal,
        onStart,
        onActivity,
      }),
    ).resolves.toEqual({ text: 'ok', sessionId: 'm1' });

    expect(calls).toEqual([
      {
        automationId: 'a1',
        originSessionId: 'origin',
        featureId: 'f1',
        providerId: 'copilot',
        model: 'gpt-5',
        prompt: 'go',
        attachments: ['C:\\repo\\prompt.md'],
        cwd: 'C:\\repo',
        noTools: true,
        timeoutMs: 12_345,
        scope: 'internal',
        purpose: 'review',
        label: 'Automation action',
        signal: controller.signal,
        onStart,
        onActivity,
      },
    ]);
  });

  it('preserves an explicit scope override', async () => {
    const meta: MetaRunner = {
      run: async () => '',
      runDetailed: async (request) => {
        expect(request.scope).toBe('feature');
        return { text: 'ok', sessionId: 'm1' };
      },
    };
    const invoker = createAutomationAiInvoker(meta);
    await invoker.run({
      featureId: 'f1',
      prompt: 'go',
      scope: 'feature',
    });
  });
});

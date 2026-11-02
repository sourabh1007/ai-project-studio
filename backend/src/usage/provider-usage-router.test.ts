import { describe, expect, it, vi } from 'vitest';
import { createProviderUsageRouter, type ProviderUsageSource } from './provider-usage-router.js';
import type { UsageCaptureRead } from './usage-capture-contract.js';

describe('provider usage routing', () => {
  it('routes retained providers and warm native identities without active-provider admission', () => {
    const source: ProviderUsageSource = {
      sourceId: 'copilot-store',
      readUsagePage: vi.fn((): UsageCaptureRead => ({ status: 'ready', sourceId: 'copilot-store', rows: [], nextCursor: null, final: false })),
    };
    const router = createProviderUsageRouter({
      sessions: { get: (id) => id === 'old' ? { provider: 'copilot' } : null },
      sources: new Map([['copilot', source]]),
    });
    const context = { featureId: 'f', provider: 'copilot', requestedModel: 'auto' };
    expect(router.sourceId('copilot')).toBe('copilot-store');
    expect(router.sourceId('unknown')).toBe('unavailable:unknown');
    expect(router.readUsagePage('old', context, '4', 10).status).toBe('ready');
    expect(source.readUsagePage).toHaveBeenCalledWith('old', context, '4', 10);
    expect(router.readUsagePage('native-warm', context, null, 10).status).toBe('ready');
    expect(router.readUsagePage('old', { ...context, provider: 'other' }, null, 10)).toMatchObject({
      status: 'unsupported', reason: 'source-attribution-mismatch',
    });
    expect(router.readUsagePage('old', { ...context, provider: 'claude' }, null, 10)).toMatchObject({
      status: 'unsupported', reason: 'source-attribution-mismatch',
    });
    expect(router.readUsagePage('missing', { ...context, provider: 'other' }, null, 10)).toMatchObject({
      status: 'unsupported', reason: 'provider-usage-unavailable',
    });
    const knownMismatch = createProviderUsageRouter({ sessions: { get: () => ({ provider: 'claude' }) }, sources: new Map([['copilot', source]]) });
    expect(knownMismatch.readUsagePage('old', context, null, 10)).toMatchObject({ sourceId: 'copilot-store', reason: 'source-attribution-mismatch' });
  });
});

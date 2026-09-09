import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import { createApiClient, type FetchLike } from '../../lib/api.js';
import { MetaOperationsSection } from './meta-operations-section.js';
import type { MetaOperation, MetaOperationPage, MetaOperationSummary } from './meta-operation-types.js';

function operation(operationId: string, overrides: Partial<MetaOperation> = {}): MetaOperation {
  return {
    operationId, featureId: 'feature', automationId: null, originSessionId: null, providerId: 'copilot',
    requestedModel: 'auto', resolvedModel: null, sessionId: 'app', providerSessionId: 'provider',
    sessionIds: ['app'], transport: 'warm-acp', state: 'completed', outcome: 'returned',
    purpose: null, label: null, resultText: 'full text', errorMessage: null, usageState: 'unknown',
    usage: null, createdAt: 't', updatedAt: 't', startedAt: 't', finishedAt: 't', ...overrides,
  };
}
function summary(op: MetaOperation): MetaOperationSummary {
  const { resultText, ...metadata } = op;
  return { ...metadata, hasResult: resultText !== null };
}
function page(...operations: MetaOperation[]): MetaOperationPage {
  return { items: operations.map(summary), nextCursor: null };
}
function response(body: unknown, status = 200): Response {
  return { ok: status === 200, status, json: async () => body } as Response;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(fetchImpl: FetchLike) {
  const api = createApiClient({ fetchImpl });
  const view = render(<ApiProvider value={api}><MetaOperationsSection /></ApiProvider>);
  return { ...view, api };
}

describe('saved AI operation result viewer', () => {
  it('loads metadata only, pages with scope filters, and renders all escaped durable text on demand', async () => {
    const fullText = '<script>not executable</script>\n' + 'x'.repeat(1200);
    const first = operation('first', { label: 'Review', resultText: fullText });
    const second = operation('second', { purpose: 'Implementation', usage: { inputTokens: null, outputTokens: null, nanoAiu: null, credits: 0 } });
    const fetch = vi.fn<FetchLike>(async (url) => {
      if (url.endsWith('/first')) return response(first);
      return response(url.includes('after=first') ? page(second) : { ...page(first), nextCursor: 'first' });
    });
    const api = createApiClient({ fetchImpl: fetch });
    render(<ApiProvider value={api}><MetaOperationsSection featureId="f" sessionId="s" automationId="a" /></ApiProvider>);
    await screen.findByRole('button', { name: 'Review' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('/api/meta/operations?featureId=f&sessionId=s&automationId=a');
    expect(screen.queryByText(fullText)).toBeNull();
    expect(screen.getByText(/Credits unknown.*copilot/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Load more operations' }));
    await screen.findByRole('button', { name: 'Implementation' });
    expect(fetch.mock.calls[1][0]).toContain('after=first');
    expect(screen.getByText(/0 credits/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.querySelector('pre')?.textContent).toBe(fullText));
    expect(dialog.querySelector('script')).toBeNull();
    expect(within(dialog).getByText(/Application session: app · Provider session: provider/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close saved operation' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh operations' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Implementation' })).toBeNull());
  });

  it('keeps interrupted/unsupported metadata honest and distinguishes absent output from a saved empty result', async () => {
    const missing = operation('missing', { state: 'interrupted', outcome: 'unknown', resultText: null, sessionId: null,
      providerSessionId: null, providerId: null, requestedModel: null, usageState: 'unsupported', errorMessage: 'Termination unconfirmed' });
    const empty = operation('empty', { resultText: '' });
    setup(async (url) => response(url.endsWith('/missing') ? missing : url.endsWith('/empty') ? empty : page(missing, empty)));
    await screen.findByRole('button', { name: 'missing' });
    expect(screen.getByText(/Usage unsupported.*Provider unknown \/ Model unknown.*No durable result yet/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'missing' }));
    await screen.findByText('No result was durably captured. This does not prove that no effects occurred.');
    expect(screen.getByText('Termination unconfirmed')).toBeDefined();
    expect(screen.getByText(/Application session: Unknown · Provider session: Unknown/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'empty' }));
    await screen.findByText('The saved result is empty.');
  });

  it('retries list and full-result failures without inventing empty success', async () => {
    const op = operation('operation');
    let listCalls = 0; let resultCalls = 0;
    setup(async (url) => {
      if (url.endsWith('/operation')) return ++resultCalls === 1 ? response({ error: 'gone' }, 500) : response(op);
      return ++listCalls === 1 ? response({ error: 'unavailable' }, 503) : response(page(op));
    });
    await screen.findByText(/Unable to load saved operations/);
    expect(screen.queryByText('No saved operations.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh operations' }));
    fireEvent.click(await screen.findByRole('button', { name: 'operation' }));
    await screen.findByText('Unable to load the saved result.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry saved result' }));
    await screen.findByText('full text');
  });

  it('shows loading and genuine empty history states', async () => {
    const pending = deferred<Response>();
    setup(() => pending.promise);
    expect(screen.getByText('Loading operations…')).toBeDefined();
    await act(async () => pending.resolve(response(page())));
    expect(screen.getByText('No saved operations.')).toBeDefined();
  });

  it.each(['resolve', 'reject'] as const)('ignores stale %s list responses when scope changes', async (settle) => {
    const old = deferred<Response>();
    const fresh = operation('fresh');
    const { api, rerender } = setup((url) => url.includes('featureId=new') ? Promise.resolve(response(page(fresh))) : old.promise);
    rerender(<ApiProvider value={api}><MetaOperationsSection featureId="new" /></ApiProvider>);
    await screen.findByRole('button', { name: 'fresh' });
    await act(async () => { if (settle === 'resolve') old.resolve(response(page(operation('stale')))); else old.reject(new Error('stale')); });
    expect(screen.queryByRole('button', { name: 'stale' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'fresh' })).toBeDefined();
  });

  it.each(['resolve', 'reject'] as const)('ignores a stale %s full result after close and after unmount', async (settle) => {
    const pending = deferred<Response>();
    const op = operation('operation');
    const { unmount } = setup((url) => url.endsWith('/operation') ? pending.promise : Promise.resolve(response(page(op))));
    fireEvent.click(await screen.findByRole('button', { name: 'operation' }));
    expect(screen.getByText('Loading saved result…')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Close saved operation' }));
    unmount();
    await act(async () => { if (settle === 'resolve') pending.resolve(response(op)); else pending.reject(new Error('stale')); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('meta operation client routes', () => {
  it('uses default empty query, encodes filters/cursor/ID, and omits null and undefined values', async () => {
    const fetch = vi.fn<FetchLike>(async () => response({ items: [], nextCursor: null }));
    const api = createApiClient({ fetchImpl: fetch });
    await api.listMetaOperations();
    await api.listMetaOperations({ featureId: 'f &', sessionId: 's/', automationId: 'a?', after: 'next/', limit: 2 });
    await api.listMetaOperations({ after: null, featureId: undefined });
    await api.getMetaOperation('operation /?');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/meta/operations',
      '/api/meta/operations?featureId=f+%26&sessionId=s%2F&automationId=a%3F&after=next%2F&limit=2',
      '/api/meta/operations',
      '/api/meta/operations/operation%20%2F%3F',
    ]);
  });
});

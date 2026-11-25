import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationInsights } from '../meta-operations/operation-insights.js';
import type { MetaOperationPage, MetaOperationSummary } from '../meta-operations/meta-operation-types.js';
import { McpInsights } from './mcp-insights.js';
import { RecordedUsageInsights, UsageInsights } from '../usage/usage-insights.js';
import { ResourceInsights } from '../resources/resource-insights.js';
import type { AppResourceSnapshot } from '../resources/resource-types.js';
import type { StoredUsage, UsageRollup } from '../../lib/types.js';
import { sharedRead } from './shared-read.js';

const api = vi.hoisted(() => ({ listMetaOperations: vi.fn(), getMcpHistory: vi.fn(), getUsageRollup: vi.fn(), getIdeUsageRollup: vi.fn() }));
vi.mock('../../app/api-context.js', () => ({ useApi: () => api }));
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

const operation = (id: string, values: Partial<MetaOperationSummary> = {}): MetaOperationSummary => ({
  operationId: id, featureId: 'f', automationId: null, originSessionId: null, providerId: 'copilot',
  requestedModel: 'auto', resolvedModel: 'model', sessionId: 's', providerSessionId: 'ps', sessionIds: ['s'],
  transport: 'warm-acp', state: 'completed', outcome: 'returned', purpose: 'review', label: id,
  errorMessage: null, usageState: 'unknown', usage: null, hasResult: true,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
  startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', ...values,
});

describe('owner-bound insight reads', () => {
  it('keeps calendar and operation insights inside the supplied Usage window', async () => {
    const window = { from: '2026-11-01', to: '2026-12-01' };
    api.getUsageRollup.mockResolvedValue({ periods: [] } as unknown as UsageRollup);
    api.listMetaOperations.mockResolvedValue({ items: [], nextCursor: null });
    render(<><UsageInsights scope="workspace" signal={0} window={window} />
      <OperationInsights scope={{ from: `${window.from}T00:00:00.000Z`, to: `${window.to}T00:00:00.000Z` }} /></>);
    await waitFor(() => expect(api.getUsageRollup).toHaveBeenCalledWith('day', window));
    await waitFor(() => expect(api.listMetaOperations).toHaveBeenCalledWith({
      from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z', limit: 100, after: null,
    }));
    expect(screen.queryByLabelText('From (UTC)')).toBeNull();
    expect(screen.queryByLabelText('From (UTC, optional)')).toBeNull();
    expect(screen.getByText(/Follows the selected Usage time frame/)).toBeInTheDocument();
  });

  it('ignores a late result for another owner and never requests operation result text', async () => {
    let finish!: (page: MetaOperationPage) => void;
    api.listMetaOperations.mockImplementationOnce(() => new Promise<MetaOperationPage>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ items: [operation('New owner')], nextCursor: null });
    const { rerender } = render(<OperationInsights scope={{ featureId: 'old', runId: 'r' }} />);
    await waitFor(() => expect(api.listMetaOperations).toHaveBeenCalledOnce());
    rerender(<OperationInsights scope={{ featureId: 'new', runId: 'r2' }} />);
    expect(await screen.findByRole('rowheader', { name: 'New owner' })).toBeInTheDocument();
    await act(async () => finish({ items: [operation('Old owner')], nextCursor: null }));
    expect(screen.queryByText('Old owner')).not.toBeInTheDocument();
    expect(api.listMetaOperations.mock.calls[1][0]).toEqual({ featureId: 'new', runId: 'r2', limit: 100, after: null });
    fireEvent.click(screen.getByRole('button', { name: 'New owner, State: completed' }));
    expect(screen.getByText(/Operation New owner/)).toBeInTheDocument();
    api.listMetaOperations.mockResolvedValue({ items: [], nextCursor: null });
    await act(async () => rerender(<OperationInsights scope={{ featureId: 'third' }} />));
    expect(screen.queryByText(/Operation New owner/)).not.toBeInTheDocument();
  });
  it('pages only when requested, validates optional windows and separates timed cohorts by outcome', async () => {
    api.listMetaOperations.mockResolvedValue({ items: [
      operation('one', { label: 'Review' }), operation('two', { label: 'Review', finishedAt: '2026-01-01T00:00:03.000Z' }),
      operation('failed', { label: 'Review', state: 'failed', outcome: 'unknown', finishedAt: null }),
    ], nextCursor: 'next' });
    render(<OperationInsights scope={{ runId: 'r' }} />);
    await screen.findByRole('button', { name: 'Next operation page' });
    expect(api.listMetaOperations).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText('Operation insight'), { target: { value: 'outcomes' } });
    fireEvent.click(screen.getByRole('button', { name: '2026-01-01, Failed: 1' }));
    expect(screen.getByRole('rowheader', { name: 'Review' })).toBeInTheDocument();
    expect(screen.getByText(/Timeline filtered to 2026-01-01 \/ failed \(1 operations\)/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Operation insight'), { target: { value: 'models' } });
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByRole('rowheader', { name: /completed\/returned/ }).parentElement).toHaveTextContent('2');
    expect(within(table).getAllByText('Unavailable').length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole('button', { name: 'Next operation page' }));
    await waitFor(() => expect(api.listMetaOperations).toHaveBeenLastCalledWith({ runId: 'r', after: 'next', limit: 100 }));
    fireEvent.change(screen.getByLabelText('From (UTC, optional)'), { target: { value: '2026-01-01' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Choose both UTC dates');
    fireEvent.change(screen.getByLabelText('To (UTC, exclusive)'), { target: { value: '2026-02-01' } });
    await waitFor(() => expect(api.listMetaOperations).toHaveBeenLastCalledWith({
      runId: 'r', from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', after: null, limit: 100,
    }));
  });
  it('keeps tool/provider/scope identity, even-sample medians and unreported outcomes explicit', async () => {
    api.getMcpHistory.mockResolvedValue({ limited: true, items: [
      { callId: '1', tool: 'read', at: '2026-01-01T00:00:00.000Z', durationMs: 10 },
      { callId: '2', tool: 'read', at: '2026-01-01T00:00:00.000Z', durationMs: 30 },
      { callId: '3', tool: 'read', at: '2026-01-01T00:00:00.000Z', durationMs: null },
    ] });
    render(<McpInsights provider="copilot" server="tools" scope="internal" featureId="f" />);
    const row = (await screen.findByRole('rowheader', { name: 'read · 2026-01-01' })).parentElement!;
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['3', '2', '20', 'Unavailable', '1']);
    expect(api.getMcpHistory).toHaveBeenCalledWith(expect.objectContaining({ provider: 'copilot', server: 'tools', scope: 'internal', featureId: 'f' }));
    expect(screen.getByText(/Latest 500 calls shown/)).toBeInTheDocument();
  });
  it('bounds usage reads and does not request an incomplete date window', async () => {
    api.getUsageRollup.mockResolvedValue({ periods: [] } as unknown as UsageRollup);
    render(<UsageInsights scope="workspace" signal={0} />);
    await screen.findByRole('table');
    expect(api.getUsageRollup).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText('From (UTC)'), { target: { value: '' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a valid UTC window');
    expect(api.getUsageRollup).toHaveBeenCalledOnce();
  });
  it('uses only supplied scoped usage and preserves incomplete billing', () => {
    render(<RecordedUsageInsights events={[
      { startedAt: '2026-01-01T23:59:59Z', nanoAiu: 1000000000, inputTokens: 10, outputTokens: 2, reasoningOutputTokens: 0 },
      { startedAt: '2026-01-01T23:59:59Z', nanoAiu: null, inputTokens: 1, outputTokens: 0, reasoningOutputTokens: 0 },
    ] as StoredUsage[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Data table' }));
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Metric'), { target: { value: 'tokens' } });
    expect(screen.getByRole('cell', { name: '13' })).toBeInTheDocument();
    expect(api.getUsageRollup).not.toHaveBeenCalled();
  });
  it('separates storage history by exact path scope, without initiating a storage scan', () => {
    render(<ResourceInsights storage snapshot={{
      storage: { categories: [{ id: 'app', kind: 'app', label: 'App', paths: ['C:\\current'] }] },
      history: { samples: [], storage: [
        { at: 1, category: 'app', scope: '["C:\\\\current"]', bytes: 1048576 },
        { at: 2, category: 'app', scope: '["C:\\\\other"]', bytes: 999 },
      ] },
    } as unknown as AppResourceSnapshot} />);
    fireEvent.click(screen.getByRole('button', { name: 'Data table' }));
    expect(screen.getByRole('cell', { name: '1' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: '999' })).not.toBeInTheDocument();
  });
  it('bounds pending reads and permits retries after settlement without retaining response data', async () => {
    const owner = {};
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const reads = Array.from({ length: 64 }, (_, index) => sharedRead(owner, String(index), () => gate));
    await expect(sharedRead(owner, 'overflow', async () => undefined)).rejects.toThrow('Too many concurrent');
    finish();
    await Promise.all(reads);
    expect(await sharedRead(owner, 'overflow', async () => 'retried')).toBe('retried');
  });
  it('pauses hidden-window reads and refreshes on visibility without losing the selected view', async () => {
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    api.listMetaOperations.mockResolvedValue({ items: [], nextCursor: null });
    const { rerender } = render(<OperationInsights scope={{ featureId: 'f' }} />);
    await waitFor(() => expect(api.listMetaOperations).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText('Operation insight'), { target: { value: 'outcomes' } });
    visible.mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    rerender(<OperationInsights scope={{ featureId: 'f' }} signal={1} />);
    await act(async () => { await Promise.resolve(); });
    expect(api.listMetaOperations).toHaveBeenCalledOnce();
    visible.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(api.listMetaOperations).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('Operation insight')).toHaveValue('outcomes');
  });
});

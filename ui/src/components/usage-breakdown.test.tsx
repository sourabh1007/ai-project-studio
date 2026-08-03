import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../app/api-context.js';
import type { ApiClient } from '../lib/api.js';
import type { StoredUsage } from '../lib/types.js';
import { UsageBreakdownModal, type UsageScope } from './usage-breakdown.js';

function usage(overrides: Partial<StoredUsage> = {}): StoredUsage {
  return {
    sessionId: 's1',
    featureId: 'f1',
    turnIndex: 0,
    kind: 'dev',
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: 'claude-opus-4.8',
    operation: 'chat',
    sessions: 1,
    inputTokens: 1200,
    outputTokens: 3400,
    reasoningOutputTokens: 50,
    cost: 0.5,
    credits: 0.5,
    nanoAiu: 1_500_000_000,
    serviceRequestId: null,
    startedAt: '2025-01-01T00:00:00.000Z',
    endedAt: '2025-01-01T00:00:05.000Z',
    ...overrides,
  };
}

function renderModal(client: Partial<ApiClient>, scope: UsageScope) {
  const onClose = vi.fn();
  render(
    <ApiProvider value={client as unknown as ApiClient}>
      <UsageBreakdownModal scope={scope} onClose={onClose} />
    </ApiProvider>,
  );
  return { onClose };
}

describe('UsageBreakdownModal', () => {
  it('loads and renders per-turn session usage with summary totals', async () => {
    const getSessionUsageEvents = vi.fn().mockResolvedValue([
      usage({ turnIndex: 0, resolvedModel: 'claude-opus-4.8' }),
      usage({
        turnIndex: 1,
        resolvedModel: 'gpt-5.3-codex',
        nanoAiu: 500_000_000,
        inputTokens: 100,
        outputTokens: 200,
        reasoningOutputTokens: 0,
      }),
    ]);
    renderModal(
      { getSessionUsageEvents },
      { kind: 'session', id: 's1', label: 'Session #1' },
    );

    expect(
      await screen.findByText('Usage breakdown · Session #1'),
    ).toBeInTheDocument();
    // Two model rows (per-model subtotals shown when >1 model) plus their
    // table rows, so each model name appears in both places.
    expect(screen.getAllByText('claude-opus-4.8').length).toBeGreaterThan(0);
    expect(screen.getAllByText('gpt-5.3-codex').length).toBeGreaterThan(0);
    // Total AIC = (1.5e9 + 0.5e9)/1e9 = 2.00.
    expect(screen.getByText('2.00')).toBeInTheDocument();
    expect(getSessionUsageEvents).toHaveBeenCalledWith('s1');
    // A table row per turn.
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2 turns
  });

  it('uses the requested model when no model was resolved', async () => {
    const getSessionUsageEvents = vi
      .fn()
      .mockResolvedValue([usage({ resolvedModel: '', requestedModel: 'auto' })]);
    renderModal(
      { getSessionUsageEvents },
      { kind: 'session', id: 's1', label: 'Session #1' },
    );

    expect(await screen.findByText('auto')).toBeInTheDocument();
    // A single model does not render the per-model subtotal list.
    expect(screen.queryByText('0.50 AIC')).not.toBeInTheDocument();
  });

  it('shows an empty state when there is no usage', async () => {
    const getFeatureUsageEvents = vi.fn().mockResolvedValue([]);
    renderModal(
      { getFeatureUsageEvents },
      { kind: 'feature', id: 'f1', label: 'My feature' },
    );

    expect(
      await screen.findByText('No usage recorded yet.'),
    ).toBeInTheDocument();
    expect(getFeatureUsageEvents).toHaveBeenCalledWith('f1');
  });

  it('loads repository-scoped usage', async () => {
    const getRepoUsageEvents = vi.fn().mockResolvedValue([usage()]);
    renderModal(
      { getRepoUsageEvents },
      { kind: 'repo', id: 'r1', label: 'my-repo' },
    );

    expect(
      await screen.findByText('Usage breakdown · my-repo'),
    ).toBeInTheDocument();
    expect(getRepoUsageEvents).toHaveBeenCalledWith('r1');
    expect(
      screen.getByText(/Every AI credit and token recorded for this repository/),
    ).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    const getSessionUsageEvents = vi
      .fn()
      .mockRejectedValue(new Error('boom'));
    renderModal(
      { getSessionUsageEvents },
      { kind: 'session', id: 's1', label: 'Session #1' },
    );

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('closes when the close button is clicked', async () => {
    const getSessionUsageEvents = vi.fn().mockResolvedValue([usage()]);
    const { onClose } = renderModal(
      { getSessionUsageEvents },
      { kind: 'session', id: 's1', label: 'Session #1' },
    );

    await screen.findByText('Usage breakdown · Session #1');
    fireEvent.click(screen.getByLabelText('Close'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { FeatureUsage } from '../../lib/types.js';
import { FeatureDashboard } from './feature-dashboard.js';
vi.mock('../../components/usage-breakdown.js', () => ({
  UsageBreakdownModal: () => null,
}));
vi.mock('../skills/skill-tagger.js', () => ({
  SkillTagger: () => <div>Feature skills</div>,
}));
vi.mock('../shared-context/shared-context-panel.js', () => ({
  SharedContextPanel: () => <div>Shared context</div>,
}));
vi.mock('./work-summary.js', () => ({
  FeatureWorkSummaryPanel: () => <div>Work summary</div>,
}));
vi.mock('recharts', () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Svg = ({ children }: { children?: ReactNode }) => <svg>{children}</svg>;
  const Group = ({ children }: { children?: ReactNode }) => <g>{children}</g>;
  return {
    ResponsiveContainer: Container,
    AreaChart: Svg,
    Area: () => null,
    BarChart: Svg,
    Bar: () => null,
    Cell: () => null,
    PieChart: Svg,
    Pie: Group,
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
  };
});

function usage(sessions: number): FeatureUsage {
  return {
    totals: {
      sessions,
      inputTokens: sessions * 10,
      outputTokens: sessions * 5,
      reasoningOutputTokens: 0,
      cost: 0,
      credits: 0,
      nanoAiu: sessions * 1_000_000_000,
    },
    groups: [],
    byModel: sessions > 0 ? [{
      model: 'gpt-5.5',
      sessions,
      inputTokens: 10,
      outputTokens: 5,
      reasoningOutputTokens: 0,
      cost: 0,
      credits: 0,
      nanoAiu: 1_000_000_000,
    }] : [],
    byProvider: [],
    byDay: sessions > 0 ? [{
      day: '2026-01-01',
      sessions,
      inputTokens: 10,
      outputTokens: 5,
      reasoningOutputTokens: 0,
      cost: 0,
      credits: 0,
      nanoAiu: 1_000_000_000,
    }] : [],
    bySession: sessions > 0 ? [{
      sessionId: 's1',
      groupId: null,
      origin: 'user',
      provider: 'copilot',
      kind: 'dev',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:05:00.000Z',
      activeMs: 300000,
      sessions,
      inputTokens: 10,
      outputTokens: 5,
      reasoningOutputTokens: 0,
      cost: 0,
      credits: 0,
      nanoAiu: 1_000_000_000,
    }] : [],
    timing: { totalActiveMs: sessions * 300000 },
  };
}

function renderDashboard(client: ApiClient) {
  return render(
    <ApiProvider value={client}>
      <FeatureDashboard featureId="feature-1" featureName="Feature 1" />
    </ApiProvider>,
  );
}

describe('FeatureDashboard usage freshness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
  });

  it('shows manual snapshot freshness, refreshes on demand, and keeps prior data on refresh failure', async () => {
    const getFeatureUsage = vi.fn()
      .mockResolvedValueOnce(usage(1))
      .mockResolvedValueOnce(usage(2))
      .mockRejectedValueOnce(new Error('usage offline'));
    const listSessions = vi.fn().mockResolvedValue([]);
    const client = {
      getFeatureUsage,
      listSessions,
    } as unknown as ApiClient;

    renderDashboard(client);
    await act(async () => {});
    expect(
      screen.getByText(/This usage view is a manual snapshot/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(getFeatureUsage).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Snapshot captured/i)).toHaveAttribute(
      'dateTime',
      '2026-01-01T12:00:00.000Z',
    );

    vi.setSystemTime(new Date('2026-01-01T12:05:00.000Z'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }));
    await act(async () => {});
    expect(getFeatureUsage).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Snapshot captured/i)).toHaveAttribute(
      'dateTime',
      '2026-01-01T12:05:00.000Z',
    );

    vi.setSystemTime(new Date('2026-01-01T12:06:00.000Z'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }));
    await act(async () => {});
    expect(screen.getByRole('status')).toHaveTextContent(
      'Showing the last loaded usage snapshot for this feature. Refresh failed: usage offline',
    );
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText(/Snapshot captured/i)).toHaveAttribute(
      'dateTime',
      '2026-01-01T12:05:00.000Z',
    );
  });

  it('quarantines stale feature responses across rapid switches and retries initial failure honestly', async () => {
    let resolveA!: (value: FeatureUsage) => void;
    let resolveB!: (value: FeatureUsage) => void;
    const getFeatureUsage = vi.fn((featureId: string) => {
      if (featureId === 'feature-1') {
        return new Promise<FeatureUsage>((resolve) => {
          resolveA = resolve;
        });
      }
      return new Promise<FeatureUsage>((resolve) => {
        resolveB = resolve;
      });
    });
    const client = {
      getFeatureUsage,
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as ApiClient;

    const view = render(
      <ApiProvider value={client}>
        <FeatureDashboard featureId="feature-1" featureName="Feature 1" />
      </ApiProvider>,
    );

    view.rerender(
      <ApiProvider value={client}>
        <FeatureDashboard featureId="feature-2" featureName="Feature 2" />
      </ApiProvider>,
    );

    expect(getFeatureUsage).toHaveBeenNthCalledWith(2, 'feature-2');
    await act(async () => {
      resolveB(usage(0));
    });
    expect(screen.getByText(/No usage recorded/i)).toBeInTheDocument();

    await act(async () => {
      resolveA(usage(2));
    });
    expect(screen.queryByText(/Feature 1/i)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Feature 2' })).toBeInTheDocument();
    expect(screen.queryByText('2.00')).not.toBeInTheDocument();

    const failingClient = {
      getFeatureUsage: vi
        .fn()
        .mockRejectedValueOnce(new Error('usage offline'))
        .mockResolvedValueOnce(usage(1)),
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as ApiClient;
    view.unmount();
    renderDashboard(failingClient);
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent('usage offline');
    expect(screen.queryByText(/No usage recorded/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    expect(screen.getByText('Overview')).toBeInTheDocument();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

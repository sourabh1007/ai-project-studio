import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { MetaUsageActivity, UsageGranularity, UsageRollup } from '../../lib/types.js';
import type { UsageWindow } from '../../lib/usage-window.js';
import { UsageView } from './usage-view.js';

const motion = vi.hoisted(() => ({ value: 'off' as 'off' | 'full' | 'reduced' }));
vi.mock('../../hooks/use-motion.js', () => ({ useMotion: () => motion.value }));
vi.mock('../monitoring/insights.js', () => ({
  Insights: ({ children }: { children: ReactNode | (() => ReactNode) }) =>
    <>{typeof children === 'function' ? children() : children}</>,
}));
vi.mock('../../components/skill-usage.js', () => ({
  SkillUsage: ({ window }: { window: UsageWindow }) => <div data-testid="skill-window">{JSON.stringify(window)}</div>,
}));
vi.mock('./usage-insights.js', () => ({
  UsageInsights: ({ window }: { window: UsageWindow }) => <div data-testid="calendar-window">{JSON.stringify(window)}</div>,
}));
vi.mock('../meta-operations/operation-insights.js', () => ({
  OperationInsights: ({ scope }: { scope: object }) => <div data-testid="operation-window">{JSON.stringify(scope)}</div>,
}));
vi.mock('../../components/mcp-usage-charts.js', () => ({ McpUsageCharts: () => null }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T15:30:00Z'));
  motion.value = 'off';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function rollup(granularity: UsageGranularity, window: UsageWindow, ide = false): UsageRollup {
  const days = (Date.parse(window.to) - Date.parse(window.from)) / 86400000;
  const count = (days > 31 ? 40 : days > 7 ? 10 : days > 1 ? 4 : 2) + Number(ide);
  const totals = {
    sessions: count, inputTokens: count * 100, outputTokens: count * 10, reasoningOutputTokens: 0,
    nanoAiu: count * 1e9, credits: count, cost: null,
  };
  return {
    scope: ide ? 'ide' : 'workspace', granularity, totals,
    periods: [{ ...totals, key: window.from, label: window.from, start: window.from, end: window.to }],
    byModel: [{ ...totals, model: `Model ${window.from}` }],
    byProvider: [{ ...totals, provider: `Provider ${window.from}` }], byMcpServer: [],
  };
}

function client(): ApiClient {
  const capture = (label: string, capturedAt: string): MetaUsageActivity => ({
    sessionId: label, featureId: null, providerId: 'copilot', requestedModel: 'auto', resolvedModel: null,
    transport: 'warm-acp', providerSessionId: null, purpose: null, label,
    inputTokens: null, outputTokens: null, nanoAiu: null, credits: null, capturedAt,
  });
  return {
    getUsageRollup: vi.fn(async (granularity: UsageGranularity, window?: UsageWindow) => rollup(granularity, window!)),
    getPromptUsage: vi.fn(async () => ({ events: [], limited: false, maxEvents: 100 })),
    getIdeUsageRollup: vi.fn(async (granularity: UsageGranularity, window?: UsageWindow) => rollup(granularity, window!, true)),
    getIdeActivity: vi.fn(async () => ({ records: [
      capture('Current capture', '2026-11-02T15:00:00Z'),
      capture('Old capture', '2025-01-01T00:00:00Z'),
    ] })),
  } as unknown as ApiClient;
}

async function mount(api = client()) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<ApiProvider value={api}><UsageView signal={0} /></ApiProvider>);
  });
  return { ...view, api };
}

function number(label: string) {
  return screen.getByRole('group', { name: new RegExp(`^${label}:`) }).querySelector('.dash-kpi-value')!.textContent;
}

it('refreshes cards, breakdowns and secondary views with each selected UTC time frame in both scopes', async () => {
  const { api } = await mount();
  expect(number('Sessions')).toBe('10');
  for (const [label, grouping, from, to, count] of [
    ['Day', 'day', '2026-11-02', '2026-11-03', 2],
    ['Week', 'day', '2026-11-02', '2026-11-09', 4],
    ['Year', 'month', '2026-01-01', '2027-01-01', 40],
    ['Month', 'day', '2026-11-01', '2026-12-01', 10],
  ] as const) {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })); });
    const window = { from, to };
    expect(api.getUsageRollup).toHaveBeenLastCalledWith(grouping, window);
    expect(api.getIdeUsageRollup).toHaveBeenLastCalledWith(grouping, window);
    expect(number('Sessions')).toBe(String(count));
    expect(number('Input tokens')).toBe((count * 100).toLocaleString('en-US'));
    expect(number('Output tokens')).toBe(String(count * 10));
    expect(screen.getByText(`Model ${from}`)).toBeVisible();
    expect(screen.getByTestId('skill-window')).toHaveTextContent(JSON.stringify(window));
    expect(screen.getByTestId('calendar-window')).toHaveTextContent(JSON.stringify(window));
  }
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'IDE metasessions' })); });
  expect(number('Sessions')).toBe('11');
  expect(screen.getByTestId('operation-window')).toHaveTextContent(JSON.stringify({
    from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z',
  }));
  expect(screen.getByText('Current capture')).toBeVisible();
  expect(screen.queryByText('Old capture')).toBeNull();
});

it('rejects late date-range responses and clearly retains the old window when refresh fails', async () => {
  const { api } = await mount();
  let finish!: (value: UsageRollup) => void;
  vi.mocked(api.getUsageRollup).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Year' })); });
  expect(screen.getByText(/Updating the selected time frame/)).toHaveTextContent('2026-11-01');
  expect(number('Sessions')).toBe('10');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Day' })); });
  expect(number('Sessions')).toBe('2');
  await act(async () => finish(rollup('month', { from: '2026-01-01', to: '2027-01-01' })));
  expect(number('Sessions')).toBe('2');
  vi.mocked(api.getUsageRollup).mockRejectedValueOnce(new Error('Offline'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Week' })); });
  expect(screen.getByRole('status')).toHaveTextContent("Couldn't refresh usage");
  expect(screen.getByText(/Showing 2026-11-02 to 2026-11-03/)).toBeVisible();
  expect(number('Sessions')).toBe('2');
});

it('animates changing counts, retargets smoothly and cancels animation when motion is turned off', async () => {
  motion.value = 'full';
  let now = 100;
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  const tick = (at: number) => {
    now = at;
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(at);
    }
  };
  const view = await mount();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Day' })); });
  expect(number('Sessions')).toBe('10');
  expect(screen.getByRole('group', { name: 'Sessions: 2' })).toBeInTheDocument();
  act(() => tick(300));
  expect(number('Sessions')).toBe('3');
  act(() => tick(500));
  expect(number('Sessions')).toBe('2');
  expect(frames.size).toBe(0);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Year' })); });
  act(() => tick(600));
  const intermediate = number('Sessions');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Week' })); });
  expect(number('Sessions')).toBe(intermediate);
  motion.value = 'off';
  await act(async () => view.rerender(<ApiProvider value={view.api}><UsageView signal={0} /></ApiProvider>));
  expect(number('Sessions')).toBe('4');
  expect(frames.size).toBe(0);
});

it('updates immediately in reduced motion and never animates unknown billing as zero', async () => {
  motion.value = 'reduced';
  const api = client();
  const data = rollup('day', { from: '2026-11-01', to: '2026-12-01' });
  vi.mocked(api.getUsageRollup).mockResolvedValueOnce({
    ...data, totals: { ...data.totals, nanoAiu: null, credits: null },
  });
  await mount(api);
  expect(within(screen.getByRole('group', { name: 'AI credits (AIC): Unavailable' })).getByText('Unavailable')).toBeVisible();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Day' })); });
  expect(number('Sessions')).toBe('2');
  expect(screen.getByRole('group', { name: 'AI credits (AIC): 2.00' }).querySelector('.dash-kpi-value')).toHaveTextContent('2.00');
});

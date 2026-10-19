import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider } from '../app/api-context.js';
import { createApiClient } from '../lib/api.js';
import type { SkillUsageRow, SkillUsageSnapshot } from '../lib/types.js';
import { SkillUsage } from './skill-usage.js';

afterEach(cleanup);
const row = (source: SkillUsageRow['source'], extra: Partial<SkillUsageRow> = {}): SkillUsageRow => ({
  identity: `${source}-id`, name: `${source} skill`, source, kind: 'invocation', provider: 'agency',
  repoId: 'r1', repoName: 'Project', uses: 2, sessions: 1,
  inputTokens: null, outputTokens: null, nanoAiu: null, reportedInput: 0, reportedOutput: 0, reportedAic: 0,
  lastUsedAt: '2026-10-17T10:00:00.000Z', ...extra,
});
const snapshot = (rows: SkillUsageRow[]): SkillUsageSnapshot => ({ rows, limited: false, maxEvents: 5000 });
function client(data = snapshot([])) {
  return {
    ...createApiClient(),
    getSkillUsage: vi.fn(async (_scope: 'feature' | 'internal') => data),
    getFeatureSkillUsage: vi.fn(async (_id: string) => data),
  };
}

it('separates sources and context activities and displays only attributable billing with explicit partial coverage', async () => {
  const api = client(snapshot([
    row('repository', { inputTokens: 100, reportedInput: 1, nanoAiu: 0, reportedAic: 2 }),
    row('ide', { kind: 'context-prepared', repoName: null }),
    row('cli', { kind: 'context-injected', repoId: null, repoName: null }),
    row('unknown'),
  ]));
  render(<ApiProvider value={api}><SkillUsage signal={0} /></ApiProvider>);
  const table = await screen.findByRole('table', { name: 'Per-skill usage' });
  expect(api.getSkillUsage).toHaveBeenCalledWith('feature');
  expect(within(table).getByText('100 (partial)')).toBeInTheDocument();
  expect(within(table).getByText('0.00')).toBeInTheDocument();
  expect(within(table).getByText('Context prepared')).toBeInTheDocument();
  expect(within(table).getByText('Context injected')).toBeInTheDocument();
  expect(within(table).getByText('Not associated')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'CLI' }));
  expect(within(table).getByText('cli skill')).toBeInTheDocument();
  expect(within(table).queryByText('repository skill')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'All skills' }));
  expect(within(table).getByText('repository skill')).toBeInTheDocument();
});

it('scopes feature reads and discloses bounded historical windows', async () => {
  const api = client({ ...snapshot([row('repository')]), limited: true });
  render(<ApiProvider value={api}><SkillUsage featureId="f1" signal="revision" /></ApiProvider>);
  await screen.findByRole('table', { name: 'Per-skill usage' });
  expect(api.getFeatureSkillUsage).toHaveBeenCalledWith('f1');
  expect(api.getSkillUsage).not.toHaveBeenCalled();
  expect(screen.getByRole('status')).toHaveTextContent('most recent 5,000 skill events');
});

it('shows unknown availability rather than zero for empty sources and internal scope', async () => {
  const api = client();
  render(<ApiProvider value={api}><SkillUsage scope="internal" signal={0} /></ApiProvider>);
  expect(await screen.findByText(/No recorded skill activity/)).toHaveTextContent('Unavailable telemetry is not zero');
  expect(api.getSkillUsage).toHaveBeenCalledWith('internal');
});

it('surfaces failed refreshes without clearing an existing snapshot', async () => {
  const api = client(snapshot([row('repository')]));
  const view = render(<ApiProvider value={api}><SkillUsage signal={0} /></ApiProvider>);
  await screen.findByRole('table', { name: 'Per-skill usage' });
  api.getSkillUsage.mockRejectedValueOnce(new Error('Offline'));
  view.rerender(<ApiProvider value={api}><SkillUsage signal={1} /></ApiProvider>);
  expect(await screen.findByRole('status')).toHaveTextContent('showing the previous snapshot: Offline');
  expect(screen.getByText('repository skill')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh skills' }));
  expect(await screen.findByRole('table', { name: 'Per-skill usage' })).toBeInTheDocument();
});

it('does not leak workspace rows into a new scope while its read is pending', async () => {
  const api = client(snapshot([row('repository')]));
  const view = render(<ApiProvider value={api}><SkillUsage signal={0} /></ApiProvider>);
  await screen.findByText('repository skill');
  api.getSkillUsage.mockImplementationOnce(() => new Promise(() => {}));
  view.rerender(<ApiProvider value={api}><SkillUsage scope="internal" signal={0} /></ApiProvider>);
  expect(screen.queryByText('repository skill')).toBeNull();
});

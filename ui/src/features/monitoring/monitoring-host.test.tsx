import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MonitoringProvider, useMonitoringHost } from './monitoring-host.js';
import { WorkspaceDaySessions } from '../usage/usage-insights.js';
import type { LiveState } from '../../lib/stream.js';

const api = vi.hoisted(() => ({ getSession: vi.fn(), getFeature: vi.fn(), listFeatureAgents: vi.fn(), listUsageSessions: vi.fn() }));
vi.mock('../../app/api-context.js', () => ({ useApi: () => api }));
beforeEach(() => vi.resetAllMocks());
const live = {} as LiveState;
function Controls() {
  const host = useMonitoringHost()!;
  return <><button onClick={() => void host.openOwner?.({ featureId: 'f', sessionId: 's' }).catch(() => {})}>Session</button>
    <button onClick={() => void host.openOwner?.({ featureId: 'f', attachmentId: 'a', agentId: 'bug-bash' }).catch(() => {})}>Agent</button>
    <span>{host.openOwner ? 'Owner capable' : 'Detached owner'}</span></>;
}
it('validates authoritative session and attachment identity without creating replacements', async () => {
  const onOpen = vi.fn();
  render(<MonitoringProvider live={live} onOpen={onOpen}><Controls /></MonitoringProvider>);
  api.getSession.mockResolvedValue({ id: 's', featureId: 'wrong', kind: 'dev', scope: 'feature' });
  fireEvent.click(screen.getByText('Session'));
  await waitFor(() => expect(api.getSession).toHaveBeenCalledOnce());
  expect(onOpen).not.toHaveBeenCalled();
  api.getSession.mockResolvedValue({ id: 's', featureId: 'f', kind: 'dev', scope: 'feature', name: 'Origin' });
  fireEvent.click(screen.getByText('Session'));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ kind: 'session', id: 's' })));
  api.getFeature.mockResolvedValue({ id: 'f', name: 'Feature' });
  api.listFeatureAgents.mockResolvedValue([]);
  fireEvent.click(screen.getByText('Agent'));
  await waitFor(() => expect(api.listFeatureAgents).toHaveBeenCalledOnce());
  expect(onOpen).toHaveBeenCalledOnce();
  api.listFeatureAgents.mockResolvedValue([{ attachment: { id: 'a', agentId: 'bug-bash', featureId: 'f' },
    manifest: { id: 'bug-bash', title: 'Bug Bash', allowMultiplePerFeature: true } }]);
  fireEvent.click(screen.getByText('Agent'));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent', id: 'agent:a', attachmentId: 'a' })));
});
it('ignores late owner resolution after navigation and does not advertise unsupported detached navigation', async () => {
  let resolve!: (session: unknown) => void;
  api.getSession.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const onOpen = vi.fn();
  const { rerender } = render(<MonitoringProvider live={live} onOpen={onOpen} navigationKey="usage"><Controls /></MonitoringProvider>);
  fireEvent.click(screen.getByText('Session'));
  rerender(<MonitoringProvider live={live} onOpen={onOpen} navigationKey="settings"><Controls /></MonitoringProvider>);
  await act(async () => resolve({ id: 's', featureId: 'f', kind: 'dev', scope: 'feature' }));
  expect(onOpen).not.toHaveBeenCalled();
  rerender(<MonitoringProvider live={live}><Controls /></MonitoringProvider>);
  expect(screen.getByText('Detached owner')).toBeInTheDocument();
});
it('pages day sessions on demand and keeps deleted owners and unknown billing explicit', async () => {
  api.listUsageSessions.mockResolvedValueOnce({ items: [{ sessionId: 'gone', featureId: 'f', name: null,
    available: false, retained: true, inputTokens: 2, outputTokens: 3, nanoAiu: null }], nextCursor: 'gone' })
    .mockResolvedValue({ items: [], nextCursor: null });
  render(<MonitoringProvider live={live}><WorkspaceDaySessions date="2026-01-01" /></MonitoringProvider>);
  expect(await screen.findByText(/Session details unavailable/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'gone' })).toBeDisabled();
  expect(api.listUsageSessions).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText('Next session page'));
  await screen.findByText('No session records available for this day.');
  expect(api.listUsageSessions).toHaveBeenLastCalledWith({ day: '2026-01-01', after: 'gone', limit: '100' });
  fireEvent.click(screen.getByText('First session page'));
  await waitFor(() => expect(api.listUsageSessions).toHaveBeenLastCalledWith({ day: '2026-01-01', after: '', limit: '100' }));
});

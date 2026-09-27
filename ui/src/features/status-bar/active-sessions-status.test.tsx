import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveSessionsStatus } from './active-sessions-status.js';
import type { ActiveSessionDebug, ActiveSessionEntry, ActiveSessionsSnapshot } from '../active-sessions/active-session-types.js';

const user: ActiveSessionEntry = {
  id: 'session:user', sessionId: 'user', kind: 'session', state: 'running', transport: 'session',
  label: 'My terminal', purpose: null, featureId: 'f', featureName: 'Feature', projectName: 'Project', operationId: null, provider: 'copilot', model: 'auto',
};
const idle: ActiveSessionEntry = { ...user, id: 'warm:s1', sessionId: null, kind: 'meta', state: 'idle', label: 'IDE warm session s1', transport: 'warm-acp' };
const cold: ActiveSessionEntry = { ...user, id: 'session:cold', sessionId: 'cold', kind: 'meta', state: 'busy', label: 'Review task', purpose: 'pr-review', operationId: 'op' };
const emptyDebug: ActiveSessionDebug = { sampledAt: 100, entry: idle, state: 'idle', activity: [], output: '', error: null, truncated: false };
const snapshot: ActiveSessionsSnapshot = { sampledAt: 100, pollMs: 3000, entries: [user, idle, cold] };
const makeApi = () => ({
  getActiveSessions: vi.fn(async () => snapshot),
  getActiveSessionDebug: vi.fn(async () => emptyDebug),
});
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
afterEach(() => vi.useRealTimers());

describe('clickable active sessions and read-only IDE debug', () => {
  it('opens all sessions and navigates normal instances to their existing terminal', async () => {
    const api = makeApi();
    const onOpen = vi.fn();
    render(<ActiveSessionsStatus api={api} onOpen={onOpen} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '3 active' }));
    const dialog = screen.getByRole('dialog', { name: 'Active sessions' });
    expect(dialog).toHaveClass('active-sessions-modal');
    const metasessions = within(dialog).getByRole('region', { name: 'Metasessions (2)' });
    const others = within(dialog).getByRole('region', { name: 'Other sessions (1)' });
    expect(within(metasessions).getAllByRole('listitem')).toHaveLength(2);
    expect(within(others).getAllByRole('listitem')).toHaveLength(1);
    expect(within(metasessions).getByRole('img', { name: 'Idle · available, not processing' })).toHaveAttribute('title', 'Idle · available, not processing');
    expect(within(metasessions).getByRole('img', { name: 'Busy · IDE operation' })).toBeTruthy();
    expect(within(dialog).queryByText('Idle · available, not processing')).toBeNull();
    expect(within(dialog).queryByText('IDE metasession')).toBeNull();
    expect(within(dialog).getAllByText('Project · Feature')).toHaveLength(2);
    expect(within(metasessions).getByText('Project · Feature · pr-review')).toBeTruthy();
    const open = within(others).getByRole('button', { name: 'Open terminal tab: My terminal' });
    expect(open.textContent).toBe('');
    expect(open).toHaveAttribute('title', 'Open terminal tab: My terminal');
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith(user);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.getActiveSessionDebug).not.toHaveBeenCalled();
    await flush();
  });

  it('inspects idle metasessions without attaching, reports no activity, and restores the list', async () => {
    const api = makeApi();
    const onOpen = vi.fn();
    render(<ActiveSessionsStatus api={api} onOpen={onOpen} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '3 active' }));
    fireEvent.click(screen.getByRole('button', { name: /IDE warm session s1/ }));
    await flush();
    expect(screen.getByRole('dialog', { name: 'IDE metasession · live debug' })).toBeTruthy();
    expect(screen.getByText('No activity available for this session.')).toBeTruthy();
    expect(screen.getByText('No output available — this warm session is idle.')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    expect(api.getActiveSessionDebug).toHaveBeenCalledWith('warm:s1', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Back to active sessions' }));
    expect(screen.getByRole('dialog', { name: 'Active sessions' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await flush();
  });

  it('updates cold operation output, errors and ended state using only the selected read API', async () => {
    vi.useFakeTimers();
    const api = makeApi();
    api.getActiveSessionDebug.mockResolvedValue({ ...emptyDebug, entry: cold, state: 'running', activity: ['Reading source'], output: 'Partial response', truncated: true });
    const onOpen = vi.fn();
    render(<ActiveSessionsStatus api={api} onOpen={onOpen} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '3 active' }));
    fireEvent.click(screen.getByRole('button', { name: /Review task/ }));
    await flush();
    expect(screen.getByText('Reading source')).toBeTruthy();
    expect(screen.getByText('Partial response')).toBeTruthy();
    expect(screen.getByText(/Showing a bounded/)).toBeTruthy();
    api.getActiveSessions.mockResolvedValue({ ...snapshot, entries: [user, idle] });
    api.getActiveSessionDebug.mockResolvedValue({ ...emptyDebug, entry: null, state: 'failed', error: 'Provider failed', output: 'Final diagnostic' });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText('Session is no longer active.')).toBeTruthy();
    expect(screen.getByText('Provider failed')).toBeTruthy();
    expect(screen.getByText('Final diagnostic')).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('reports initial unavailable counts rather than pretending no sessions exist', async () => {
    const api = makeApi();
    api.getActiveSessions.mockRejectedValue(new Error('offline'));
    render(<ActiveSessionsStatus api={api} onOpen={vi.fn()} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '? active · stale' }));
    expect(screen.getByText(/Active sessions are unavailable/)).toBeTruthy();
    expect(screen.queryByText('No active sessions.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry active sessions' })).toBeTruthy();
  });

  it('omits missing context and repeated actions while keeping honest lifecycle icons accessible', async () => {
    const api = makeApi();
    api.getActiveSessions.mockResolvedValue({ ...snapshot, entries: [
      { ...idle, projectName: null, featureName: null, featureId: null },
      { ...idle, id: 'warm:warming', label: 'Starting worker', state: 'warming', projectName: null, featureName: null, purpose: 'Starting worker' },
      { ...idle, id: 'warm:stopping', label: 'Retiring worker', state: 'stopping', projectName: null, featureName: null },
    ] });
    render(<ActiveSessionsStatus api={api} onOpen={vi.fn()} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '3 active' }));
    await flush();
    const meta = screen.getByRole('region', { name: 'Metasessions (3)' });
    expect(screen.getByRole('region', { name: 'Other sessions (0)' })).toBeTruthy();
    expect(within(meta).queryByText(/not associated/i)).toBeNull();
    expect(within(meta).queryByText('Open live debug')).toBeNull();
    expect(within(meta).getAllByText('Starting worker')).toHaveLength(1);
    expect(within(meta).getByRole('img', { name: 'Warming · not yet available' })).toHaveAttribute('title', 'Warming · not yet available');
    expect(within(meta).getByRole('img', { name: 'Stopping · unavailable, waiting for process exit' })).toBeTruthy();
    const open = within(meta).getByRole('button', { name: 'Open live debug: IDE warm session s1' });
    expect(open.textContent).toBe('');
    expect(open).toHaveAttribute('aria-description', 'Idle · available, not processing');
    fireEvent.click(open);
    await flush();
    expect(screen.getAllByText('Not associated')).toHaveLength(2);
    expect(screen.getByText('No activity available for this session.')).toBeTruthy();
  });
});

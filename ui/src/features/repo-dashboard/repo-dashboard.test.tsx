import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type {
  RepoDefinitionEntry,
  RepoInsights,
  RepoInsightsStreamEvent,
  Repository,
} from '../../lib/types.js';
import { RepoDashboard } from './repo-dashboard.js';

let nextRepoId = 0;

function setup() {
  const repo: Repository = {
    id: `scan-repo-${++nextRepoId}`,
    provider: 'github',
    remoteUrl: 'https://github.com/acme/app',
    name: 'acme/app',
    localPath: 'C:\\repo',
    defaultBranch: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const scans: Array<{
    emit: (event: RepoInsightsStreamEvent) => void;
    signal: AbortSignal;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  const analyzeRepoInsights = vi.fn<ApiClient['analyzeRepoInsights']>(
    (_id, emit, signal) => new Promise<void>((resolve, reject) => {
      scans.push({ emit, signal: signal!, resolve, reject });
    }),
  );
  const api = {
    analyzeRepoInsights,
    getRepositoryContext: vi.fn(() => new Promise(() => {})),
  } as unknown as ApiClient;
  const dashboard = (repository = repo, hidden = false) => (
    <ApiProvider value={api}>
      <div hidden={hidden}>
        <RepoDashboard repo={repository} />
      </div>
    </ApiProvider>
  );
  return { repo, scans, analyzeRepoInsights, dashboard };
}

function entry(name: string): RepoDefinitionEntry {
  return { name, path: `${name}.md`, author: 'acme', description: '' };
}

function insights(repoId: string, name = 'Completed skill'): RepoInsights {
  return {
    repositoryId: repoId,
    branch: 'main',
    agents: [],
    skills: [entry(name)],
    docs: [entry('Completed doc')],
    readiness: [],
    agentReady: false,
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('repository dashboard scan cancellation', () => {
  it('passes a signal, cancels immediately before any results and allows retry', async () => {
    const { dashboard, scans, analyzeRepoInsights } = setup();
    render(dashboard());
    expect(scans[0].signal).toBeInstanceOf(AbortSignal);
    expect(scans[0].signal.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(scans[0].signal.aborted).toBe(true);
    expect(screen.getByText('Scan cancelled.')).toBeInTheDocument();
    expect(screen.queryByText('Scanning repository')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rescan' })).toBeEnabled();
    await act(async () => scans[0].reject(new DOMException('Aborted', 'AbortError')));
    expect(screen.queryByText('Aborted')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    expect(analyzeRepoInsights).toHaveBeenCalledTimes(2);
    expect(scans[1].signal.aborted).toBe(false);
    expect(screen.queryByText('Scan cancelled.')).not.toBeInTheDocument();
  });

  it('retains streamed structural results and stops section progress on cancel', () => {
    const { dashboard, scans } = setup();
    render(dashboard());
    act(() => {
      scans[0].emit({
        type: 'section', section: 'skills',
        entries: [entry('Scanned skill')], analysis: 'Skill analysis',
      });
      scans[0].emit({ type: 'section-analyzing', section: 'docs', healing: true });
    });
    expect(screen.getByText(/Self-healing/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Scanned skill')).toBeInTheDocument();
    expect(screen.getByText('Skill analysis')).toBeInTheDocument();
    expect(screen.queryByText(/Self-healing/)).not.toBeInTheDocument();
    expect(screen.getByText('Scan cancelled. Showing available results.')).toBeInTheDocument();
  });

  it('retains completed sections during a partial rescan and does not cache cancellation', async () => {
    const { dashboard, scans, repo } = setup();
    const first = render(dashboard());
    await act(async () => {
      scans[0].emit({ type: 'done', insights: insights(repo.id) });
      scans[0].resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    act(() => scans[1].emit({
      type: 'section', section: 'skills',
      entries: [entry('Updated skill')], analysis: null,
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Updated skill')).toBeInTheDocument();
    expect(screen.getByText('Completed doc')).toBeInTheDocument();
    first.unmount();
    render(dashboard());
    expect(scans).toHaveLength(3);
    expect(screen.getByText('Completed skill')).toBeInTheDocument();
    expect(screen.queryByText('Updated skill')).not.toBeInTheDocument();
  });

  it('replays a persisted restored snapshot instantly then refreshes in the background', async () => {
    const { dashboard, scans, repo } = setup();
    render(dashboard());
    // The server replays the persisted snapshot first (survives restarts), so
    // the page fills immediately without waiting for a fresh full scan.
    act(() => scans[0].emit({ type: 'restored', insights: insights(repo.id, 'Restored skill') }));
    expect(screen.getByText('Restored skill')).toBeInTheDocument();
    expect(screen.queryByText('Scanning repository')).not.toBeInTheDocument();
    // The same scan then streams fresh results that replace the snapshot in place.
    act(() => scans[0].emit({
      type: 'section', section: 'skills',
      entries: [entry('Fresh skill')], analysis: null,
    }));
    expect(screen.getByText('Fresh skill')).toBeInTheDocument();
    await act(async () => {
      scans[0].emit({ type: 'done', insights: insights(repo.id, 'Fresh skill') });
      scans[0].resolve();
    });
    expect(scans).toHaveLength(1);
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores all stale events and %s/finally after cancel and replacement',
    async (settlement) => {
      const { dashboard, scans, repo } = setup();
      const first = render(dashboard());
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
      await act(async () => {
        scans[0].emit({ type: 'branch', branch: 'stale-branch' });
        scans[0].emit({ type: 'section-analyzing', section: 'docs', healing: true });
        scans[0].emit({
          type: 'section', section: 'skills',
          entries: [entry('Stale skill')], analysis: 'Stale analysis',
        });
        scans[0].emit({ type: 'section-failed', section: 'docs', error: 'Stale section failure' });
        scans[0].emit({ type: 'done', insights: insights(repo.id, 'Stale completion') });
        if (settlement === 'resolve') scans[0].resolve();
        else scans[0].reject(new Error('Stale error'));
      });
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Rescan' })).toBeDisabled();
      expect(screen.queryByText(/Stale/)).not.toBeInTheDocument();
      act(() => scans[1].emit({
        type: 'section', section: 'skills',
        entries: [entry('Current skill')], analysis: null,
      }));
      expect(screen.getByText('Current skill')).toBeInTheDocument();
      expect(screen.getByText('Branch main')).toBeInTheDocument();
      expect(screen.queryByText(/Self-healing|Stale/)).not.toBeInTheDocument();
      first.unmount();
      render(dashboard());
      // Neither cancellation nor stale `done` may populate the completed cache.
      expect(scans).toHaveLength(3);
    },
  );

  it('aborts on repository switch, clears old results, and ignores the old error', async () => {
    const { dashboard, scans, repo } = setup();
    const view = render(dashboard());
    act(() => scans[0].emit({
      type: 'section', section: 'skills', entries: [entry('Old repo skill')], analysis: null,
    }));
    view.rerender(dashboard({ ...repo, id: `${repo.id}-other`, name: 'other' }));
    expect(scans[0].signal.aborted).toBe(true);
    expect(scans).toHaveLength(2);
    expect(screen.queryByText('Old repo skill')).not.toBeInTheDocument();
    await act(async () => scans[0].reject(new Error('Old repo error')));
    expect(screen.queryByText('Old repo error')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('aborts on unmount and ignores late completion without caching it', async () => {
    const { dashboard, scans, repo } = setup();
    const first = render(dashboard());
    first.unmount();
    expect(scans[0].signal.aborted).toBe(true);
    await act(async () => {
      scans[0].emit({ type: 'done', insights: insights(repo.id) });
      scans[0].resolve();
    });
    render(dashboard());
    expect(scans).toHaveLength(2);
    expect(screen.queryByText('Completed skill')).not.toBeInTheDocument();
  });

  it('aborts a replaced effect scan under StrictMode', async () => {
    const { dashboard, scans } = setup();
    render(<StrictMode>{dashboard()}</StrictMode>);
    expect(scans).toHaveLength(2);
    expect(scans[0].signal.aborted).toBe(true);
    expect(scans[1].signal.aborted).toBe(false);
    await act(async () => scans[0].resolve());
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('does not abort or rescan when a mounted dashboard is hidden and shown', () => {
    const { dashboard, scans, repo } = setup();
    const view = render(dashboard());
    view.rerender(dashboard(repo, true));
    expect(scans[0].signal.aborted).toBe(false);
    view.rerender(dashboard(repo));
    expect(scans).toHaveLength(1);
  });

  it('still surfaces current scan failures and stops scanning', async () => {
    const { dashboard, scans } = setup();
    render(dashboard());
    await act(async () => scans[0].reject(new Error('Current failure')));
    expect(screen.getByText('Current failure')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rescan' })).toBeEnabled();
  });
});

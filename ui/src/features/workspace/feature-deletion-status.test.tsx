import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FeatureDeletionStore } from '../../lib/feature-deletion-store.js';
import { FeatureDeletionStatus } from './feature-deletion-status.js';

describe('FeatureDeletionStatus', () => {
  it('keeps progress through navigation, then shows success and permits dismissal', async () => {
    const store = new FeatureDeletionStore();
    const view = render(<FeatureDeletionStatus store={store} />);
    expect(screen.queryByRole('region')).toBeNull();
    let finish!: () => void;
    act(() => {
      store.enqueue({ id: 'f', name: 'Development' }, () => new Promise<void>((resolve) => { finish = resolve; }));
    });
    expect(screen.getByRole('progressbar', { name: 'Deleting features' })).toBeVisible();
    view.unmount();
    render(<FeatureDeletionStatus store={store} />);
    expect(screen.getByRole('status')).toHaveTextContent('1 deleting');
    expect(screen.getByRole('button', { name: 'Show details' })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByText('Development')).toHaveAttribute('title', 'Development');
    expect(screen.queryByRole('button', { name: /Dismiss/ })).toBeNull();
    await act(async () => finish());
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('Deleted')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss deletion of Development' }));
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('keeps actionable failures visible without opening another destructive confirmation', async () => {
    const store = new FeatureDeletionStore();
    render(<FeatureDeletionStatus store={store} />);
    await act(async () => {
      store.enqueue({ id: 'f', name: 'Development' }, async () => { throw new Error('Worktree is locked'); });
    });
    const status = screen.getByRole('region', { name: 'Feature deletions' });
    expect(within(status).getByRole('status')).toHaveTextContent('Attention needed: 1');
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(within(status).getByRole('alert')).toHaveTextContent('Worktree is locked');
    expect(within(status).getByRole('alert')).toHaveTextContent('Check the feature');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss deletion of Development' }));
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('summarizes mixed results, collapses details and clears only completed deletions', async () => {
    const store = new FeatureDeletionStore();
    render(<FeatureDeletionStatus store={store} />);
    let finish!: () => void;
    await act(async () => {
      store.enqueue({ id: 'done', name: 'Completed' }, async () => {});
      store.enqueue({ id: 'failed', name: 'Blocked' }, async () => { throw new Error('Still running'); });
      store.enqueue({ id: 'running', name: 'Active' }, () => new Promise<void>((resolve) => { finish = resolve; }));
      store.enqueue({ id: 'queued', name: 'Waiting' }, async () => {});
    });
    expect(screen.getByRole('status')).toHaveTextContent('1 deleting / 1 queued / 1 deleted / Attention needed: 1');
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Active').closest('li')).toHaveAttribute('data-state', 'running');
    expect(screen.getByText('Waiting').closest('li')).toHaveAttribute('data-state', 'queued');
    expect(screen.getByText('Active').closest('.feature-deletion-text')?.previousElementSibling)
      .toHaveClass('feature-deletion-icon');
    fireEvent.click(screen.getByRole('button', { name: 'Clear completed' }));
    expect(store.getSnapshot().map((job) => job.id)).toEqual(['failed', 'running', 'queued']);
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));
    expect(screen.queryByRole('list')).toBeNull();
    await act(async () => finish());
    expect(screen.getByRole('status')).toHaveTextContent('2 deleted / Attention needed: 1');
  });
});

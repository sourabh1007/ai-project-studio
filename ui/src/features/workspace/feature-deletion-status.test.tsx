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
    expect(screen.getByText('Working in background')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
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
    expect(within(status).getByRole('alert')).toHaveTextContent('Worktree is locked');
    expect(within(status).getByRole('alert')).toHaveTextContent('Check the feature');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss deletion of Development' }));
    expect(screen.queryByRole('region')).toBeNull();
  });
});

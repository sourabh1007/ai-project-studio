import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityStatus } from './activity-status.js';
import { beginActivity, clearActivityError, endActivity, getActivitySnapshot } from '../../lib/activity.js';

afterEach(() => {
  while (getActivitySnapshot().pending > 0) endActivity();
  clearActivityError();
  vi.useRealTimers();
});

describe('delayed activity feedback', () => {
  it('retains one loader and adds honest elapsed text and safe retry guidance', () => {
    vi.useFakeTimers();
    const token = beginActivity('Loading repositories…');
    const { container, unmount } = render(<ActivityStatus />);
    expect(screen.queryByText(/Delayed/)).toBeNull();
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByText(/Delayed/)).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText(/10s/)).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTitle(/progress is unknown/)).toHaveAttribute('title', expect.stringContaining('Check the result'));
    expect(container.querySelectorAll('.spinner')).toHaveLength(1);
    act(() => endActivity(token));
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText(/Delayed/)).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

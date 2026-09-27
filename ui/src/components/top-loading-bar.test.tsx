import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopLoadingBar } from './top-loading-bar.js';
import {
  beginActivity,
  clearActivityError,
  endActivity,
  failActivity,
} from '../lib/activity.js';

afterEach(() => {
  // Drain any lingering activity so the singleton store starts clean.
  clearActivityError();
});

describe('TopLoadingBar', () => {
  it('renders nothing when idle', () => {
    const { container } = render(<TopLoadingBar />);
    expect(container.firstChild).toBeNull();
  });

  it('shows only a decorative progress track while busy', () => {
    const { container } = render(<TopLoadingBar />);
    act(() => beginActivity('Loading PR review'));
    const bar = container.firstChild;
    expect(bar).toHaveClass('is-busy');
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByText('Loading PR review')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    act(() => endActivity());
  });

  it('shows error color without repeating the bottom status message', () => {
    const { container } = render(<TopLoadingBar />);
    act(() => beginActivity('Fetching'));
    act(() => failActivity('Network down'));
    const bar = container.firstChild;
    expect(bar).toHaveClass('is-error');
    expect(screen.queryByText('Network down')).toBeNull();
    act(() => clearActivityError());
  });

  it('fades out after completion then unmounts', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<TopLoadingBar />);
      act(() => beginActivity('Saving'));
      act(() => endActivity());
      // Still visible (fading) immediately after completion.
      expect(container.firstChild).not.toBeNull();
      act(() => vi.advanceTimersByTime(600));
      expect(container.firstChild).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

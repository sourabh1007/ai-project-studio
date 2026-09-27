import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReviewDuration } from './review-duration.js';

describe('review section duration', () => {
  it('shows live elapsed time, freezes at completion and hides unmeasured queue time', () => {
    const view = render(<ReviewDuration timing={null} now={10_000} />);
    expect(view.container.textContent).toBe('');
    view.rerender(<ReviewDuration timing={{ startedAt: 1000, finishedAt: null }} now={10_000} />);
    expect(screen.getByText('Review time: 9s elapsed')).toBeTruthy();
    view.rerender(<ReviewDuration timing={{ startedAt: 1000, finishedAt: 5000 }} now={10_000} />);
    expect(screen.getByText('Review time: 4s')).toBeTruthy();
  });
});

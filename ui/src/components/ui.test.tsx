import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './ui.js';

describe('StatusBadge', () => {
  it('renders an icon badge with an accessible status label', () => {
    render(<StatusBadge status="Running" />);

    const badge = screen.getByRole('img', { name: 'Running' });
    expect(badge).toBeInTheDocument();
    expect(badge.querySelector('svg')).toBeInTheDocument();
  });
});

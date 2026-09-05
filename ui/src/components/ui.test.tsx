import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button, StatusBadge } from './ui.js';

describe('StatusBadge', () => {
  it('renders a running state as an animated accent dot with a label', () => {
    render(<StatusBadge status="in_progress" />);

    const badge = screen.getByRole('img', { name: 'Running' });
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain('status-tone-running');
    expect(badge.className).toContain('is-animated');
    expect(badge.querySelector('.status-badge-dot.is-animated')).not.toBeNull();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('renders success/failure with an icon glyph and semantic tone', () => {
    const { rerender } = render(<StatusBadge status="done" />);
    let badge = screen.getByRole('img', { name: 'Completed' });
    expect(badge.className).toContain('status-tone-success');
    expect(badge.querySelector('svg')).toBeInTheDocument();

    rerender(<StatusBadge status="error" />);
    badge = screen.getByRole('img', { name: 'Failed' });
    expect(badge.className).toContain('status-tone-failed');
    expect(badge.querySelector('svg')).toBeInTheDocument();
  });

  it('supports a compact, label-free variant with an sr-only label', () => {
    render(
      <StatusBadge status="queued" showLabel={false} label="Waiting in queue" />,
    );
    const badge = screen.getByRole('img', { name: 'Waiting in queue' });
    expect(badge.className).toContain('is-compact');
    expect(badge.querySelector('.sr-only')?.textContent).toBe('Waiting in queue');
  });
});

describe('Button', () => {
  it('applies the requested variant', () => {
    render(<Button variant="danger">Delete</Button>);
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain(
      'btn-danger',
    );
  });

  it('shows a spinner and blocks interaction while loading', () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.querySelector('.spinner')).not.toBeNull();
  });
});

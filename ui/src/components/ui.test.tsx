import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button, Modal, StatusBadge } from './ui.js';

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

describe('Modal', () => {
  it('moves focus into the dialog and restores the launcher on close', () => {
    function Example() {
      const [open, setOpen] = React.useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>Launch</button>
          {open ? (
            <Modal title="Example modal" onClose={() => setOpen(false)}>
              <button type="button">Confirm</button>
            </Modal>
          ) : null}
        </div>
      );
    }

    render(<Example />);
    const launch = screen.getByRole('button', { name: 'Launch' });
    launch.focus();
    fireEvent.click(launch);

    const dialog = screen.getByRole('dialog', { name: 'Example modal' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(launch).toHaveFocus();
  });

  it('preserves an auto-focused field and restores the original external focus on close', () => {
    function Example({ open, onClose }: { open: boolean; onClose: () => void }) {
      return (
        <div>
          <input aria-label="External filter" />
          {open ? (
            <Modal title="Edit server" onClose={onClose}>
              <input aria-label="Server name" autoFocus />
            </Modal>
          ) : null}
        </div>
      );
    }

    const onClose = vi.fn();
    const view = render(<Example open={false} onClose={onClose} />);
    const external = screen.getByRole('textbox', { name: 'External filter' });
    external.focus();

    view.rerender(<Example open onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Edit server' });
    const field = screen.getByRole('textbox', { name: 'Server name' });
    expect(field).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    view.rerender(<Example open={false} onClose={onClose} />);
    expect(external).toHaveFocus();
  });

  it('lets only the topmost modal close on Escape and restores focus within the parent dialog', () => {
    function Example() {
      const [outerOpen, setOuterOpen] = React.useState(true);
      const [innerOpen, setInnerOpen] = React.useState(false);
      return (
        <>
          {outerOpen ? (
            <Modal title="Outer modal" onClose={() => setOuterOpen(false)}>
              <button type="button" onClick={() => setInnerOpen(true)}>
                Open nested modal
              </button>
              {innerOpen ? (
                <Modal title="Inner modal" onClose={() => setInnerOpen(false)}>
                  <button type="button">Inner action</button>
                </Modal>
              ) : null}
            </Modal>
          ) : null}
        </>
      );
    }

    render(<Example />);
    const openNested = screen.getByRole('button', { name: 'Open nested modal' });
    openNested.focus();
    fireEvent.click(openNested);

    const inner = screen.getByRole('dialog', { name: 'Inner modal' });
    fireEvent.keyDown(inner, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Inner modal' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Outer modal' })).toBeInTheDocument();
    expect(openNested).toHaveFocus();
  });
});

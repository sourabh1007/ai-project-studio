import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OverflowMenu } from './overflow-menu.js';

describe('OverflowMenu', () => {
  it('opens on trigger click and renders actions in a body portal', () => {
    render(
      <OverflowMenu
        actions={[
          { label: 'Rename', onSelect: vi.fn() },
          { label: 'Delete', danger: true, onSelect: vi.fn() },
        ]}
      />,
    );
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));

    const menu = screen.getByRole('menu');
    expect(menu.parentElement).toBe(document.body);
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
  });

  it('invokes the action and closes when an item is chosen', () => {
    const onSelect = vi.fn();
    render(<OverflowMenu actions={[{ label: 'Rename', onSelect }]} />);

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on outside pointer down and on Escape', () => {
    render(<OverflowMenu actions={[{ label: 'Rename', onSelect: vi.fn() }]} />);
    const trigger = screen.getByRole('button', { name: 'More actions' });

    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes when the page scrolls so the menu never detaches from its row', () => {
    render(<OverflowMenu actions={[{ label: 'Rename', onSelect: vi.fn() }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.scroll(window);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

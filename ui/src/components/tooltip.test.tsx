import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Tooltip } from './tooltip.js';

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('describes keyboard-focused controls, dismisses on Escape without dismissing the parent, and restores descriptions', () => {
  const parentKey = vi.fn();
  render(<div onKeyDown={parentKey}>
    <Tooltip label="Open side by side"><button aria-label="Split" aria-describedby="existing">Icon</button></Tooltip>
  </div>);
  const button = screen.getByRole('button');
  act(() => button.focus());
  const tooltip = screen.getByRole('tooltip');
  expect(button).toHaveAttribute('aria-describedby', `existing ${tooltip.id}`);
  fireEvent.keyDown(button, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  expect(button).toHaveAttribute('aria-describedby', 'existing');
  expect(parentKey).not.toHaveBeenCalled();
});

it('delays pointer tooltips, lets the pointer reach the bubble, and dismisses on scroll or blur', () => {
  vi.useFakeTimers();
  render(<Tooltip label="Details"><button>Info</button></Tooltip>);
  const button = screen.getByRole('button');
  fireEvent.mouseEnter(button);
  act(() => vi.advanceTimersByTime(299));
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  const bubble = screen.getByRole('tooltip');
  fireEvent.mouseLeave(button);
  fireEvent.mouseEnter(bubble);
  act(() => vi.advanceTimersByTime(200));
  expect(bubble).toBeInTheDocument();
  fireEvent.scroll(window);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  act(() => button.focus());
  expect(screen.getByRole('tooltip')).toBeInTheDocument();
  act(() => button.blur());
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
});

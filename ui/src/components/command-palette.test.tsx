import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommandPalette } from './command-palette.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--motion-overlay-duration');
  vi.useRealTimers();
});

it('links combobox selection to options, supports keyboard navigation and reports an empty result', () => {
  const run = vi.fn();
  const close = vi.fn();
  const commands = [
    { id: 'one', title: 'First command', run },
    { id: 'two', title: 'Second command', run },
  ];
  render(<CommandPalette open commands={commands} onClose={close} />);
  const search = screen.getByRole('combobox');
  expect(search).toHaveFocus();
  expect(search).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
  expect(search).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0].id);
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  expect(search).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1].id);
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(run).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  fireEvent.change(search, { target: { value: 'unmatched' } });
  expect(screen.getByRole('status')).toHaveTextContent('No matching commands');
  expect(search).not.toHaveAttribute('aria-activedescendant');
  expect(search).toHaveAttribute('aria-expanded', 'false');
});

it('supports pointer activation and retains focus ownership through a reversible close transition', () => {
  vi.useFakeTimers();
  document.documentElement.style.setProperty('--motion-overlay-duration', '200ms');
  const run = vi.fn();
  const close = vi.fn();
  const commands = [{ id: 'one', title: 'First command', run }];
  const view = render(<><button>Launcher</button><CommandPalette open={false} commands={commands} onClose={close} /></>);
  const launcher = screen.getByRole('button', { name: 'Launcher' });
  launcher.focus();
  view.rerender(<><button>Launcher</button><CommandPalette open commands={commands} onClose={close} /></>);
  fireEvent.click(screen.getByRole('option'));
  expect(run).toHaveBeenCalledOnce();
  view.rerender(<><button>Launcher</button><CommandPalette open={false} commands={commands} onClose={close} /></>);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(100));
  view.rerender(<><button>Launcher</button><CommandPalette open commands={commands} onClose={close} /></>);
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByRole('combobox')).toHaveFocus();
  view.rerender(<><button>Launcher</button><CommandPalette open={false} commands={commands} onClose={close} /></>);
  act(() => vi.advanceTimersByTime(200));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(launcher).toHaveFocus();
});

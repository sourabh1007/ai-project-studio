import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAnimatedPresence, useMotion } from './use-motion.js';
import { Disclosure } from '../components/disclosure.js';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-motion');
  document.documentElement.style.removeProperty('--motion-panel-duration');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('follows live OS and app preferences, with Off taking precedence', async () => {
  let change = () => {};
  const media = { matches: false, addEventListener: vi.fn((_event: string, listener: () => void) => { change = listener; }), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', () => media);
  function Example() { return <div>{useMotion()}</div>; }
  const view = render(<Example />);
  expect(screen.getByText('full')).toBeInTheDocument();
  act(() => { media.matches = true; change(); });
  expect(screen.getByText('reduced')).toBeInTheDocument();
  await act(async () => document.documentElement.setAttribute('data-motion', 'off'));
  expect(screen.getByText('off')).toBeInTheDocument();
  await act(async () => {
    media.matches = false;
    document.documentElement.setAttribute('data-motion', 'reduced');
  });
  expect(screen.getByText('reduced')).toBeInTheDocument();
  view.unmount();
  expect(media.removeEventListener).toHaveBeenCalled();
});

it.each(['220ms', '.22s'])('retains closing panels for %s, cancels reversed exits and follows motion changes', async (duration) => {
  vi.useFakeTimers();
  document.documentElement.style.setProperty('--motion-panel-duration', duration);
  const exited = vi.fn();
  function Example({ open }: { open: boolean }) {
    const { present, exiting } = useAnimatedPresence(open, '--motion-panel-duration', exited);
    return present ? <div>{exiting ? 'Closing' : 'Open'}</div> : null;
  }
  const view = render(<Example open />);
  view.rerender(<Example open={false} />);
  expect(screen.getByText('Closing')).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(100));
  view.rerender(<Example open />);
  act(() => vi.advanceTimersByTime(220));
  expect(screen.getByText('Open')).toBeInTheDocument();
  expect(exited).not.toHaveBeenCalled();
  view.rerender(<Example open={false} />);
  act(() => vi.advanceTimersByTime(220));
  expect(screen.queryByText('Closing')).not.toBeInTheDocument();
  expect(exited).toHaveBeenCalledTimes(1);
  view.rerender(<Example open />);
  view.rerender(<Example open={false} />);
  await act(async () => document.documentElement.setAttribute('data-motion', 'off'));
  expect(screen.queryByText('Closing')).not.toBeInTheDocument();
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps disclosure children inert during exit and preserves their content across reversal', () => {
  vi.useFakeTimers();
  document.documentElement.style.setProperty('--motion-panel-duration', '220ms');
  render(<Disclosure summary="Details"><input aria-label="Detail value" /></Disclosure>);
  const summary = screen.getByText('Details');
  const details = summary.closest('details')!;
  expect(details).not.toHaveAttribute('open');
  fireEvent.click(summary);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Preserved' } });
  fireEvent.click(summary);
  expect(summary).toHaveAttribute('aria-expanded', 'false');
  expect(details).toHaveAttribute('open');
  expect(input.closest('.disclosure-grid')).toHaveAttribute('inert');
  fireEvent.click(summary);
  expect(input).toHaveValue('Preserved');
  expect(input.closest('.disclosure-grid')).not.toHaveAttribute('inert');
  fireEvent.click(summary);
  act(() => vi.advanceTimersByTime(220));
  expect(details).not.toHaveAttribute('open');
});

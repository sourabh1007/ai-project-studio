import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { BrandedLoader, Loader, Spinner } from './loading.js';
import { ViewSkeleton } from './view-skeleton.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.removeAttribute('data-motion');
});

it('shows measured work without inventing a percentage for an unknown duration', () => {
  const view = render(<BrandedLoader title="Loading Explorer" detail="Reading sessions" />);
  const bar = screen.getByRole('progressbar', { name: 'Loading Explorer' });
  expect(bar).not.toHaveAttribute('aria-valuenow');
  expect(screen.getByText('Reading sessions')).toBeVisible();
  view.rerender(<BrandedLoader title="Loading Explorer" progress={{ completed: 2, total: 4 }} />);
  expect(bar).toHaveAttribute('aria-valuenow', '50');
  expect(bar).toHaveAttribute('aria-valuetext', '2 of 4 steps complete');
  expect(screen.getByText('2 of 4 steps complete (50%)')).toBeVisible();
  view.rerender(<BrandedLoader title="Loading Explorer" progress={{ completed: 9, total: 4 }} />);
  expect(bar).toHaveAttribute('aria-valuenow', '100');
  view.rerender(<BrandedLoader title="Loading Explorer" progress={{ completed: 0, total: 0 }} />);
  expect(bar).not.toHaveAttribute('aria-valuenow');
});

it('uses the same orbit and brand mark for inline, panel and lazy-screen loading', () => {
  const { container } = render(<><Spinner label="Saving" /><Loader label="Loading agents" /><ViewSkeleton label="skills" /></>);
  expect(container.querySelectorAll('.loading-mark')).toHaveLength(3);
  expect(container.querySelectorAll('.loading-mark > svg')).toHaveLength(3);
  expect(container.querySelectorAll('.branded-loader-orbit')).toHaveLength(6);
  expect(screen.getByRole('status', { name: 'Saving' })).toBeInTheDocument();
  expect(screen.getByText('Loading skills')).toBeVisible();
});

it('keeps elapsed time and measured progress readable with motion off and cleans up timers', () => {
  vi.useFakeTimers();
  document.documentElement.setAttribute('data-motion', 'off');
  const view = render(<BrandedLoader title="Reading tasks" hints={['One', 'Two']} progress={{ completed: 1, total: 3 }} />);
  act(() => vi.advanceTimersByTime(5000));
  expect(screen.getByRole('timer')).toHaveTextContent('5s elapsed');
  expect(screen.getByText('One')).toBeVisible();
  expect(screen.getByText('Animation is off: progress updates remain live')).toBeVisible();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33');
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps loaders animated and hints rotating under reduced motion, without the static note', () => {
  vi.useFakeTimers();
  document.documentElement.setAttribute('data-motion', 'reduced');
  try {
    render(<BrandedLoader title="Reading tasks" hints={['One', 'Two']} />);
    act(() => vi.advanceTimersByTime(2200));
    expect(screen.getByText('Two')).toBeVisible();
    expect(screen.queryByText(/progress updates remain live/)).toBeNull();
  } finally {
    document.documentElement.removeAttribute('data-motion');
  }
});

it('exempts only loading indicators from the reduced-motion freeze', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'app.css'), 'utf8');
  const media = css.slice(css.indexOf('/* Loading indicators are essential feedback'));
  expect(media).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s+:root:not\(\[data-motion='off'\]\) \.branded-loader-orbit \{\s+animation: loading-orbit [\d.]+s linear infinite !important;/);
  expect(media).toMatch(/:root\[data-motion='reduced'\] \.branded-loader-progress:not\(\.is-measured\) > span \{\s+animation: loading-sweep/);
  expect(media).not.toMatch(/branded-pulse[^;]*!important/);
});

it('does not reset hint rotation when an equivalent inline array is rendered again', () => {
  vi.useFakeTimers();
  const view = render(<BrandedLoader hints={['First hint', 'Second hint']} />);
  act(() => vi.advanceTimersByTime(2000));
  view.rerender(<BrandedLoader hints={['First hint', 'Second hint']} />);
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByText('Second hint')).toBeVisible();
});

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_UI_PREFERENCES } from '../../lib/ui-preferences.js';
import { AppearanceSection } from './appearance-section.js';

const hooks = vi.hoisted(() => ({
  modeCalls: [] as string[],
  prefsCalls: [] as Array<Record<string, unknown>>,
  resetCalls: [] as boolean[],
  theme: { mode: 'system' as const, theme: 'dark' as const },
  prefs: {
    appearance: 'desktop',
    accent: 'indigo',
    textSize: 'default',
    density: 'cozy',
    radius: 'soft',
    motion: 'full',
    font: 'system',
  },
}));

vi.mock('../../hooks/use-theme.js', () => ({
  useTheme: () => ({
    mode: hooks.theme.mode,
    theme: hooks.theme.theme,
    setMode: (mode: string) => hooks.modeCalls.push(mode),
  }),
}));

vi.mock('../../hooks/use-ui-preferences.js', () => ({
  useUiPreferences: () => ({
    prefs: { ...DEFAULT_UI_PREFERENCES, ...hooks.prefs },
    setPrefs: (next: Record<string, unknown>) => hooks.prefsCalls.push(next),
    reset: () => hooks.resetCalls.push(true),
  }),
}));

afterEach(() => {
  cleanup();
  hooks.modeCalls = [];
  hooks.prefsCalls = [];
  hooks.resetCalls = [];
  hooks.theme = { mode: 'system', theme: 'dark' };
  hooks.prefs = {
    appearance: 'desktop',
    accent: 'indigo',
    textSize: 'default',
    density: 'cozy',
    radius: 'soft',
    motion: 'full',
    font: 'system',
  };
});

it('renders the appearance heading by default and applies control changes', () => {
  render(<AppearanceSection />);
  expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Futuristic' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Clarity' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Blue' }));
  fireEvent.change(screen.getByLabelText('Accent color hex value'), { target: { value: '123456' } });
  fireEvent.change(screen.getByLabelText('Accent color hex value'), { target: { value: 'nope' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
  expect(hooks.modeCalls).toContain('light');
  expect(hooks.prefsCalls).toContainEqual({ accent: 'blue' });
  expect(hooks.prefsCalls).toContainEqual({ appearance: 'futuristic' });
  expect(hooks.prefsCalls).toContainEqual({ appearance: 'clarity' });
  expect(hooks.prefsCalls).not.toContainEqual(expect.objectContaining({ font: expect.anything() }));
  expect(hooks.prefsCalls).not.toContainEqual(expect.objectContaining({ textSize: expect.anything() }));
  expect(hooks.prefsCalls).toContainEqual({ accent: '#123456' });
  expect(hooks.resetCalls).toHaveLength(1);
});

it('renders appearance controls without the heading when embedded', () => {
  hooks.prefs = {
    appearance: 'futuristic',
    accent: '#111111',
    textSize: 'default',
    density: 'cozy',
    radius: 'soft',
    motion: 'full',
    font: 'system',
  };
  render(<AppearanceSection embedded />);
  expect(screen.queryByRole('heading', { name: 'Appearance' })).toBeNull();
  expect(screen.getByText('Theme')).toBeInTheDocument();
  expect(screen.getByText(/Personalize the look and feel/)).toBeInTheDocument();
  expect(screen.getByLabelText('Custom accent color')).toBeInTheDocument();
});

it('offers previewed IDE schemes, bundled fonts and console options', () => {
  render(<AppearanceSection />);
  for (const group of ['Look & colors', 'Typography', 'Layout & motion', 'Console', 'Planner quick-add']) {
    expect(screen.getByRole('region', { name: group })).toBeInTheDocument();
  }
  expect(screen.getByRole('radio', { name: 'IDE color scheme Studio default' })).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(screen.getByRole('radio', { name: 'IDE color scheme Dracula' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Interface font Chakra Petch (sci-fi)' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Code font Fira Code' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Console color scheme Matrix' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Terminal font VT323 (retro CRT)' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Terminal line spacing Relaxed' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Scheme default' }));
  expect(hooks.prefsCalls).toEqual([
    { palette: 'dracula' }, { font: 'sci-fi' }, { codeFont: 'fira-code' }, { terminalScheme: 'matrix' },
    { terminalFont: 'vt323' }, { terminalLineHeight: 'relaxed' }, { terminalTextColor: 'theme' },
  ]);
  const palette = document.querySelector('.palette-preview[data-palette="nord"]');
  expect(palette).toHaveAttribute('data-theme', 'dark');
  const matchIde = screen.getByRole('radio', { name: 'Console color scheme Match IDE' });
  expect(matchIde.querySelector('.scheme-preview')).toHaveStyle({ background: '#0a0f1e' });
});

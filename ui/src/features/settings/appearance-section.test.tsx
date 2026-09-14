import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppearanceSection } from './appearance-section.js';

const hooks = vi.hoisted(() => ({
  modeCalls: [] as string[],
  prefsCalls: [] as Array<Record<string, string>>,
  resetCalls: [] as boolean[],
  theme: { mode: 'system' as const, theme: 'dark' as const },
  prefs: {
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
    prefs: hooks.prefs,
    setPrefs: (next: Record<string, string>) => hooks.prefsCalls.push(next),
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
  fireEvent.click(screen.getByRole('radio', { name: 'Blue' }));
  fireEvent.change(screen.getByLabelText('Accent color hex value'), { target: { value: '123456' } });
  fireEvent.change(screen.getByLabelText('Accent color hex value'), { target: { value: 'nope' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
  expect(hooks.modeCalls).toContain('light');
  expect(hooks.prefsCalls).toContainEqual({ accent: 'blue' });
  expect(hooks.prefsCalls).toContainEqual({ accent: '#123456' });
  expect(hooks.resetCalls).toHaveLength(1);
});

it('renders appearance controls without the heading when embedded', () => {
  hooks.prefs = {
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

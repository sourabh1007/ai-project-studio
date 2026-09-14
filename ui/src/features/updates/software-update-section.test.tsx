import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SoftwareUpdateSection } from './software-update-section.js';

const updateHook = vi.hoisted(() => vi.fn());

vi.mock('../../hooks/use-app-updates.js', () => ({
  useAppUpdates: updateHook,
}));

afterEach(() => {
  cleanup();
  updateHook.mockReset();
});

function supportedState(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    state: {
      status: 'idle',
      currentVersion: '0.12.0',
      availableVersion: null,
      error: null,
      releaseNotes: null,
      ...overrides,
    },
    ui: {
      headline: 'You are up to date.',
      busy: false,
      canCheck: true,
      showProgress: false,
      progressPercent: 0,
      detail: null,
      canDownload: false,
      canInstall: false,
      autoInstall: true,
    },
    supported: true,
    check: vi.fn(),
    download: vi.fn(),
    install: vi.fn(),
  };
}

it('renders the software update heading by default', () => {
  updateHook.mockReturnValue(supportedState());
  render(<SoftwareUpdateSection />);
  expect(screen.getByRole('heading', { name: 'Software updates' })).toBeInTheDocument();
  expect(screen.getByText('v0.12.0')).toBeInTheDocument();
});

it('renders the supported update body without the heading when embedded', () => {
  const model = supportedState({
    status: 'checking',
    availableVersion: '0.13.0',
    error: 'network',
    releaseNotes: 'Fixes',
  });
  model.ui = {
    ...model.ui,
    headline: 'Checking for updates…',
    busy: true,
    canCheck: false,
    showProgress: true,
    progressPercent: 50,
    detail: 'Halfway there',
    canDownload: true,
    canInstall: true,
    autoInstall: false,
  };
  updateHook.mockReturnValue(model);
  render(<SoftwareUpdateSection embedded />);
  expect(screen.queryByRole('heading', { name: 'Software updates' })).toBeNull();
  expect(screen.getByText('Checking for updates…')).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  fireEvent.click(screen.getByRole('button', { name: 'Get update' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open release page' }));
  expect(model.download).toHaveBeenCalledTimes(1);
  expect(model.install).toHaveBeenCalledTimes(1);
});

it.each([false, true])('keeps the desktop-only update note visible when embedded=%s', (embedded) => {
  updateHook.mockReturnValue({ ...supportedState(), supported: false });
  render(<SoftwareUpdateSection embedded={embedded} />);
  expect(screen.getByText('Automatic updates are available in the desktop app.')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Software updates' }) === null).toBe(embedded);
});

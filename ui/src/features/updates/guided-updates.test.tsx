import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SoftwareUpdateSection } from './software-update-section.js';
import { UpdateBanner } from './update-banner.js';

afterEach(() => {
  cleanup();
  delete (window as unknown as { desktop?: unknown }).desktop;
});

it.each([
  ['settings', SoftwareUpdateSection],
  ['banner', UpdateBanner],
] as const)('labels guided updates honestly in %s and surfaces page-open failure', async (_name, Component) => {
  const install = vi.fn().mockRejectedValue(new Error('private path'));
  (window as unknown as { desktop: unknown }).desktop = { updates: {
    getState: async () => ({
      status: 'downloaded', availableVersion: '1.0.0', canAutoInstall: false,
    }),
    install,
    onEvent: () => () => {},
  } };
  render(<Component />);
  const open = await screen.findByRole('button', { name: 'Open release page' });
  expect(screen.queryByRole('button', { name: 'Restart & install' })).toBeNull();
  fireEvent.click(open);
  expect(await screen.findByText(/Could not open the release page/)).toBeInTheDocument();
  expect(screen.queryByText('private path')).toBeNull();
  expect(open).toBeEnabled();
  expect(install).toHaveBeenCalledTimes(1);
});

it.each([
  ['settings', SoftwareUpdateSection],
  ['banner', UpdateBanner],
] as const)('shows an animated installing phase with no dismiss/actions in %s', async (_name, Component) => {
  (window as unknown as { desktop: unknown }).desktop = { updates: {
    getState: async () => ({
      status: 'installing', availableVersion: '1.0.0', canAutoInstall: true, platform: 'win32',
    }),
    install: vi.fn(),
    download: vi.fn(),
    onEvent: () => () => {},
  } };
  render(<Component />);
  expect(await screen.findByText('Installing update…')).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'Installing update…' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Later' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Restart & install' })).toBeNull();
  expect(screen.getByText(/restart on its own/)).toBeInTheDocument();
});

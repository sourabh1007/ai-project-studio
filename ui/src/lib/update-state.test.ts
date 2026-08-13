import { describe, expect, it } from 'vitest';
import {
  initialUpdateState,
  mergeUpdateState,
  deriveUpdateUi,
  formatBytes,
  formatSpeed,
  type UpdateState,
} from './update-state.js';

function state(overrides: Partial<UpdateState> = {}): UpdateState {
  return { ...initialUpdateState(), ...overrides };
}

describe('initialUpdateState', () => {
  it('starts idle with empty fields', () => {
    expect(initialUpdateState()).toEqual({
      status: 'idle',
      currentVersion: null,
      availableVersion: null,
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
      releaseNotes: null,
      releaseName: null,
      error: null,
      canAutoInstall: false,
      platform: 'unknown',
      releasePageUrl: null,
    });
  });
});

describe('mergeUpdateState', () => {
  it('returns previous state when snapshot is missing', () => {
    const prev = state({ status: 'available' });
    expect(mergeUpdateState(prev, null)).toBe(prev);
    expect(mergeUpdateState(prev, undefined)).toBe(prev);
  });

  it('applies a full snapshot', () => {
    const next = mergeUpdateState(initialUpdateState(), {
      status: 'available',
      currentVersion: '0.8.6',
      availableVersion: '0.9.0',
      releaseNotes: 'notes',
      releaseName: 'v0.9.0',
      canAutoInstall: true,
      platform: 'win32',
      releasePageUrl: 'https://example.com',
    });
    expect(next.status).toBe('available');
    expect(next.currentVersion).toBe('0.8.6');
    expect(next.availableVersion).toBe('0.9.0');
    expect(next.releaseNotes).toBe('notes');
    expect(next.canAutoInstall).toBe(true);
    expect(next.platform).toBe('win32');
    expect(next.releasePageUrl).toBe('https://example.com');
  });

  it('keeps previous values for undefined fields and status', () => {
    const prev = state({
      status: 'available',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
      canAutoInstall: true,
      platform: 'win32',
    });
    const next = mergeUpdateState(prev, {});
    expect(next.status).toBe('available');
    expect(next.currentVersion).toBe('1.0.0');
    expect(next.availableVersion).toBe('1.1.0');
    expect(next.canAutoInstall).toBe(true);
    expect(next.platform).toBe('win32');
  });

  it('allows explicit null to clear a field', () => {
    const prev = state({ releaseNotes: 'old' });
    expect(mergeUpdateState(prev, { releaseNotes: null }).releaseNotes).toBeNull();
  });

  it('clamps percent and ignores non-finite numbers', () => {
    const prev = state({ percent: 40, total: 100 });
    expect(mergeUpdateState(prev, { percent: 150 }).percent).toBe(100);
    expect(mergeUpdateState(prev, { percent: -5 }).percent).toBe(0);
    expect(mergeUpdateState(prev, { percent: Number.NaN }).percent).toBe(0);
    expect(mergeUpdateState(prev, { total: Number.POSITIVE_INFINITY }).total).toBe(100);
    expect(mergeUpdateState(prev, { transferred: undefined }).transferred).toBe(0);
    expect(mergeUpdateState(prev, { transferred: 2048, bytesPerSecond: 512 })).toMatchObject({
      transferred: 2048,
      bytesPerSecond: 512,
    });
  });

  it('preserves an error only while in the error status', () => {
    const errored = mergeUpdateState(initialUpdateState(), {
      status: 'error',
      error: 'boom',
    });
    expect(errored.error).toBe('boom');

    // A follow-up error snapshot without an error message keeps the prior one.
    const stillErrored = mergeUpdateState(errored, { status: 'error' });
    expect(stillErrored.error).toBe('boom');

    // Moving to a non-error status clears the error.
    const recovered = mergeUpdateState(errored, { status: 'checking' });
    expect(recovered.error).toBeNull();

    // A non-error snapshot may still carry an explicit error value.
    const withError = mergeUpdateState(initialUpdateState(), {
      status: 'available',
      error: 'stale',
    });
    expect(withError.error).toBe('stale');
  });
});

describe('deriveUpdateUi', () => {
  it('hides the banner when idle', () => {
    const ui = deriveUpdateUi(initialUpdateState());
    expect(ui.showBanner).toBe(false);
    expect(ui.headline).toBe('Up to date');
    expect(ui.tone).toBe('info');
    expect(ui.canCheck).toBe(true);
    expect(ui.busy).toBe(false);
  });

  it('describes the checking state', () => {
    const ui = deriveUpdateUi(state({ status: 'checking' }));
    expect(ui.headline).toBe('Checking for updates…');
    expect(ui.canCheck).toBe(false);
    expect(ui.busy).toBe(true);
    expect(ui.showBanner).toBe(false);
  });

  it('describes an available update on Windows (auto-install)', () => {
    const ui = deriveUpdateUi(
      state({ status: 'available', availableVersion: '0.9.0', canAutoInstall: true }),
    );
    expect(ui.showBanner).toBe(true);
    expect(ui.headline).toBe('Update available — v0.9.0');
    expect(ui.canDownload).toBe(true);
    expect(ui.canInstall).toBe(false);
    expect(ui.autoInstall).toBe(true);
    expect(ui.detail).toBeNull();
  });

  it('falls back to a generic headline when no version is known', () => {
    const ui = deriveUpdateUi(state({ status: 'available', canAutoInstall: true }));
    expect(ui.headline).toBe('Update available');
  });

  it('offers guided install for an available update on macOS (no auto-install)', () => {
    const ui = deriveUpdateUi(
      state({ status: 'available', availableVersion: '0.9.0', canAutoInstall: false }),
    );
    expect(ui.canInstall).toBe(true);
    expect(ui.autoInstall).toBe(false);
    expect(ui.detail).toBe('Downloads the installer — finish the guided install to update.');
  });

  it('shows progress while downloading with byte detail', () => {
    const ui = deriveUpdateUi(
      state({
        status: 'downloading',
        percent: 42.6,
        transferred: 1024 * 1024,
        total: 4 * 1024 * 1024,
        bytesPerSecond: 512 * 1024,
      }),
    );
    expect(ui.headline).toBe('Downloading update… 43%');
    expect(ui.showProgress).toBe(true);
    expect(ui.progressPercent).toBe(43);
    expect(ui.busy).toBe(true);
    expect(ui.canCheck).toBe(false);
    expect(ui.detail).toBe('1 MB of 4 MB · 512 KB/s');
  });

  it('omits byte detail while downloading with unknown total', () => {
    const ui = deriveUpdateUi(state({ status: 'downloading', releaseName: 'v0.9.0' }));
    expect(ui.detail).toBe('v0.9.0');
  });

  it('marks a downloaded update ready to install', () => {
    const ui = deriveUpdateUi(
      state({ status: 'downloaded', availableVersion: '0.9.0', canAutoInstall: true }),
    );
    expect(ui.headline).toBe('Update ready — v0.9.0');
    expect(ui.tone).toBe('success');
    expect(ui.canInstall).toBe(true);
    expect(ui.showBanner).toBe(true);
  });

  it('uses a generic ready headline without a version', () => {
    const ui = deriveUpdateUi(state({ status: 'downloaded', canAutoInstall: true }));
    expect(ui.headline).toBe('Update ready to install');
  });

  it('reports the up-to-date state without a banner', () => {
    const ui = deriveUpdateUi(state({ status: 'not-available' }));
    expect(ui.headline).toBe("You're up to date");
    expect(ui.showBanner).toBe(false);
  });

  it('surfaces errors, showing the banner only mid-update', () => {
    const quiet = deriveUpdateUi(state({ status: 'error', error: 'net down' }));
    expect(quiet.showBanner).toBe(false);
    expect(quiet.tone).toBe('danger');
    expect(quiet.detail).toBe('net down');

    const loud = deriveUpdateUi(
      state({ status: 'error', availableVersion: '0.9.0', error: null }),
    );
    expect(loud.showBanner).toBe(true);
    expect(loud.headline).toBe('Update failed');
    expect(loud.detail).toBe('Something went wrong while updating.');
  });
});

describe('formatBytes / formatSpeed', () => {
  it('formats byte magnitudes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatBytes(3 * 1024 ** 4)).toBe('3 TB');
    expect(formatBytes(2 * 1024 ** 5)).toBe('2048 TB');
  });

  it('formats speed with a per-second suffix', () => {
    expect(formatSpeed(1024 * 1024)).toBe('1 MB/s');
  });
});

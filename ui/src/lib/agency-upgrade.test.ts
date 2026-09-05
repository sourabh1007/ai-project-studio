import { describe, it, expect } from 'vitest';
import { deriveAgencyUpgradeUi } from './agency-upgrade.js';

describe('deriveAgencyUpgradeUi', () => {
  it('reports not-installed when agency is missing', () => {
    const ui = deriveAgencyUpgradeUi({ installed: false });
    expect(ui.tone).toBe('muted');
    expect(ui.headline).toBe('Agency CLI not installed');
    expect(ui.busy).toBe(false);
  });

  it('treats null/undefined status as not installed and idle', () => {
    expect(deriveAgencyUpgradeUi(null).phase).toBe('idle');
    expect(deriveAgencyUpgradeUi(undefined).headline).toBe(
      'Agency CLI not installed',
    );
  });

  it('shows an installed idle state before any upgrade runs', () => {
    const ui = deriveAgencyUpgradeUi({ installed: true });
    expect(ui.phase).toBe('idle');
    expect(ui.tone).toBe('muted');
    expect(ui.headline).toBe('Agency CLI installed');
    expect(ui.busy).toBe(false);
  });

  it('marks busy while upgrading', () => {
    const ui = deriveAgencyUpgradeUi({
      installed: true,
      upgrade: { phase: 'upgrading' },
    });
    expect(ui.busy).toBe(true);
    expect(ui.tone).toBe('info');
    expect(ui.headline).toBe('Updating Agency CLI…');
  });

  it('shows success when the upgrade completes', () => {
    const ui = deriveAgencyUpgradeUi({
      installed: true,
      upgrade: { phase: 'done' },
    });
    expect(ui.tone).toBe('success');
    expect(ui.headline).toBe('Agency CLI is up to date');
  });

  it('surfaces the failure message on error', () => {
    const ui = deriveAgencyUpgradeUi({
      installed: true,
      upgrade: { phase: 'error', message: 'exit code 1' },
    });
    expect(ui.tone).toBe('danger');
    expect(ui.detail).toBe('exit code 1');
  });

  it('falls back to a generic error detail when no message is given', () => {
    const ui = deriveAgencyUpgradeUi({
      installed: true,
      upgrade: { phase: 'error' },
    });
    expect(ui.detail).toBe('The last upgrade attempt failed.');
  });
});

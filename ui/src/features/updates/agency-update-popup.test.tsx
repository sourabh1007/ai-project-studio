import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import { createApiClient } from '../../lib/api.js';
import type { AgencyStatus } from '../../lib/types.js';
import { AgencyUpdatePopup } from './agency-update-popup.js';

function mount(probe: () => Promise<AgencyStatus>) {
  const api = createApiClient();
  const status = vi.spyOn(api, 'getAgencyStatus').mockImplementation(probe);
  const view = render(
    <ApiProvider value={api}>
      <AgencyUpdatePopup />
    </ApiProvider>,
  );
  return { status, ...view };
}

const flush = () => act(async () => {});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AgencyUpdatePopup', () => {
  it('shows the popup when an update was applied', async () => {
    mount(async () => ({
      installed: true,
      upgrade: {
        phase: 'done',
        updated: true,
        version: '1.1.0',
        previousVersion: '1.0.0',
      },
    }));
    await flush();
    expect(screen.getByText('Agency CLI updated')).toBeTruthy();
    expect(screen.getByText('Updated from 1.0.0 to 1.1.0.')).toBeTruthy();
  });

  it('renders nothing on a no-op upgrade', async () => {
    const { container } = mount(async () => ({
      installed: true,
      upgrade: { phase: 'done', updated: false },
    }));
    await flush();
    expect(container.firstChild).toBeNull();
  });

  it('polls while upgrading then shows the popup when it settles', async () => {
    let phase: AgencyStatus = {
      installed: true,
      upgrade: { phase: 'upgrading' },
    };
    mount(async () => phase);
    await flush();
    expect(screen.queryByText('Agency CLI updated')).toBeNull();

    phase = { installed: true, upgrade: { phase: 'done', updated: true, version: '2.0.0' } };
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await flush();
    expect(screen.getByText('Agency CLI updated')).toBeTruthy();
  });

  it('can be dismissed', async () => {
    mount(async () => ({
      installed: true,
      upgrade: { phase: 'done', updated: true, version: '1.1.0' },
    }));
    await flush();
    fireEvent.click(screen.getByLabelText('Dismiss Agency update notification'));
    expect(screen.queryByText('Agency CLI updated')).toBeNull();
  });

  it('ignores a rejected status probe', async () => {
    const { container } = mount(async () => {
      throw new Error('offline');
    });
    await flush();
    expect(container.firstChild).toBeNull();
  });
});

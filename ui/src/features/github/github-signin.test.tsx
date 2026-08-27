import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { DeviceCodeStart, DevicePollResult } from '../../lib/types.js';
import { GithubSignInModal } from './github-signin.js';

const startCode: DeviceCodeStart = {
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  deviceCode: 'dev-code-1',
  interval: 5,
  expiresIn: 900,
};

function makeClient(
  overrides: Partial<Pick<ApiClient, 'githubSignInStart' | 'githubSignInPoll'>>,
): ApiClient {
  return {
    githubSignInStart: vi.fn().mockResolvedValue(startCode),
    githubSignInPoll: vi.fn().mockResolvedValue({ status: 'pending' }),
    ...overrides,
  } as unknown as ApiClient;
}

function renderModal(
  client: ApiClient,
  props: Partial<{ onClose: () => void; onAuthenticated: () => void }> = {},
) {
  return render(
    <ApiProvider value={client}>
      <GithubSignInModal
        onClose={props.onClose ?? (() => {})}
        onAuthenticated={props.onAuthenticated ?? (() => {})}
      />
    </ApiProvider>,
  );
}

describe('GithubSignInModal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // window.open is called to launch the verification page.
    vi.spyOn(window, 'open').mockReturnValue(null);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows the device code and opens the verification page', async () => {
    const client = makeClient({});
    renderModal(client);
    // Let start() resolve and the awaiting phase render.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
    expect(window.open).toHaveBeenCalledWith(
      'https://github.com/login/device',
      '_blank',
      'noopener,noreferrer',
    );
    expect(client.githubSignInStart).toHaveBeenCalledTimes(1);
  });

  it('polls until success and then calls onAuthenticated', async () => {
    const poll = vi
      .fn<() => Promise<DevicePollResult>>()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'success' });
    const client = makeClient({ githubSignInPoll: poll });
    const onAuthenticated = vi.fn();
    renderModal(client, { onAuthenticated });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // First poll after one interval → pending.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(poll).toHaveBeenCalledTimes(1);
    // Second poll → success, then an 800ms success pause before the callback.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(poll).toHaveBeenCalledTimes(2);
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Signed in')).toBeTruthy();
  });

  it('does NOT restart the flow when the parent re-renders with a new callback (hang regression)', async () => {
    const poll = vi
      .fn<() => Promise<DevicePollResult>>()
      .mockResolvedValue({ status: 'pending' });
    const client = makeClient({ githubSignInPoll: poll });
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderModal(client, { onAuthenticated: first });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.githubSignInStart).toHaveBeenCalledTimes(1);

    // Parent re-renders passing a brand-new onAuthenticated closure — exactly
    // what the GitHub status badge does on its 30s status re-check.
    rerender(
      <ApiProvider value={client}>
        <GithubSignInModal onClose={() => {}} onAuthenticated={second} />
      </ApiProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The device flow must NOT have restarted (no second start() call).
    expect(client.githubSignInStart).toHaveBeenCalledTimes(1);

    // And when it does succeed, the LATEST callback is used (ref, not stale).
    poll.mockResolvedValueOnce({ status: 'success' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('surfaces a start() failure as an error the user can retry', async () => {
    const client = makeClient({
      githubSignInStart: vi
        .fn()
        .mockRejectedValue(new Error('Could not reach GitHub')),
    });
    renderModal(client);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Could not reach GitHub')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('shows the message when polling returns an error', async () => {
    const poll = vi
      .fn<() => Promise<DevicePollResult>>()
      .mockResolvedValue({ status: 'error', message: 'Sign-in was cancelled.' });
    const client = makeClient({ githubSignInPoll: poll });
    renderModal(client);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText('Sign-in was cancelled.')).toBeTruthy();
  });

  it('slows its polling cadence when GitHub asks it to', async () => {
    const poll = vi
      .fn<() => Promise<DevicePollResult>>()
      .mockResolvedValueOnce({ status: 'pending', slowDown: true })
      .mockResolvedValue({ status: 'pending' });
    const client = makeClient({ githubSignInPoll: poll });
    renderModal(client);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // First poll at 5s asks us to slow down (+5s → next at 10s).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(poll).toHaveBeenCalledTimes(1);
    // 5s more is not enough for the widened 10s interval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('reports expiry when the code lapses before authorization', async () => {
    const client = makeClient({
      githubSignInStart: vi
        .fn()
        .mockResolvedValue({ ...startCode, interval: 5, expiresIn: 6 }),
    });
    renderModal(client);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // One poll at 5s (pending), then the 6s deadline passes → expired error.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(
      screen.getByText(/expired before sign-in completed/i),
    ).toBeTruthy();
  });

  it('stops polling once the modal is closed/unmounted', async () => {
    const poll = vi
      .fn<() => Promise<DevicePollResult>>()
      .mockResolvedValue({ status: 'pending' });
    const client = makeClient({ githubSignInPoll: poll });
    const { unmount } = renderModal(client);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(poll).not.toHaveBeenCalled();
  });
});

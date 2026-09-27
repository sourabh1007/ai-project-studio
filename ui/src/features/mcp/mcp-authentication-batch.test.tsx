import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { McpAuthenticationJob, McpServerEntry } from '../../lib/types.js';
import { McpAuthenticationBatch } from './mcp-authentication-batch.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function server(name: string, overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return { name, builtinName: name, spec: {}, enabled: true, ...overrides };
}

function inspected(name: string, status: 'ok' | 'failed' | 'skipped' = 'ok', authRequired = false, supported = true): McpServerEntry {
  return server(name, {
    toolDiscovery: { status, authRequired, message: null, output: [] },
    authentication: { supported, reason: supported ? null : 'Native continuation unavailable.' },
    tools: status === 'ok' ? [{ name: 'read', description: null, enabled: true }] : [],
  });
}

function job(name: string, overrides: Partial<McpAuthenticationJob> = {}): McpAuthenticationJob {
  return {
    id: `${name}-job`, serverName: name, status: 'pending', message: `Waiting for ${name}`,
    authUrl: 'https://login.example.test/device', deviceCode: 'CODE-123',
    expiresAt: new Date(Date.now() + 120_000).toISOString(), ...overrides,
  };
}

function mount(servers: McpServerEntry[], overrides: Partial<ApiClient> = {}, strict = false) {
  const api = {
    inspectMcpServer: vi.fn(async (_provider: string, name: string) => inspected(name)),
    startMcpAuthentication: vi.fn(async (_provider: string, name: string) => job(name)),
    getMcpAuthentication: vi.fn(async (_provider: string, name: string) => job(name)),
    cancelMcpAuthentication: vi.fn(async (_provider: string, name: string) => job(name, { status: 'cancelled', message: 'Cancelled.' })),
    ...overrides,
  } as unknown as ApiClient;
  const onClose = vi.fn();
  const onOpenAuth = vi.fn();
  const onBackgroundError = vi.fn();
  const component = <ApiProvider value={api}><McpAuthenticationBatch providerId="agency" servers={servers}
    onClose={onClose} onOpenAuth={onOpenAuth} onBackgroundError={onBackgroundError} /></ApiProvider>;
  const result = render(strict ? <StrictMode>{component}</StrictMode> : component);
  return { ...result, api, onClose, onOpenAuth, onBackgroundError };
}

async function finishChecks() {
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop checking' })).not.toBeInTheDocument());
}

async function beginAuthentication() {
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reauthenticate required servers' })); });
}

async function tick() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
}

function resultRow(name: string) {
  return within(screen.getByRole('list', { name: 'Server check results' }))
    .getByText(name).closest('li')!;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('McpAuthenticationBatch', () => {
  it('checks sequentially, publishes each row immediately, and skips disabled/catalog/custom servers', async () => {
    const first = deferred<McpServerEntry>();
    const second = deferred<McpServerEntry>();
    const inspect = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { api } = mount([
      server('one'), server('two'), server('disabled', { enabled: false }),
      server('catalog', { catalog: true }), server('custom', { builtinName: undefined }),
    ], { inspectMcpServer: inspect });
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    expect(resultRow('one')).toHaveTextContent('Checking');
    expect(resultRow('two')).toHaveTextContent('Queued');
    expect(resultRow('disabled')).toHaveTextContent('Disabled');
    expect(screen.queryByText('catalog')).not.toBeInTheDocument();
    expect(screen.queryByText('custom')).not.toBeInTheDocument();
    await act(async () => { first.resolve(inspected('one')); });
    expect(inspect).toHaveBeenNthCalledWith(2, 'agency', 'two');
    expect(resultRow('one')).toHaveTextContent('Tool access verified');
    expect(resultRow('two')).toHaveTextContent('Checking');
    expect(screen.getByText(/1 of 2 checks finished/)).toBeInTheDocument();
    await act(async () => { second.resolve(inspected('two', 'failed', true)); });
    await finishChecks();
    expect(api.startMcpAuthentication).not.toHaveBeenCalled();
    expect(screen.getByText(/1 tool access verified · 1 sign-in required · 0 unknown/)).toBeInTheDocument();
  });

  it('does not infer authentication from failed, skipped, or rejected probes', async () => {
    const inspect = vi.fn()
      .mockRejectedValueOnce(new Error('Timed out'))
      .mockResolvedValueOnce(inspected('failed', 'failed'))
      .mockResolvedValueOnce(inspected('skipped', 'skipped'));
    const { api, onBackgroundError } = mount(
      [server('timeout'), server('failed'), server('skipped')], { inspectMcpServer: inspect },
    );
    await finishChecks();
    expect(resultRow('timeout')).toHaveTextContent('Check failed — access unknown');
    expect(resultRow('skipped')).toHaveTextContent('Unknown');
    expect(screen.getByText(/0 sign-in required · 3 unknown/)).toBeInTheDocument();
    expect(onBackgroundError).toHaveBeenCalledWith('timeout: Timed out');
    expect(screen.getByRole('button', { name: 'Reauthenticate required servers' })).toBeDisabled();
    expect(api.startMcpAuthentication).not.toHaveBeenCalled();
  });

  it('does not authenticate from stale configuration challenges when the check fails', async () => {
    const { api } = mount([inspected('one', 'failed', true)], {
      inspectMcpServer: vi.fn().mockRejectedValue(new Error('Probe unavailable')),
    });
    await finishChecks();
    expect(screen.getByRole('button', { name: 'Reauthenticate required servers' })).toBeDisabled();
    expect(api.startMcpAuthentication).not.toHaveBeenCalled();
  });

  it('handles an empty configured set without network activity', async () => {
    const { api } = mount([server('catalog', { catalog: true })]);
    await finishChecks();
    expect(screen.getByText('No configured Agency servers to check.')).toBeInTheDocument();
    expect(api.inspectMcpServer).not.toHaveBeenCalled();
    expect(api.startMcpAuthentication).not.toHaveBeenCalled();
  });

  it('stops queued checks and ignores an in-flight result without claiming a completed check', async () => {
    const pending = deferred<McpServerEntry>();
    const inspect = vi.fn().mockReturnValue(pending.promise);
    mount([server('one'), server('two')], { inspectMcpServer: inspect });
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Stop checking' }));
    await act(async () => { pending.resolve(inspected('one', 'failed', true)); });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(resultRow('one')).toHaveTextContent('Unknown');
    expect(resultRow('two')).toHaveTextContent('Unknown');
    expect(screen.getByText(/0 of 2 checks finished/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reauthenticate required servers' })).toBeDisabled();
  });

  it('starts only supported observed challenges on explicit click and verifies each server before the next', async () => {
    const inspect = vi.fn(async (_provider: string, name: string) => inspected(
      name, name === 'verified' ? 'ok' : 'failed', name !== 'verified', name !== 'unsupported',
    ));
    const get = vi.fn(async (_provider: string, name: string) => job(name, { status: 'completed', server: inspected(name) }));
    const { api, onOpenAuth } = mount(
      ['one', 'unsupported', 'verified', 'two'].map((name) => server(name)), { inspectMcpServer: inspect, getMcpAuthentication: get },
    );
    await finishChecks();
    expect(api.startMcpAuthentication).not.toHaveBeenCalled();
    await beginAuthentication();
    expect(api.startMcpAuthentication).toHaveBeenCalledTimes(1);
    expect(api.startMcpAuthentication).toHaveBeenLastCalledWith('agency', 'one');
    expect(screen.getByText('CODE-123')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open sign-in page' }));
    expect(onOpenAuth).toHaveBeenCalledWith('https://login.example.test/device');
    await tick();
    expect(resultRow('one')).toHaveTextContent('Tool access verified');
    expect(api.startMcpAuthentication).toHaveBeenCalledTimes(2);
    expect(api.startMcpAuthentication).toHaveBeenLastCalledWith('agency', 'two');
    expect(screen.getByText('1 of 2 sign-ins verified.')).toBeInTheDocument();
    await tick();
    expect(screen.getByText('2 of 2 sign-ins verified.')).toBeInTheDocument();
    expect(screen.queryByText('CODE-123')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open sign-in page' })).not.toBeInTheDocument();
    expect(screen.getByText(/3 tool access verified · 1 sign-in required · 0 unknown/)).toBeInTheDocument();
    expect(api.cancelMcpAuthentication).not.toHaveBeenCalled();
  });

  it('avoids duplicate reads and auth starts under StrictMode and repeated clicks', async () => {
    const pending = deferred<McpAuthenticationJob>();
    const { api } = mount([server('one')], {
      inspectMcpServer: vi.fn().mockResolvedValue(inspected('one', 'failed', true)),
      startMcpAuthentication: vi.fn().mockReturnValue(pending.promise),
    }, true);
    await finishChecks();
    expect(api.inspectMcpServer).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    const button = screen.getByRole('button', { name: 'Reauthenticate required servers' });
    await act(async () => { fireEvent.click(button); fireEvent.click(button); });
    expect(api.startMcpAuthentication).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(job('one')); });
    expect(screen.getByText('CODE-123')).toBeInTheDocument();
    expect(api.cancelMcpAuthentication).not.toHaveBeenCalled();
  });

  it.each([
    'http://login.example.test', 'javascript:alert(1)', 'https://user:password@login.example.test', 'not a URL',
  ])('does not open unsafe sign-in URL %s', async (authUrl) => {
    const { onOpenAuth } = mount([server('one')], {
      inspectMcpServer: vi.fn().mockResolvedValue(inspected('one', 'failed', true)),
      startMcpAuthentication: vi.fn().mockResolvedValue(job('one', { authUrl })),
    });
    await finishChecks();
    await beginAuthentication();
    expect(screen.queryByRole('button', { name: 'Open sign-in page' })).not.toBeInTheDocument();
    expect(onOpenAuth).not.toHaveBeenCalled();
    expect(screen.getByText(/could not be opened safely/)).toBeInTheDocument();
  });

  it('never shows probe auth links or expired job prompts and does not proceed to another server', async () => {
    const expiry = new Date(Date.now() + 500).toISOString();
    const { api } = mount([server('one'), server('two')], {
      inspectMcpServer: vi.fn(async (_provider: string, name: string): Promise<McpServerEntry> => ({
        ...inspected(name, 'failed', true),
        toolDiscovery: { status: 'failed', authRequired: true, authUrl: 'https://old.example.test', message: null, output: [] },
      })),
      startMcpAuthentication: vi.fn().mockResolvedValue(job('one', { expiresAt: expiry })),
    });
    await finishChecks();
    expect(screen.queryByRole('button', { name: 'Open sign-in page' })).not.toBeInTheDocument();
    await beginAuthentication();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.queryByText('CODE-123')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open sign-in page' })).not.toBeInTheDocument();
    expect(screen.getByText(/Sign-in expired. Access is not confirmed. Cancel/)).toBeInTheDocument();
    expect(api.startMcpAuthentication).toHaveBeenCalledTimes(1);
  });

  it('hides prompts immediately on cancel and stops the queue even if cancellation reports completion', async () => {
    const cancel = deferred<McpAuthenticationJob>();
    const { api } = mount([server('one'), server('two')], {
      inspectMcpServer: vi.fn(async (_provider: string, name: string) => inspected(name, 'failed', true)),
      cancelMcpAuthentication: vi.fn().mockReturnValue(cancel.promise),
    });
    await finishChecks();
    await beginAuthentication();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop reauthentication' })); });
    expect(screen.queryByText('CODE-123')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open sign-in page' })).not.toBeInTheDocument();
    await act(async () => { cancel.resolve(job('one', { status: 'completed', server: inspected('one') })); });
    expect(api.startMcpAuthentication).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Reauthenticate required servers' })).toBeEnabled();
  });

  it('keeps cancellation failures explicit without starting the next server', async () => {
    const { api, onBackgroundError } = mount([server('one'), server('two')], {
      inspectMcpServer: vi.fn(async (_provider: string, name: string) => inspected(name, 'failed', true)),
      cancelMcpAuthentication: vi.fn().mockRejectedValue(new Error('Cancel offline')),
    });
    await finishChecks();
    await beginAuthentication();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop reauthentication' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('Cancellation was not confirmed');
    expect(onBackgroundError).toHaveBeenCalledWith(expect.stringContaining('Cancel offline'));
    expect(screen.queryByText('CODE-123')).not.toBeInTheDocument();
    expect(api.startMcpAuthentication).toHaveBeenCalledTimes(1);
  });

  it('ends a cancelled attempt without exposing its retained URL or device code', async () => {
    const { api } = mount([server('one'), server('two')], {
      inspectMcpServer: vi.fn(async (_provider: string, name: string) => inspected(name, 'failed', true)),
    });
    await finishChecks();
    await beginAuthentication();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop reauthentication' })); });
    expect(api.cancelMcpAuthentication).toHaveBeenCalledWith('agency', 'one', 'one-job');
    expect(resultRow('one')).toHaveTextContent('Cancelled.');
    expect(screen.queryByText('CODE-123')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open sign-in page' })).not.toBeInTheDocument();
    expect(api.startMcpAuthentication).toHaveBeenCalledTimes(1);
  });

  it('stops after a failed job, surfaces the error, and retries only after another explicit click', async () => {
    const { api, onBackgroundError } = mount([server('one'), server('two')], {
      inspectMcpServer: vi.fn(async (_provider: string, name: string) => inspected(name, 'failed', true)),
      getMcpAuthentication: vi.fn().mockResolvedValue(job('one', { status: 'failed', message: 'Permission denied.' })),
    });
    await finishChecks();
    await beginAuthentication();
    await tick();
    expect(onBackgroundError).toHaveBeenCalledWith(expect.stringContaining('Permission denied.'));
    expect(resultRow('one')).toHaveTextContent('Permission denied.');
    expect(screen.queryByText('CODE-123')).not.toBeInTheDocument();
    expect(api.startMcpAuthentication).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reauthenticate required servers' })); });
    expect(api.startMcpAuthentication).toHaveBeenCalledTimes(2);
    expect(api.startMcpAuthentication).toHaveBeenLastCalledWith('agency', 'one');
  });

  it('surfaces a start failure without claiming success or automatically retrying', async () => {
    const { api, onBackgroundError } = mount([server('one')], {
      inspectMcpServer: vi.fn().mockResolvedValue(inspected('one', 'failed', true)),
      startMcpAuthentication: vi.fn().mockRejectedValue(new Error('Start offline')),
    });
    await finishChecks();
    await beginAuthentication();
    expect(screen.getByRole('alert')).toHaveTextContent('Start offline');
    expect(onBackgroundError).toHaveBeenCalledWith(expect.stringContaining('Start offline'));
    await tick();
    expect(api.startMcpAuthentication).toHaveBeenCalledTimes(1);
    expect(screen.getByText('0 of 1 sign-ins verified.')).toBeInTheDocument();
  });

  it('offers manual status retry after a network error without another auth mutation', async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error('Poll offline'))
      .mockResolvedValueOnce(job('one', { status: 'completed', server: inspected('one') }));
    const { api, onBackgroundError } = mount([server('one')], {
      inspectMcpServer: vi.fn().mockResolvedValue(inspected('one', 'failed', true)),
      getMcpAuthentication: get,
    });
    await finishChecks();
    await beginAuthentication();
    await tick();
    expect(screen.getByRole('alert')).toHaveTextContent('Poll offline');
    expect(onBackgroundError).toHaveBeenCalledWith(expect.stringContaining('Poll offline'));
    await tick();
    expect(get).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry status' }));
    await tick();
    expect(screen.getByText('1 of 1 sign-ins verified.')).toBeInTheDocument();
    expect(api.startMcpAuthentication).toHaveBeenCalledTimes(1);
  });

  it('does not count completion without verified inventory as success', async () => {
    const { api, onBackgroundError } = mount([server('one'), server('two')], {
      inspectMcpServer: vi.fn(async (_provider: string, name: string) => inspected(name, 'failed', true)),
      startMcpAuthentication: vi.fn().mockResolvedValue(job('one', { status: 'completed' })),
    });
    await finishChecks();
    await beginAuthentication();
    expect(api.startMcpAuthentication).toHaveBeenCalledTimes(1);
    expect(resultRow('one')).toHaveTextContent('without a verified tool inventory');
    expect(onBackgroundError).toHaveBeenCalledWith(expect.stringContaining('without a verified tool inventory'));
    expect(screen.getByText('0 of 2 sign-ins verified.')).toBeInTheDocument();
    expect(screen.queryByText('CODE-123')).not.toBeInTheDocument();
  });

  it('does not continue from an inconsistent completed result with failed inventory', async () => {
    const { api, onBackgroundError } = mount([server('one'), server('two')], {
      inspectMcpServer: vi.fn(async (_provider: string, name: string) => inspected(name, 'failed', true)),
      startMcpAuthentication: vi.fn().mockResolvedValue(job('one', { status: 'completed', server: inspected('one', 'failed') })),
    });
    await finishChecks();
    await beginAuthentication();
    expect(api.startMcpAuthentication).toHaveBeenCalledTimes(1);
    expect(screen.getByText('0 of 2 sign-ins verified.')).toBeInTheDocument();
    expect(onBackgroundError).toHaveBeenCalledWith(expect.stringContaining('did not return a verified tool inventory'));
    expect(resultRow('one')).toHaveTextContent('access unknown');
  });

  it('closes immediately, cancels the pending job, and ignores late poll results', async () => {
    const poll = deferred<McpAuthenticationJob>();
    const { api, onClose } = mount([server('one'), server('two')], {
      inspectMcpServer: vi.fn(async (_provider: string, name: string) => inspected(name, 'failed', true)),
      getMcpAuthentication: vi.fn().mockReturnValue(poll.promise),
    });
    await finishChecks();
    await beginAuthentication();
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(api.cancelMcpAuthentication).toHaveBeenCalledWith('agency', 'one', 'one-job');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => { poll.resolve(job('one', { status: 'completed', server: inspected('one') })); });
    expect(api.startMcpAuthentication).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('CODE-123')).not.toBeInTheDocument();
  });

  it('cancels a late POST after close and surfaces cancellation errors to the parent', async () => {
    const pending = deferred<McpAuthenticationJob>();
    const { api, onBackgroundError } = mount([server('one')], {
      inspectMcpServer: vi.fn().mockResolvedValue(inspected('one', 'failed', true)),
      startMcpAuthentication: vi.fn().mockReturnValue(pending.promise),
      cancelMcpAuthentication: vi.fn().mockRejectedValue(new Error('Offline')),
    });
    await finishChecks();
    await beginAuthentication();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => { pending.resolve(job('one')); });
    expect(api.cancelMcpAuthentication).toHaveBeenCalledWith('agency', 'one', 'one-job');
    expect(onBackgroundError).toHaveBeenCalledWith(expect.stringContaining('after its dialog closed'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ignores late check errors after unmount and never starts another check', async () => {
    const pending = deferred<McpServerEntry>();
    const { api, unmount, onBackgroundError } = mount([server('one'), server('two')], {
      inspectMcpServer: vi.fn().mockReturnValue(pending.promise),
    });
    await waitFor(() => expect(api.inspectMcpServer).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => { pending.reject(new Error('Late check failure')); });
    expect(onBackgroundError).not.toHaveBeenCalled();
    expect(api.inspectMcpServer).toHaveBeenCalledTimes(1);
    expect(api.startMcpAuthentication).not.toHaveBeenCalled();
  });

  it('cancels on external unmount and reports background cancellation failures', async () => {
    const { api, unmount, onBackgroundError } = mount([server('one')], {
      inspectMcpServer: vi.fn().mockResolvedValue(inspected('one', 'failed', true)),
      cancelMcpAuthentication: vi.fn().mockRejectedValue(new Error('Offline')),
    });
    await finishChecks();
    await beginAuthentication();
    await act(async () => { unmount(); });
    expect(api.cancelMcpAuthentication).toHaveBeenCalledWith('agency', 'one', 'one-job');
    expect(onBackgroundError).toHaveBeenCalledWith(expect.stringContaining('Could not confirm cancellation'));
  });
});

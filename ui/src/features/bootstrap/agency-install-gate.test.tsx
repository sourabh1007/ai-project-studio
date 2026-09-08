import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import { createApiClient } from '../../lib/api.js';
import type { AgencyStatus } from '../../lib/types.js';
import { AgencyInstallGate } from './agency-install-gate.js';

class InstallerStream {
  static instances: InstallerStream[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) {
    InstallerStream.instances.push(this);
  }
  send(event: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }));
  }
  fail() {
    this.onerror?.(new Event('error'));
  }
}

function mount(probe: () => Promise<AgencyStatus> = async () => ({ installed: false })) {
  const api = createApiClient();
  const status = vi.spyOn(api, 'getAgencyStatus').mockImplementation(probe);
  const view = render(
    <ApiProvider value={api}>
      <AgencyInstallGate><p>Application ready</p></AgencyInstallGate>
    </ApiProvider>,
  );
  return { status, ...view };
}

const flush = () => act(async () => {});
const missing = { installed: false };
const installed = { installed: true };

beforeEach(() => {
  vi.useFakeTimers();
  InstallerStream.instances = [];
  vi.stubGlobal('EventSource', InstallerStream);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AgencyInstallGate', () => {
  it('opens the application without installing when status confirms availability', async () => {
    mount(async () => installed);
    await flush();
    expect(screen.getByText('Application ready')).toBeTruthy();
    expect(InstallerStream.instances).toHaveLength(0);
  });

  it('does not interpret a failed status read as missing, and supports a safe retry', async () => {
    const h = mount(async () => { throw new Error('offline'); });
    await flush();
    expect(screen.getByText(/Could not confirm whether Agency is installed: offline/)).toBeTruthy();
    expect(InstallerStream.instances).toHaveLength(0);
    h.status.mockResolvedValue(installed);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await flush();
    expect(screen.getByText('Application ready')).toBeTruthy();
    expect(InstallerStream.instances).toHaveLength(0);
  });

  it('bounds an unresponsive status probe and ignores a late missing result', async () => {
    let resolve!: (status: AgencyStatus) => void;
    mount(() => new Promise((yes) => { resolve = yes; }));
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(screen.getByText(/status check timed out/)).toBeTruthy();
    await act(async () => { resolve(missing); });
    expect(InstallerStream.instances).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Continue without waiting' }));
    expect(screen.getByText('Application ready')).toBeTruthy();
  });
  it('does not install when the status endpoint returns an incomplete response', async () => {
    const api = createApiClient({ fetchImpl: async () => new Response('{}') });
    render(
      <ApiProvider value={api}>
        <AgencyInstallGate><p>Application ready</p></AgencyInstallGate>
      </ApiProvider>,
    );
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('did not confirm installation availability');
    expect(InstallerStream.instances).toHaveLength(0);
  });

  it('allows deferral during checking without starting an installer when the probe finishes', async () => {
    let resolve!: (status: AgencyStatus) => void;
    mount(() => new Promise((yes) => { resolve = yes; }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue without waiting' }));
    await act(async () => { resolve(missing); vi.advanceTimersByTime(30_000); });
    expect(screen.getByText('Application ready')).toBeTruthy();
    expect(InstallerStream.instances).toHaveLength(0);
  });

  it('reports stalled live progress, resumes on output, and completes normally', async () => {
    mount();
    await flush();
    const stream = InstallerStream.instances[0];
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByRole('status')).toHaveTextContent('No installer progress for 30 seconds');
    expect(stream.close).not.toHaveBeenCalled();
    act(() => stream.send({ kind: 'line', line: 'Downloading' }));
    expect(screen.getByRole('status')).toHaveTextContent('Installing');
    expect(screen.getByRole('status')).not.toHaveTextContent('No installer progress');
    expect(screen.getByRole('log', { name: 'Recent installation output' })).toHaveTextContent('Downloading');
    act(() => stream.send({ kind: 'done' }));
    expect(screen.getByText('Application ready')).toBeTruthy();
    expect(stream.close).toHaveBeenCalled();
  });

  it('closes observation on deferral and ignores late stream events without claiming cancellation', async () => {
    mount();
    await flush();
    const stream = InstallerStream.instances[0];
    expect(screen.getByText(/Continuing does not cancel an installer already running/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue without waiting' }));
    expect(stream.close).toHaveBeenCalled();
    act(() => {
      stream.send({ kind: 'error', message: 'late failure' });
      stream.fail();
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText('Application ready')).toBeTruthy();
    expect(screen.queryByText('late failure')).toBeNull();
  });

  it('does not start a duplicate installer after connection loss and can recheck successful completion', async () => {
    const h = mount();
    await flush();
    act(() => InstallerStream.instances[0].fail());
    expect(screen.getByRole('heading', { name: 'Installation status unknown' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await flush();
    expect(screen.getByText(/previous installer may still be running/)).toBeTruthy();
    expect(InstallerStream.instances).toHaveLength(1);
    h.status.mockResolvedValue(installed);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await flush();
    expect(screen.getByText('Application ready')).toBeTruthy();
    expect(InstallerStream.instances).toHaveLength(1);
  });

  it('permits another install after a confirmed terminal failure and ignores old events', async () => {
    mount();
    await flush();
    const old = InstallerStream.instances[0];
    act(() => old.send({ kind: 'error', message: 'Install exited unsuccessfully' }));
    expect(screen.getByText('Install exited unsuccessfully')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await flush();
    expect(InstallerStream.instances).toHaveLength(2);
    act(() => old.send({ kind: 'done' }));
    expect(screen.queryByText('Application ready')).toBeNull();
    act(() => InstallerStream.instances[1].send({ kind: 'done' }));
    expect(screen.getByText('Application ready')).toBeTruthy();
  });

  it('bounds log retention and rejects malformed progress without treating it as success', async () => {
    mount();
    await flush();
    const stream = InstallerStream.instances[0];
    act(() => {
      stream.onmessage?.(new MessageEvent('message', { data: 'not-json' }));
      stream.send(null);
      stream.send(42);
      stream.send({ kind: 'line', line: { unsafe: true } });
      for (let i = 0; i < 205; i++) stream.send({ kind: 'line', line: `line-${i}` });
      stream.send({ kind: 'line', line: 'X'.repeat(10_000) });
    });
    const log = screen.getByRole('log');
    expect(log.children).toHaveLength(200);
    expect(screen.queryByText('line-0')).toBeNull();
    expect(log.textContent).not.toContain('X'.repeat(1_001));
    expect(log.textContent).toContain('(truncated)');
    expect(screen.queryByText('Application ready')).toBeNull();
    act(() => stream.send({ kind: 'error', message: 7 }));
    expect(screen.getByText('Installation failed')).toBeTruthy();
  });
});

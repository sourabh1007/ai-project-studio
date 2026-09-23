import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TabPopout,
  isPoppableTab,
  readTabPopoutFromLocation,
  type PoppableTab,
} from './tab-popout.js';
import type { WorkspaceTab } from './workspace-tabs.js';

// Keep xterm and the real agent modules out of jsdom: the popout only needs to
// prove it hands the right props to the right body.
vi.mock('../../components/terminal-view.js', () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="terminal" data-session={sessionId} />
  ),
}));

vi.mock('../../agent-host/agent-registry.js', () => ({
  getAgentModule: (agentId: string) =>
    agentId === 'review-board'
      ? {
          title: 'Review Board',
          component: ({ ctx }: { ctx: { agentId: string } }) => (
            <div data-testid="agent" data-agent={ctx.agentId} />
          ),
        }
      : null,
}));

const sessionTab = {
  kind: 'session',
  id: 's1',
  label: 'Build feature',
  session: { id: 'sess1', name: 'Build feature' },
} as unknown as PoppableTab;

const agentTab = {
  kind: 'agent',
  id: 'agent:review-board:f1',
  label: 'Review Board · Feat',
  agentId: 'review-board',
  attachmentId: 'att1',
  feature: { id: 'f1', name: 'Feat' },
} as unknown as PoppableTab;

function encode(payload: unknown): string {
  return '#' + encodeURIComponent(JSON.stringify(payload));
}

afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop;
});

describe('isPoppableTab', () => {
  it('accepts session and agent tabs, rejects the rest', () => {
    expect(isPoppableTab(sessionTab as WorkspaceTab)).toBe(true);
    expect(isPoppableTab(agentTab as WorkspaceTab)).toBe(true);
    expect(
      isPoppableTab({ kind: 'feature', id: 'f', label: 'F' } as WorkspaceTab),
    ).toBe(false);
    expect(
      isPoppableTab({ kind: 'repo', id: 'r', label: 'R' } as WorkspaceTab),
    ).toBe(false);
  });
});

describe('readTabPopoutFromLocation', () => {
  it('parses a session pop-out payload', () => {
    const result = readTabPopoutFromLocation(
      '?popout=tab',
      encode({ tab: sessionTab, label: 'My session' }),
    );
    expect(result?.tab.id).toBe('s1');
    expect(result?.label).toBe('My session');
  });

  it('parses an agent-board pop-out payload', () => {
    const result = readTabPopoutFromLocation(
      '?popout=tab',
      encode({ tab: agentTab }),
    );
    expect(result?.tab.kind).toBe('agent');
    expect(result?.label).toBe('');
  });

  it('returns null when this is not a tab pop-out window', () => {
    expect(readTabPopoutFromLocation('', encode({ tab: sessionTab }))).toBeNull();
    expect(
      readTabPopoutFromLocation('?popout=other', encode({ tab: sessionTab })),
    ).toBeNull();
  });

  it('returns null for an empty or malformed hash', () => {
    expect(readTabPopoutFromLocation('?popout=tab', '')).toBeNull();
    expect(readTabPopoutFromLocation('?popout=tab', '#not-json')).toBeNull();
  });

  it('returns null for a missing id or a non-poppable tab kind', () => {
    expect(
      readTabPopoutFromLocation('?popout=tab', encode({ tab: { kind: 'session' } })),
    ).toBeNull();
    expect(
      readTabPopoutFromLocation(
        '?popout=tab',
        encode({ tab: { kind: 'feature', id: 'f1' } }),
      ),
    ).toBeNull();
  });
});

describe('TabPopout', () => {
  it('titles the window from the label and drives the shared terminal', async () => {
    render(<TabPopout tab={sessionTab} label="Detached run" />);
    expect(screen.getByText('Detached run')).toBeInTheDocument();
    expect(await screen.findByTestId('terminal')).toHaveAttribute(
      'data-session',
      'sess1',
    );
  });

  it('renders an agent board with its agent context', async () => {
    render(<TabPopout tab={agentTab} label="Review Board · Feat" />);
    expect(screen.getByText('Review Board · Feat')).toBeInTheDocument();
    expect(await screen.findByTestId('agent')).toHaveAttribute(
      'data-agent',
      'review-board',
    );
  });

  it('falls back to the session name when no label is provided', () => {
    render(<TabPopout tab={sessionTab} label="" />);
    expect(screen.getByText('Build feature')).toBeInTheDocument();
  });

  it('returns the tab to the IDE through the desktop bridge', () => {
    const popIn = vi.fn().mockResolvedValue(true);
    (window as unknown as { desktop: unknown }).desktop = { windows: { popIn } };
    render(<TabPopout tab={agentTab} label="Review Board · Feat" />);
    fireEvent.click(screen.getByRole('button', { name: /return to ide/i }));
    expect(popIn).toHaveBeenCalledTimes(1);
  });

  it('owns copy in the detached window and routes it to the native clipboard', async () => {
    const copyText = vi.fn().mockResolvedValue({ ok: true });
    (window as unknown as { desktop: unknown }).desktop = { copyText };
    const selection = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ toString: () => 'copied text' } as unknown as Selection);
    try {
      render(<TabPopout tab={agentTab} label="Review Board · Feat" />);
      window.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }));
      await vi.waitFor(() =>
        expect(copyText).toHaveBeenCalledWith('copied text'),
      );
    } finally {
      selection.mockRestore();
    }
  });

  it('surfaces a copy failure in the detached window', async () => {
    const copyText = vi.fn().mockResolvedValue({
      ok: false,
      error: 'verification-failed',
      writeState: 'written',
    });
    (window as unknown as { desktop: unknown }).desktop = { copyText };
    const selection = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ toString: () => 'copied text' } as unknown as Selection);
    try {
      render(<TabPopout tab={agentTab} label="Review Board · Feat" />);
      window.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /copy failed \(verification-failed\)/i,
      );
    } finally {
      selection.mockRestore();
    }
  });
});

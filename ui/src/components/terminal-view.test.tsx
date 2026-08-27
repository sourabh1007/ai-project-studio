import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// Shared holder captured across the hoisted vi.mock factory and the test body.
const h = vi.hoisted(() => ({
  // The most recently constructed mock Terminal instance.
  term: null as null | {
    rows: number;
    refresh: ReturnType<typeof import('vitest').vi.fn>;
    scrollHandlers: Array<() => void>;
  },
}));

vi.mock('@xterm/xterm', () => {
  const disposable = () => ({ dispose: () => {} });
  class MockTerminal {
    rows = 24;
    cols = 80;
    options: Record<string, unknown> = {};
    refresh = vi.fn();
    scrollHandlers: Array<() => void> = [];
    constructor() {
      h.term = this;
    }
    loadAddon = vi.fn();
    open = vi.fn();
    onData = vi.fn(() => disposable());
    onSelectionChange = vi.fn(() => disposable());
    onScroll = vi.fn((cb: () => void) => {
      this.scrollHandlers.push(cb);
      return disposable();
    });
    getSelection = vi.fn(() => '');
    hasSelection = vi.fn(() => false);
    clearSelection = vi.fn();
    paste = vi.fn();
    focus = vi.fn();
    write = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    dispose = vi.fn();
  }
  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    dispose = vi.fn();
  },
}));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss = vi.fn();
    dispose = vi.fn();
  },
}));

class MockWebSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
}

import { TerminalView } from './terminal-view.js';

describe('TerminalView scrollback repaint', () => {
  beforeEach(() => {
    h.term = null;
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('repaints the whole viewport on every scroll so scrollback never garbles', () => {
    render(<TerminalView sessionId="s1" />);

    expect(h.term).not.toBeNull();
    const term = h.term!;
    // A scroll handler must be registered.
    expect(term.scrollHandlers.length).toBeGreaterThan(0);

    term.refresh.mockClear();
    // Simulate the user scrolling up/down through scrollback.
    for (const handler of term.scrollHandlers) {
      handler();
    }

    // The visible rows (0..rows-1) must be force-repainted so the WebGL
    // renderer can't leave stale, shifted rows behind.
    expect(term.refresh).toHaveBeenCalledWith(0, term.rows - 1);
  });
});

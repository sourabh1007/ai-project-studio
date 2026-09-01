import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

// Shared holder captured across the hoisted vi.mock factory and the test body.
const h = vi.hoisted(() => ({
  // The most recently constructed mock Terminal instance.
  term: null as null | {
    rows: number;
    options: Record<string, unknown>;
    refresh: ReturnType<typeof import('vitest').vi.fn>;
    scrollHandlers: Array<() => void>;
    selectionHandlers: Array<() => void>;
    dataHandlers: Array<(data: string) => void>;
    oscHandlers: Record<number, (data: string) => boolean>;
    keyHandler: ((event: KeyboardEvent) => boolean) | null;
    getSelection: ReturnType<typeof import('vitest').vi.fn>;
    hasSelection: ReturnType<typeof import('vitest').vi.fn>;
    focus: ReturnType<typeof import('vitest').vi.fn>;
  },
  webgl: null as null | {
    clearTextureAtlas: ReturnType<typeof import('vitest').vi.fn>;
  },
  fit: null as null | { fit: ReturnType<typeof import('vitest').vi.fn> },
  ws: null as null | {
    readyState: number;
    send: ReturnType<typeof import('vitest').vi.fn>;
    onopen: (() => void) | null;
  },
  resizeCallbacks: [] as Array<() => void>,
}));

vi.mock('@xterm/xterm', () => {
  const disposable = () => ({ dispose: () => {} });
  class MockTerminal {
    rows = 24;
    cols = 80;
    options: Record<string, unknown> = {};
    refresh = vi.fn();
    scrollHandlers: Array<() => void> = [];
    selectionHandlers: Array<() => void> = [];
    dataHandlers: Array<(data: string) => void> = [];
    oscHandlers: Record<number, (data: string) => boolean> = {};
    parser = {
      registerOscHandler: vi.fn(
        (ident: number, cb: (data: string) => boolean) => {
          this.oscHandlers[ident] = cb;
          return disposable();
        },
      ),
    };
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      h.term = this;
    }
    loadAddon = vi.fn();
    open = vi.fn();
    onData = vi.fn((cb: (data: string) => void) => {
      this.dataHandlers.push(cb);
      return disposable();
    });
    onSelectionChange = vi.fn((cb: () => void) => {
      this.selectionHandlers.push(cb);
      return disposable();
    });
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
    attachCustomKeyEventHandler = vi.fn(
      (cb: (event: KeyboardEvent) => boolean) => {
        this.keyHandler = cb;
      },
    );
    dispose = vi.fn();
  }
  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
    constructor() {
      h.fit = this;
    }
  },
}));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    dispose = vi.fn();
  },
}));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    clearTextureAtlas = vi.fn();
    onContextLoss = vi.fn();
    dispose = vi.fn();
    constructor() {
      h.webgl = this;
    }
  },
}));

class MockWebSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    h.ws = this;
  }
}

import { TerminalView } from './terminal-view.js';

describe('TerminalView scrollback repaint', () => {
  beforeEach(() => {
    h.term = null;
    h.webgl = null;
    h.fit = null;
    h.ws = null;
    h.resizeCallbacks = [];
    // jsdom reports clientWidth/clientHeight as 0, which makes safeFit bail out
    // before ever calling fit(); give the host real layout dimensions so fit
    // behavior can be exercised.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 600,
    });
    delete (window as unknown as { desktop?: unknown }).desktop;
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('navigator', { userAgent: 'Windows NT' });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          h.resizeCallbacks.push(cb);
        }
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
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

    expect(h.webgl?.clearTextureAtlas).toHaveBeenCalledTimes(1);
    // The visible rows (0..rows-1) must be force-repainted so the renderer can't
    // leave stale, shifted rows behind.
    expect(term.refresh).toHaveBeenCalledWith(0, term.rows - 1);
  });

  it('disables xterm reflow for Windows ConPTY scrollback', () => {
    render(<TerminalView sessionId="s1" />);

    expect(h.term?.options.windowsPty).toEqual({ backend: 'conpty' });
  });

  it('clears and repaints after width reflow so stale separator cells cannot remain', () => {
    vi.useFakeTimers();
    render(<TerminalView sessionId="s1" />);

    const term = h.term!;
    term.refresh.mockClear();
    h.webgl?.clearTextureAtlas.mockClear();
    act(() => {
      for (const cb of h.resizeCallbacks) {
        cb();
      }
      vi.advanceTimersByTime(120);
    });

    expect(h.webgl?.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(term.refresh).toHaveBeenCalledWith(0, term.rows - 1);
  });

  it('copies cleaned terminal selections without frame pipes', () => {
    const copyText = vi.fn();
    (window as unknown as { desktop: { copyText: typeof copyText } }).desktop = {
      copyText,
    };
    render(<TerminalView sessionId="s1" />);

    const term = h.term!;
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue(
      '   at Service.OpenAsync(IStatelessServicePartition   |  partition, CancellationToken cancellationToken)   |',
    );

    expect(
      term.keyHandler?.(
        new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }),
      ),
    ).toBe(false);
    expect(copyText).toHaveBeenCalledWith(
      '   at Service.OpenAsync(IStatelessServicePartition partition, CancellationToken cancellationToken)',
    );
  });

  it('focuses the terminal on open so copy shortcuts work before the socket connects', () => {
    render(<TerminalView sessionId="s1" />);

    // focus() must be called during mount (synchronously after term.open),
    // before the WebSocket ever fires onopen.
    expect(h.term!.focus).toHaveBeenCalled();
    expect(h.ws!.onopen).not.toBeNull();
  });

  it('does not refit while a selection is active so copy is not wiped on a fresh session', () => {
    vi.useFakeTimers();
    render(<TerminalView sessionId="s1" />);

    const fit = h.fit!;
    // Simulate the user holding a selection during the initial fit-retry burst.
    h.term!.hasSelection.mockReturnValue(true);
    fit.fit.mockClear();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(fit.fit).not.toHaveBeenCalled();

    // Once the selection is released, fits resume.
    h.term!.hasSelection.mockReturnValue(false);
    act(() => {
      for (const cb of h.resizeCallbacks) {
        cb();
      }
      vi.advanceTimersByTime(120);
    });
    expect(fit.fit).toHaveBeenCalled();
  });

  it('sends at most one resize per real size change during the fresh-session fit burst', () => {
    vi.useFakeTimers();
    render(<TerminalView sessionId="s1" />);

    const ws = h.ws!;
    ws.readyState = MockWebSocket.OPEN;
    ws.send.mockClear();
    act(() => {
      ws.onopen?.();
      // Drive the full fit-retry burst; dimensions stay constant (80x24).
      vi.advanceTimersByTime(600);
    });

    const resizeSends = ws.send.mock.calls.filter((call) =>
      String(call[0]).includes('resize'),
    );
    expect(resizeSends).toHaveLength(1);
  });

  it('strips OSC color-query replies from terminal input before sending to the PTY', () => {
    render(<TerminalView sessionId="s1" />);

    const term = h.term!;
    const ws = h.ws!;
    ws.readyState = MockWebSocket.OPEN;
    ws.send.mockClear();
    expect(term.dataHandlers.length).toBeGreaterThan(0);

    // A palette report followed by a real keystroke: only the keystroke is sent.
    term.dataHandlers[0]('\x1b]4;0;rgb:2e2e/3434/3636\x07w');
    // A pure report produces no send at all.
    term.dataHandlers[0]('\x1b]11;rgb:0000/0000/0000\x07');

    const inputs = ws.send.mock.calls
      .map((call) => String(call[0]))
      .filter((msg) => msg.includes('input'));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('"data":"w"');
    expect(inputs[0]).not.toContain('rgb');
  });

  it('suppresses xterm auto-replies to OSC color queries but allows palette sets', () => {
    render(<TerminalView sessionId="s1" />);

    const term = h.term!;
    // A handler is registered for each color-query OSC ident.
    for (const ident of [4, 10, 11, 12]) {
      expect(typeof term.oscHandlers[ident]).toBe('function');
    }
    // Queries (contain '?') are handled (return true) → xterm's reply is suppressed.
    expect(term.oscHandlers[4]('0;?')).toBe(true);
    expect(term.oscHandlers[11]('?')).toBe(true);
    // Sets fall through (return false) so the CLI can still recolor the terminal.
    expect(term.oscHandlers[4]('0;rgb:2e2e/3434/3636')).toBe(false);
    expect(term.oscHandlers[10]('rgb:ffff/ffff/ffff')).toBe(false);
  });

  it('regression: suppresses every palette+fg/bg/cursor color query so none can reply', () => {
    render(<TerminalView sessionId="s1" />);

    const term = h.term!;
    // The CLI queries all 16 ANSI palette indices: each must be suppressed.
    for (let index = 0; index < 16; index += 1) {
      expect(term.oscHandlers[4](`${index};?`)).toBe(true);
    }
    // ...plus foreground (10), background (11) and cursor (12) color queries.
    expect(term.oscHandlers[10]('?')).toBe(true);
    expect(term.oscHandlers[11]('?')).toBe(true);
    expect(term.oscHandlers[12]('?')).toBe(true);
  });
});

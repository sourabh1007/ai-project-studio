import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

// Shared holder captured across the hoisted vi.mock factory and the test body.
const h = vi.hoisted(() => ({
  // The most recently constructed mock Terminal instance.
  term: null as null | {
    rows: number;
    cols: number;
    options: Record<string, unknown>;
    refresh: ReturnType<typeof import('vitest').vi.fn>;
    scrollHandlers: Array<() => void>;
    selectionHandlers: Array<() => void>;
    dataHandlers: Array<(data: string) => void>;
    oscHandlers: Record<number, (data: string) => boolean>;
    keyHandler: ((event: KeyboardEvent) => boolean) | null;
    getSelection: ReturnType<typeof import('vitest').vi.fn>;
    hasSelection: ReturnType<typeof import('vitest').vi.fn>;
    clearSelection: ReturnType<typeof import('vitest').vi.fn>;
    focus: ReturnType<typeof import('vitest').vi.fn>;
    paste: ReturnType<typeof import('vitest').vi.fn>;
    write: ReturnType<typeof import('vitest').vi.fn>;
    writeCallbacks: Array<() => void>;
  },
  webgl: null as null | {
    clearTextureAtlas: ReturnType<typeof import('vitest').vi.fn>;
  },
  fit: null as null | { fit: ReturnType<typeof import('vitest').vi.fn> },
  ws: null as null | {
    readyState: number;
    send: ReturnType<typeof import('vitest').vi.fn>;
    onopen: (() => void) | null;
    onmessage: ((event: { data: string }) => void) | null;
    onclose: ((event: { code: number }) => void) | null;
    onerror: (() => void) | null;
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
    textarea: HTMLTextAreaElement | null = null;
    open = vi.fn((host: HTMLElement) => {
      this.textarea = document.createElement('textarea');
      this.textarea.className = 'xterm';
      host.appendChild(this.textarea);
    });
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
    focus = vi.fn(() => this.textarea?.focus());
    writeCallbacks: Array<() => void> = [];
    write = vi.fn((_data: string, callback?: () => void) => {
      if (callback) {
        this.writeCallbacks.push(callback);
      }
    });
    resize = vi.fn((cols: number, rows: number) => { this.cols = cols; this.rows = rows; });
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
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    h.ws = this;
  }
}

import { TerminalView } from './terminal-view.js';
import { Modal } from './ui.js';
import { attachmentPasteText, type ClipboardAttachmentResult } from '../lib/clipboard.js';

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

  it('does not steal focus back from an open modal when the window refocuses', () => {
    const view = render(
      <div>
        <TerminalView sessionId="s1" />
        <div role="dialog" aria-modal="true">
          <button type="button">Modal action</button>
        </div>
      </div>,
    );

    h.term!.focus.mockClear();
    const modalAction = view.getByRole('button', { name: 'Modal action' });
    modalAction.focus();
    window.dispatchEvent(new Event('focus'));

    expect(h.term!.focus).not.toHaveBeenCalled();
    expect(modalAction).toHaveFocus();
  });

  it('does not auto-focus when the terminal mounts beneath an already-open modal', () => {
    const view = render(
      <div>
        <div role="dialog" aria-modal="true">
          <input aria-label="Modal field" autoFocus />
        </div>
        <TerminalView sessionId="s1" />
      </div>,
    );

    expect(view.getByRole('textbox', { name: 'Modal field' })).toHaveFocus();
    expect(h.term!.focus).not.toHaveBeenCalled();
  });

  it('respects an intentional user focus target outside the terminal on window focus', () => {
    render(<TerminalView sessionId="s1" />);

    h.term!.focus.mockClear();
    const other = document.createElement('input');
    document.body.append(other);
    other.focus();
    window.dispatchEvent(new Event('focus'));

    expect(h.term!.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(other);
    other.remove();
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
    const copyText = vi.fn(async () => ({ ok: true }));
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

  it('restores terminal focus after closing a modal when the terminal generation is unchanged', () => {
    const view = render(<TerminalView sessionId="s1" />);
    const terminalInput = view.container.querySelector('textarea')!;
    expect(terminalInput).toHaveFocus();

    view.rerender(
      <>
        <TerminalView sessionId="s1" />
        <Modal title="Pause terminal" onClose={() => {}}>
          <input aria-label="Pause reason" autoFocus />
        </Modal>
      </>,
    );
    expect(view.getByRole('textbox', { name: 'Pause reason' })).toHaveFocus();

    view.rerender(<TerminalView sessionId="s1" />);
    expect(terminalInput).toHaveFocus();
  });

  it('does not restore focus to the same DOM terminal target after a generation replacement', () => {
    const view = render(<TerminalView sessionId="s1" />);
    const terminalInput = view.container.querySelector('textarea')!;
    act(() => {
      h.ws!.readyState = MockWebSocket.OPEN;
      h.ws!.onmessage?.({
        data: JSON.stringify({
          type: 'state',
          version: 2,
          state: 'ready',
          generation: 1,
          inputLimit: 65536,
        }),
      });
    });
    expect(terminalInput).toHaveFocus();

    view.rerender(
      <>
        <TerminalView sessionId="s1" />
        <Modal title="Pause terminal" onClose={() => {}}>
          <input aria-label="Pause reason" autoFocus />
        </Modal>
      </>,
    );
    expect(view.getByRole('textbox', { name: 'Pause reason' })).toHaveFocus();

    act(() => {
      h.ws!.onmessage?.({
        data: JSON.stringify({
          type: 'state',
          version: 2,
          state: 'reconnecting',
          generation: 1,
          inputLimit: 65536,
        }),
      });
      h.ws!.onmessage?.({
        data: JSON.stringify({
          type: 'state',
          version: 2,
          state: 'ready',
          generation: 2,
          inputLimit: 65536,
        }),
      });
    });
    expect(terminalInput.isConnected).toBe(true);

    view.rerender(<TerminalView sessionId="s1" />);
    expect(terminalInput).not.toHaveFocus();
  });

  it('owns trusted-handler fixture text once per event but accepts immediate identical actions', () => {
    // Direct handler fixtures test ownership logic, NOT native/trusted OS input.
    const registrations = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const { container } = render(<TerminalView sessionId="s1" />);
    const entry = registrations.mock.calls.find(([name], index) => name === 'paste' &&
      (registrations.mock.contexts[index] as HTMLElement).className === 'terminal-host')!;
    const onPaste = entry[1] as (event: ClipboardEvent) => void;
    const event = () => ({
      preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), isTrusted: true,
      clipboardData: { getData: () => '😀\r\nsame' },
    }) as unknown as ClipboardEvent;
    const first = event();
    onPaste(first);
    onPaste(first);
    onPaste(event());
    expect(h.term!.paste).toHaveBeenCalledTimes(2);
    expect(h.term!.paste).toHaveBeenNthCalledWith(1, '😀\r\nsame');
    expect(first.preventDefault).toHaveBeenCalled();
    expect(first.stopImmediatePropagation).toHaveBeenCalled();
    container.querySelector('textarea')!.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
    expect(h.term!.paste).toHaveBeenCalledTimes(2);
    registrations.mockRestore();
  });

  it.each(['focus', 'blur', 'unmount', 'session'] as const)(
    'cancels delayed right-click paste after %s, even when focus returns', async (change) => {
      let resolve!: (text: string) => void;
      const readText = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
      (window as unknown as { desktop: unknown }).desktop = { readText };
      const view = render(<TerminalView sessionId="s1" />);
      const old = h.term!;
      view.container.querySelector('textarea')!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(readText).toHaveBeenCalledTimes(1);
      if (change === 'unmount') view.unmount();
      else if (change === 'session') view.rerender(<TerminalView sessionId="s2" />);
      else if (change === 'blur') window.dispatchEvent(new Event('blur'));
      else {
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        old.focus();
        input.remove();
      }
      await act(async () => { resolve('stale'); });
      expect(old.paste).not.toHaveBeenCalled();
      expect(h.term!.paste).not.toHaveBeenCalled();
    },
  );

  it('accepts two independent right-click pastes, even with identical text', async () => {
    (window as unknown as { desktop: unknown }).desktop = { readText: async () => 'same' };
    const { container } = render(<TerminalView sessionId="s1" />);
    await act(async () => {
      for (let i = 0; i < 2; i++) {
        container.querySelector('textarea')!.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      }
    });
    expect(h.term!.paste.mock.calls).toEqual([['same'], ['same']]);
  });

  it.each(
    (['text', 'image'] as const).flatMap((kind) =>
      (['replacement', 'generation', 'closed', 'failed', 'loss', 'error', 'exit', 'invalid', 'initial'] as const)
        .map((transition) => ({ kind, transition }))),
  )('scopes pending $kind clipboard reads to terminal ownership across $transition', async ({ kind, transition }) => {
    vi.useFakeTimers();
    let resolve!: (value: string | ClipboardAttachmentResult) => void;
    const read = vi.fn(() => new Promise<string | ClipboardAttachmentResult>((done) => { resolve = done; }));
    (window as unknown as { desktop: unknown }).desktop = { readText: read, readImage: read };
    const registrations = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const view = render(<TerminalView sessionId="s1" />);
    const term = h.term!;
    term.paste.mockImplementation((text: string) => term.dataHandlers[0](text));
    const state = (state: string, generation: number) => h.ws!.onmessage?.({
      data: JSON.stringify({ type: 'state', version: 2, state, generation, inputLimit: 65536 }),
    });
    if (transition !== 'initial') {
      act(() => { h.ws!.readyState = MockWebSocket.OPEN; state('ready', 1); });
    }
    const target = view.container.querySelector('textarea')!;
    if (kind === 'text') {
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    } else {
      const onPaste = registrations.mock.calls.find(([name], index) =>
        name === 'paste' && (registrations.mock.contexts[index] as HTMLElement).className === 'terminal-host',
      )![1] as (event: ClipboardEvent) => void;
      act(() => onPaste({
        preventDefault() {}, stopImmediatePropagation() {}, isTrusted: true,
        clipboardData: { getData: () => '', files: [{}] },
      } as unknown as ClipboardEvent));
    }
    expect(read).toHaveBeenCalledOnce();
    act(() => {
      if (transition === 'replacement') state('reconnecting', 1);
      if (transition === 'closed' || transition === 'failed') state(transition, 1);
      if (transition === 'loss') {
        h.ws!.onclose?.({ code: 1006 });
        vi.advanceTimersByTime(1000);
      }
      if (transition === 'error') h.ws!.onerror?.();
      if (transition === 'exit') h.ws!.onmessage?.({ data: JSON.stringify({ type: 'exit', code: 0 }) });
      if (transition === 'invalid') h.ws!.onmessage?.({ data: 'invalid protocol' });
      h.ws!.readyState = MockWebSocket.OPEN;
      h.ws!.onopen?.();
      if (transition === 'initial') state('connecting', 0);
      // Keep the same generation for error/exit to prove those events themselves
      // invalidate reads, rather than relying on the later generation check.
      const generation = ['initial', 'error', 'exit', 'invalid'].includes(transition) ? 1 : 2;
      state('bootstrapping', generation);
      state('ready', generation);
    });
    expect(document.activeElement).toBe(target);
    const expectedInput = kind === 'image' ? "'C:\\old-image.png'" : 'old-command';
    await act(async () => { resolve(kind === 'image' ? {
      status: 'ready', source: 'clipboard-files', paths: ['C:\\old-image.png'],
    } : 'old-command'); });
    const inputs = h.ws!.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string)).filter((message) => message.type === 'input');
    if (transition === 'initial') {
      expect(term.paste).toHaveBeenCalledOnce();
      expect(term.paste).toHaveBeenCalledWith(expectedInput);
      expect(inputs).toEqual([{ type: 'input', data: expectedInput, generation: 1, seq: 1 }]);
    } else {
      expect(term.paste).not.toHaveBeenCalled();
      expect(inputs).toEqual([]);
    }
    registrations.mockRestore();
  });

  it('clears a right-click selection after real legacy fallback, so the next right-click pastes', async () => {
    let clipboard = '';
    (window as unknown as { desktop: unknown }).desktop = {
      readText: async () => clipboard,
    };
    const { container } = render(<TerminalView sessionId="s1" />);
    const term = h.term!;
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue('selected text');
    term.clearSelection.mockImplementation(() => {
      term.hasSelection.mockReturnValue(false);
      term.getSelection.mockReturnValue('');
    });
    // Use the real DOM fallback and its synchronous focusout, not a mocked
    // copy result. Only the OS-facing execCommand is faked in this JSDOM test.
    const exec = vi.fn(() => {
      const area = document.activeElement as HTMLTextAreaElement;
      expect(area.dataset.clipboardFallback).toBe('true');
      clipboard = area.value;
      return true;
    });
    const previousExec = document.execCommand;
    document.execCommand = exec;
    try {
      const input = container.querySelector('textarea')!;
      await act(async () => {
        input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(term.clearSelection).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(input);
      await act(async () => {
        input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(term.paste.mock.calls).toEqual([['selected text']]);
    } finally {
      document.execCommand = previousExec;
    }
  });

  it.each(['focus', 'blur', 'unmount'] as const)(
    'does not clear selection after legacy fallback followed by genuine %s', async (change) => {
      const view = render(<TerminalView sessionId="s1" />);
      const term = h.term!;
      term.hasSelection.mockReturnValue(true);
      term.getSelection.mockReturnValue('selected text');
      const previousExec = document.execCommand;
      document.execCommand = vi.fn(() => {
        if (change === 'blur') window.dispatchEvent(new Event('blur'));
        if (change === 'unmount') view.unmount();
        return true;
      });
      const other = document.createElement('input');
      document.body.appendChild(other);
      try {
        await act(async () => {
          view.container.querySelector('textarea')!.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
          if (change === 'focus') {
            other.focus();
            term.focus();
          }
        });
        expect(document.execCommand).toHaveBeenCalledTimes(1);
        expect(term.clearSelection).not.toHaveBeenCalled();
      } finally {
        document.execCommand = previousExec;
        other.remove();
      }
    },
  );

  it('cancels delayed image handler fixture reads on focus transfer and unmount', async () => {
    const registrations = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    let resolve!: (value: ClipboardAttachmentResult) => void;
    const readImage = vi.fn(() => new Promise<ClipboardAttachmentResult>((done) => { resolve = done; }));
    (window as unknown as { desktop: unknown }).desktop = { readImage };
    const view = render(<TerminalView sessionId="s1" />);
    const onPaste = registrations.mock.calls.find(([name], index) => name === 'paste' &&
      (registrations.mock.contexts[index] as HTMLElement).className === 'terminal-host')![1] as (e: ClipboardEvent) => void;
    const old = h.term!;
    act(() => onPaste({
      preventDefault() {}, stopImmediatePropagation() {}, isTrusted: true,
      clipboardData: { getData: () => '', files: [{}] },
    } as unknown as ClipboardEvent));
    expect(readImage).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => { resolve({ status: 'ready', source: 'clipboard-files', paths: ['C:\\stale.png'] }); });
    expect(old.paste).not.toHaveBeenCalled();
    registrations.mockRestore();
  });

  it('pastes structured attachment paths once and passes the actual terminal session to the bridge', async () => {
    const registrations = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const result: ClipboardAttachmentResult = {
      status: 'ready', source: 'clipboard-image', paths: ["C:\\owned images\\it's.png"],
      attachmentId: 'lease-id', sessionId: 's1',
    };
    const readImage = vi.fn().mockResolvedValue(result);
    (window as unknown as { desktop: unknown }).desktop = { readImage };
    render(<TerminalView sessionId="s1" />);
    const onPaste = registrations.mock.calls.find(([name], index) => name === 'paste' &&
      (registrations.mock.contexts[index] as HTMLElement).className === 'terminal-host')![1] as (e: ClipboardEvent) => void;
    const event = {
      preventDefault() {}, stopImmediatePropagation() {}, isTrusted: true,
      clipboardData: { getData: () => '', files: [{}] },
    } as unknown as ClipboardEvent;
    await act(async () => { onPaste(event); onPaste(event); });
    expect(readImage).toHaveBeenCalledTimes(1);
    expect(readImage).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(h.term!.paste).toHaveBeenCalledTimes(1);
    expect(h.term!.paste).toHaveBeenCalledWith("'C:\\owned images\\it''s.png'");
    expect(attachmentPasteText({
      status: 'ready', source: 'clipboard-files', paths: ["/source/a'b.png", '/source/space file.png'],
    }, false)).toBe("'/source/a'\"'\"'b.png' '/source/space file.png'");
    registrations.mockRestore();
  });

  it.each(['quota', 'image-too-large', 'reject', 'wrong-session', 'invalid-response'] as const)(
    'reports attachment %s without text fallback, terminal input, or automatic replay',
    async (failure) => {
      const registrations = vi.spyOn(HTMLElement.prototype, 'addEventListener');
      const readText = vi.fn().mockResolvedValue('must not fall back');
      const readImage = failure === 'reject'
        ? vi.fn().mockRejectedValue(new Error('private attachment path'))
        : vi.fn().mockResolvedValue(failure === 'wrong-session' ? {
          status: 'ready', source: 'clipboard-image', paths: ['C:\\owned.png'],
          attachmentId: 'lease', sessionId: 'other',
        } : failure === 'invalid-response' ? 'legacy-string'
          : { status: 'error', error: failure });
      (window as unknown as { desktop: unknown }).desktop = { readImage, readText };
      const view = render(<TerminalView sessionId="s1" />);
      const onPaste = registrations.mock.calls.find(([name], index) => name === 'paste' &&
        (registrations.mock.contexts[index] as HTMLElement).className === 'terminal-host')![1] as (e: ClipboardEvent) => void;
      await act(async () => { onPaste({
        preventDefault() {}, stopImmediatePropagation() {}, isTrusted: true,
        clipboardData: { getData: () => '', files: [{}] },
      } as unknown as ClipboardEvent); });
      expect(view.getByRole('alert').textContent).toMatch(/attachment|image/i);
      expect(view.queryByText('private attachment path')).toBeNull();
      expect(h.term!.paste).not.toHaveBeenCalled();
      expect(readText).not.toHaveBeenCalled();
      expect(readImage).toHaveBeenCalledTimes(1);
      registrations.mockRestore();
    },
  );

  it('does not retry ambiguous attachment terminal delivery or claim that nothing reached the terminal', async () => {
    const registrations = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const readImage = vi.fn().mockResolvedValue({
      status: 'ready', source: 'clipboard-files', paths: ['C:\\source.png'],
    });
    (window as unknown as { desktop: unknown }).desktop = { readImage };
    const view = render(<TerminalView sessionId="s1" />);
    h.term!.paste.mockImplementationOnce(() => { throw new Error('private delivery detail'); });
    const onPaste = registrations.mock.calls.find(([name], index) => name === 'paste' &&
      (registrations.mock.contexts[index] as HTMLElement).className === 'terminal-host')![1] as (e: ClipboardEvent) => void;
    await act(async () => { onPaste({
      preventDefault() {}, stopImmediatePropagation() {}, isTrusted: true,
      clipboardData: { getData: () => '', files: [{}] },
    } as unknown as ClipboardEvent); });
    expect(view.getByRole('alert')).toHaveTextContent('Attachment delivery is unconfirmed');
    expect(h.term!.paste).toHaveBeenCalledTimes(1);
    expect(readImage).toHaveBeenCalledTimes(1);
    registrations.mockRestore();
  });

  it('does not refit while a selection is active and flushes the pending fit when selection clears', () => {
    vi.useFakeTimers();
    render(<TerminalView sessionId="s1" />);

    const term = h.term!;
    const fit = h.fit!;
    // Simulate the user holding a selection during the initial fit-retry burst.
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue('selected');
    fit.fit.mockClear();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(fit.fit).not.toHaveBeenCalled();

    // Once the selection is released, the latest pending fit runs without
    // waiting for another ResizeObserver notification.
    term.hasSelection.mockReturnValue(false);
    term.getSelection.mockReturnValue('');
    act(() => {
      for (const handler of term.selectionHandlers) {
        handler();
      }
    });
    expect(fit.fit).toHaveBeenCalled();
  });

  it('defers a pending fit until the host has valid geometry', () => {
    vi.useFakeTimers();
    let width = 0;
    let height = 0;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => width,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => height,
    });

    render(<TerminalView sessionId="s1" />);
    const fit = h.fit!;
    fit.fit.mockClear();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(fit.fit).not.toHaveBeenCalled();

    width = 800;
    height = 600;
    act(() => {
      for (const cb of h.resizeCallbacks) {
        cb();
      }
      vi.advanceTimersByTime(120);
    });
    expect(fit.fit).toHaveBeenCalledTimes(1);
  });

  it('sends at most one resize per real size change during the fresh-session fit burst', () => {
    vi.useFakeTimers();
    render(<TerminalView sessionId="s1" />);

    const ws = h.ws!;
    ws.readyState = MockWebSocket.OPEN;
    ws.send.mockClear();
    act(() => {
      ws.onopen?.();
      ws.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'ready', generation: 1, inputLimit: 65536 }) });
      // Drive the full fit-retry burst; dimensions stay constant (80x24).
      vi.advanceTimersByTime(600);
    });

    const resizeSends = ws.send.mock.calls.filter((call) =>
      String(call[0]).includes('resize'),
    );
    expect(resizeSends).toHaveLength(1);
  });

  it('blocks every deferred fit and repaint until replay writes finish, then applies the latest fit once', () => {
    vi.useFakeTimers();
    const view = render(<TerminalView sessionId="s1" />);
    const ws = h.ws!;
    const term = h.term!;
    const fit = h.fit!;
    const host = view.container.querySelector('.terminal-host')!;
    ws.readyState = MockWebSocket.OPEN;
    ws.send.mockClear();
    fit.fit.mockClear();
    h.webgl?.clearTextureAtlas.mockClear();
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue('selected');

    act(() => {
      host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      ws.onmessage?.({ data: JSON.stringify({ type: 'resize', cols: 120, rows: 40 }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'REPLAY-1' }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'REPLAY-2' }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'ready', generation: 1, inputLimit: 65536 }) });
      for (const cb of h.resizeCallbacks) {
        cb();
      }
      for (const cb of term.scrollHandlers) {
        cb();
      }
      vi.advanceTimersByTime(720);
    });

    expect(term.write).toHaveBeenCalledWith('REPLAY-1', expect.any(Function));
    expect(term.write).toHaveBeenCalledWith('REPLAY-2', expect.any(Function));
    expect(fit.fit).not.toHaveBeenCalled();
    expect(term.writeCallbacks).toHaveLength(2);
    expect(h.webgl?.clearTextureAtlas).not.toHaveBeenCalled();

    term.hasSelection.mockReturnValue(false);
    term.getSelection.mockReturnValue('');
    act(() => {
      for (const handler of term.selectionHandlers) {
        handler();
      }
      window.dispatchEvent(new MouseEvent('mouseup'));
      vi.advanceTimersByTime(120);
    });
    expect(fit.fit).not.toHaveBeenCalled();
    expect(h.webgl?.clearTextureAtlas).not.toHaveBeenCalled();

    act(() => {
      term.writeCallbacks.shift()?.();
    });
    expect(fit.fit).not.toHaveBeenCalled();
    act(() => {
      term.writeCallbacks.shift()?.();
    });

    expect(fit.fit).toHaveBeenCalledTimes(1);
    expect(h.webgl?.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(view.getByRole('status').textContent).toContain('ready');
  });

  it('restores pane geometry immediately for a zero-output replay once ready arrives', () => {
    render(<TerminalView sessionId="s1" />);
    const ws = h.ws!;
    ws.readyState = MockWebSocket.OPEN;
    h.fit!.fit.mockClear();

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'resize', cols: 120, rows: 40 }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'ready', generation: 1, inputLimit: 65536 }) });
    });

    expect(h.fit!.fit).toHaveBeenCalledTimes(1);
  });

  it('ignores stale replay write callbacks after a generation replacement', () => {
    render(<TerminalView sessionId="s1" />);
    const ws = h.ws!;
    const term = h.term!;
    const fit = h.fit!;
    ws.readyState = MockWebSocket.OPEN;
    fit.fit.mockClear();

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'resize', cols: 120, rows: 40 }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'REPLAY-1' }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'reconnecting', generation: 1, inputLimit: 65536 }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'bootstrapping', generation: 2, inputLimit: 65536 }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'ready', generation: 2, inputLimit: 65536 }) });
    });
    expect(term.writeCallbacks).toHaveLength(1);

    act(() => {
      term.writeCallbacks.shift()?.();
    });

    expect(fit.fit).toHaveBeenCalledTimes(1);
  });

  it('waits for replay and footer writes before restoring pane geometry on exit snapshots that later report closed', () => {
    render(<TerminalView sessionId="s1" />);
    const ws = h.ws!;
    const term = h.term!;
    const fit = h.fit!;
    ws.readyState = MockWebSocket.OPEN;
    fit.fit.mockClear();

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'bootstrapping', generation: 1, inputLimit: 65536 }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'resize', cols: 120, rows: 40 }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'REPLAY-EXIT' }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'exit', code: 0 }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'closed', generation: 1, inputLimit: 65536 }) });
    });

    expect(fit.fit).not.toHaveBeenCalled();
    expect(term.writeCallbacks).toHaveLength(2);
    act(() => {
      term.writeCallbacks.shift()?.();
    });
    expect(fit.fit).not.toHaveBeenCalled();
    act(() => {
      term.writeCallbacks.shift()?.();
    });
    expect(fit.fit).toHaveBeenCalledTimes(1);
  });

  it('uses a footer render fence on ordinary live exit after the closed state', () => {
    render(<TerminalView sessionId="s1" />);
    const ws = h.ws!;
    const term = h.term!;
    ws.readyState = MockWebSocket.OPEN;
    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'ready', generation: 1, inputLimit: 65536 }) });
    });
    term.write.mockClear();
    h.fit!.fit.mockClear();
    ws.send.mockClear();

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'closed', generation: 1, inputLimit: 65536 }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'exit', code: 0 }) });
    });

    expect(term.write).toHaveBeenCalledWith(
      '\r\n\x1b[90m[session ended · exit 0]\x1b[0m\r\n',
      expect.any(Function),
    );
    expect(h.fit!.fit).not.toHaveBeenCalled();
    act(() => term.writeCallbacks.shift()?.());
    expect(h.fit!.fit).toHaveBeenCalledTimes(1);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('keeps the footer fence when ready already sealed a still-rendering replay', () => {
    render(<TerminalView sessionId="s1" />);
    const ws = h.ws!;
    const term = h.term!;
    ws.readyState = MockWebSocket.OPEN;
    h.fit!.fit.mockClear();
    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'resize', cols: 120, rows: 40 }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'REPLAY' }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'ready', generation: 1, inputLimit: 65536 }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'exit', code: 0 }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'closed', generation: 1, inputLimit: 65536 }) });
    });
    expect(term.writeCallbacks).toHaveLength(2);
    act(() => term.writeCallbacks.shift()?.());
    expect(h.fit!.fit).not.toHaveBeenCalled();
    act(() => term.writeCallbacks.shift()?.());
    expect(h.fit!.fit).toHaveBeenCalledTimes(1);
  });

  it('releases a lost drag on window blur so a pending fit resumes on focus', () => {
    vi.useFakeTimers();
    const view = render(<TerminalView sessionId="s1" />);
    act(() => vi.advanceTimersByTime(600));
    h.fit!.fit.mockClear();
    const host = view.container.querySelector('.terminal-host')!;
    act(() => {
      host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      for (const callback of h.resizeCallbacks) callback();
      vi.advanceTimersByTime(120);
    });
    expect(h.fit!.fit).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(h.fit!.fit).toHaveBeenCalledTimes(1);
  });

  it('coalesces repeated resize and pointer timers into a single live fit/focus pass', () => {
    vi.useFakeTimers();
    const view = render(<TerminalView sessionId="s1" />);
    act(() => {
      vi.advanceTimersByTime(600);
    });

    h.fit!.fit.mockClear();
    h.term!.focus.mockClear();
    const host = view.container.querySelector('.terminal-host')!;
    act(() => {
      for (let i = 0; i < 6; i += 1) {
        host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        for (const cb of h.resizeCallbacks) {
          cb();
        }
      }
      window.dispatchEvent(new MouseEvent('mouseup'));
      vi.advanceTimersByTime(0);
      vi.advanceTimersByTime(120);
    });

    expect(h.term!.focus).toHaveBeenCalledTimes(1);
    expect(h.fit!.fit).toHaveBeenCalledTimes(1);
  });

    it('keeps first input until authoritative ready, then follows replacement without remount or focus theft', () => {
      const view = render(<TerminalView sessionId="s1" />);
      const term = h.term!;
      const ws = h.ws!;
      const state = (state: string, generation = 1) => ws.onmessage?.({
        data: JSON.stringify({ type: 'state', version: 2, state, generation, inputLimit: 65536 }),
      });
      act(() => { term.dataHandlers[0]('FIRST'); term.dataHandlers[0]('SECOND'); });
      expect(ws.send).not.toHaveBeenCalled();
      const other = document.createElement('input');
      document.body.append(other); other.focus();
      act(() => {
        ws.readyState = MockWebSocket.OPEN; ws.onopen?.(); state('bootstrapping');
      });
      expect(document.activeElement).toBe(other);
      expect(ws.send).not.toHaveBeenCalled();
      act(() => state('ready'));
      const inputFrames = () => ws.send.mock.calls.map(([raw]) => JSON.parse(raw as string)).filter((m) => m.type === 'input');
      expect(inputFrames().map((m) => m.data)).toEqual(['FIRST', 'SECOND']);
      act(() => {
        state('reconnecting');
        state('bootstrapping', 2);
        ws.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'REPLACEMENT' }) });
        state('ready', 2);
        term.dataHandlers[0]('CURRENT');
      });
      expect(h.term).toBe(term);
      expect(term.write).toHaveBeenCalledWith('REPLACEMENT');
      expect(inputFrames().map((m) => [m.data, m.generation])).toEqual([['FIRST', 1], ['SECOND', 1], ['CURRENT', 2]]);
      expect(view.getByRole('status').textContent).toContain('ready');
      other.remove();
    });

    it('surfaces failed/closed states, reconnects transport loss without replay and cancels reconnect on disposal', () => {
      vi.useFakeTimers();
      const view = render(<TerminalView sessionId="s1" />);
      const first = h.ws!;
      act(() => {
        first.readyState = MockWebSocket.OPEN;
        first.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'ready', generation: 1, inputLimit: 65536 }) });
        h.term!.dataHandlers[0]('UNCERTAIN');
        first.onclose?.({ code: 1006 });
      });
      expect(view.getByRole('status').textContent).toContain('may have executed');
      act(() => vi.advanceTimersByTime(1000));
      const next = h.ws!;
      expect(next).not.toBe(first);
      act(() => {
        next.readyState = MockWebSocket.OPEN;
        next.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'ready', generation: 1, inputLimit: 65536 }) });
      });
      expect(next.send.mock.calls.some(([raw]) => String(raw).includes('UNCERTAIN'))).toBe(false);
      act(() => next.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'closed', generation: 1, inputLimit: 65536 }) }));
      expect(view.getByRole('status').textContent).toContain('closed');
      act(() => next.onclose?.({ code: 1006 }));
      view.unmount();
      act(() => vi.advanceTimersByTime(1000));
      expect(h.ws).toBe(next);
    });

    it('shows an oversized paste rejection and blocks a following Enter', () => {
      const view = render(<TerminalView sessionId="s1" />);
      const ws = h.ws!;
      act(() => {
        h.term!.dataHandlers[0]('prefix');
        h.term!.dataHandlers[0]('x'.repeat(65537));
        h.term!.dataHandlers[0]('\r');
        ws.readyState = MockWebSocket.OPEN;
        ws.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'ready', generation: 1, inputLimit: 65536 }) });
      });
      expect(ws.send).not.toHaveBeenCalled();
      expect(view.getByRole('status').textContent).toContain('Paste rejected in full');
      expect(view.getByRole('button').textContent).toContain('not replayed');
    });

  it('strips OSC color-query replies from terminal input before sending to the PTY', () => {
    render(<TerminalView sessionId="s1" />);

    const term = h.term!;
    const ws = h.ws!;
    ws.readyState = MockWebSocket.OPEN;
    ws.send.mockClear();
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: 'state', version: 2, state: 'ready', generation: 1, inputLimit: 65536 }) }));
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

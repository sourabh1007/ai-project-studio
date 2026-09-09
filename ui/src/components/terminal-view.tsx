import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { resolveApiBase } from '../lib/api-base.js';
import { buildTerminalWsUrl } from '../lib/terminal-url.js';
import {
  decodeServerMessage,
  encodeClientMessage,
  type TerminalState,
} from '../lib/terminal-protocol.js';
import { createTerminalDelivery } from '../lib/terminal-delivery.js';
import {
  toClipboardText, createPasteGuard, attachmentPasteText, attachmentFailureMessage,
  type ClipboardAttachmentResult, type DesktopClipboardBridge,
} from '../lib/clipboard.js';
import { copyText, isInternalClipboardFocusTransfer } from '../hooks/clipboard-write.js';
import {
  COLOR_QUERY_OSC_IDENTS,
  isColorQuery,
  stripTerminalColorReports,
} from '../lib/terminal-input.js';
import { hasOpenModalDialog } from '../lib/focus-ownership.js';
import { desktopBridge as sharedDesktopBridge } from '../lib/desktop-bridge.js';

type ThemeMode = 'light' | 'dark';

/** Reads the app theme from the `data-theme` attribute set on `<html>`. */
function currentThemeMode(): ThemeMode {
  if (typeof document === 'undefined') {
    return 'dark';
  }
  return document.documentElement.getAttribute('data-theme') === 'light'
    ? 'light'
    : 'dark';
}

/**
 * The xterm palette for each app theme. Dark keeps the original deep-navy shell;
 * light uses a white background with dark text and a VS Code Light+ ANSI palette
 * so CLI output (including bright colours) stays readable on white.
 */
function xtermTheme(mode: ThemeMode): ITheme {
  if (mode === 'light') {
    return {
      background: '#ffffff',
      foreground: '#0f172a',
      cursor: '#4f46e5',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(79, 70, 229, 0.20)',
      black: '#000000',
      red: '#cd3131',
      green: '#00a33f',
      yellow: '#946b00',
      blue: '#0451a5',
      magenta: '#a5289c',
      cyan: '#0598a6',
      white: '#4b5563',
      brightBlack: '#64748b',
      brightRed: '#cd3131',
      brightGreen: '#14953b',
      brightYellow: '#8a7100',
      brightBlue: '#0451a5',
      brightMagenta: '#a5289c',
      brightCyan: '#0598a6',
      brightWhite: '#1f2937',
    };
  }
  return {
    background: '#0a0f1e',
    foreground: '#c9d6ef',
    cursor: '#818cf8',
    selectionBackground: 'rgba(129, 140, 248, 0.3)',
  };
}

/** The subset of the Electron preload bridge this component uses. */
interface DesktopClipboard extends DesktopClipboardBridge {
  openExternal?: (url: string) => void;
}

function desktopBridge(): DesktopClipboard | undefined {
  return sharedDesktopBridge();
}

function isAllowedExternalUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return (
      protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
    );
  } catch {
    return false;
  }
}

function openExternal(url: string): void {
  if (!isAllowedExternalUrl(url)) {
    return;
  }
  const bridge = desktopBridge();
  if (bridge?.openExternal) {
    bridge.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Normalises copied terminal text to the host's clipboard line-ending
 * convention (CRLF on Windows, LF elsewhere) via the pure `toClipboardText`
 * helper. Detecting the platform here keeps that helper DOM-free and testable.
 */
function hostIsWindows(): boolean {
  return typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
}

/**
 * Terminal-only normalization; the shared writer reports acknowledged outcomes.
 */
function copyToClipboard(text: string) {
  return copyText(toClipboardText(text, hostIsWindows()));
}

/** Reads text from the OS clipboard, preferring the native desktop bridge. */
async function readClipboard(): Promise<string> {
  const bridge = desktopBridge();
  if (bridge?.readText) {
    try {
      return await bridge.readText();
    } catch {
      return '';
    }
  }
  if (navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Reads an image or copied file from the clipboard via the native desktop
 * bridge. Failure is distinct from absence and never permits text fallback.
 */
async function readClipboardAttachment(sessionId: string): Promise<ClipboardAttachmentResult> {
  const bridge = desktopBridge();
  if (bridge?.readImage) {
    try {
      return await bridge.readImage({ sessionId });
    } catch {
      return { status: 'error', error: 'attachment-unavailable' };
    }
  }
  return { status: 'error', error: 'attachment-unavailable' };
}

/**
 * Embeds a live interactive CLI terminal for a single session. Renders an
 * xterm.js terminal, opens a WebSocket to the backend PTY bridge, and pipes
 * keystrokes and resize events to the process while writing its output back.
 * Keyed by sessionId so switching sessions remounts a fresh terminal.
 */
export function TerminalView({
  sessionId,
  onExit,
}: {
  sessionId: string;
  onExit?: (code: number | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const focusTokenRef = useRef(0);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const termRef = useRef<Terminal | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<{ state: TerminalState; notice: string }>({ state: 'connecting', notice: '' });
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(currentThemeMode);
  const themeModeRef = useRef(themeMode);
  themeModeRef.current = themeMode;

  // Track the app theme (set as `data-theme` on <html>) so the terminal can
  // switch its palette live — white shell with dark text in light mode.
  useEffect(() => {
    const sync = () => setThemeMode(currentThemeMode());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  // Re-theme the live terminal instance when the app theme toggles, without
  // remounting it (which would drop scrollback and the WebSocket).
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = xtermTheme(themeMode);
    }
  }, [themeMode]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    setAttachmentError(null);
    host.dataset.focusOwner = `terminal:${sessionId}`;
    host.dataset.focusToken = String(focusTokenRef.current);

    const windowsPtyOptions = hostIsWindows()
      ? { windowsPty: { backend: 'conpty' as const } }
      : {};
    const term = new Terminal({
      // The hosted CLI is a full-screen TUI that draws and blinks its own
      // cursor via escape sequences. Letting xterm ALSO run its own blink timer
      // fights those continuous redraws (spinners/streaming output reset the
      // timer), which shows up as a rapid, erratic cursor flicker. Disable
      // xterm's blink so the application owns the cursor — steady and IDE-like.
      cursorBlink: false,
      // When the terminal loses DOM focus, xterm's default inactive style is a
      // faint hollow "outline" that is nearly invisible on this dark theme, so
      // the shell looks frozen even though it is fine. Keep a solid block so the
      // cursor stays visible regardless of focus.
      cursorStyle: 'block',
      cursorInactiveStyle: 'block',
      fontFamily:
        'JetBrains Mono, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      allowProposedApi: true,
      linkHandler: {
        activate: (_event, uri) => openExternal(uri),
        allowNonHttpProtocols: true,
      },
      scrollback: 5000,
      theme: xtermTheme(themeModeRef.current),
      ...windowsPtyOptions,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const webLinks = new WebLinksAddon((_event, uri) => openExternal(uri));
    term.loadAddon(webLinks);
    term.open(host);
    termRef.current = term;

    // Suppress xterm's automatic reply to the CLI's OSC color-palette *queries*
    // at the source. xterm answers OSC 4/10/11/12 `?` queries by emitting the
    // reply through onData (the PTY stdin channel); the hosted CLI mis-parses it
    // and injects the printable body (`4;0;rgb:2e2e/3434/3636…`) into its input
    // line. A custom OSC handler that returns true marks the sequence handled so
    // xterm's built-in responder never runs — killing the reply before it can be
    // generated, regardless of onData chunking. Palette *sets* (no `?`) return
    // false and fall through to xterm's default handler, so the CLI can still
    // recolor the terminal. The onData strip below stays as defense-in-depth.
    for (const ident of COLOR_QUERY_OSC_IDENTS) {
      term.parser.registerOscHandler(ident, (payload) => isColorQuery(payload));
    }
    const focusTerminal = (respectExternalFocus: boolean) => {
      if (hasOpenModalDialog()) {
        return;
      }
      const active = document.activeElement;
      if (
        respectExternalFocus &&
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== document.documentElement &&
        active !== host &&
        !host.contains(active)
      ) {
        return;
      }
      try {
        term.focus();
      } catch {
        /* terminal may be disposed during teardown; ignore */
      }
    };

    // Focus immediately on open so keyboard copy (Ctrl/Cmd+C on a selection)
    // works right away on a fresh session, but never steal it from an existing
    // dialog or an explicit user target outside the terminal host.
    focusTerminal(true);

    // Render with the GPU (WebGL) instead of xterm's default DOM renderer.
    // The DOM renderer positions each row as a separate element and, when the
    // viewport is scrolled back over output a full-screen TUI drew with cursor
    // moves, leaves misaligned/overlapping rows — the "garbled, unreadable"
    // scrollback the user saw. The WebGL renderer paints every cell onto one
    // grid canvas, so scrollback stays pixel-aligned and legible. If the GPU
    // context is unavailable or is later lost (driver reset, tab backgrounding),
    // dispose the addon so xterm transparently falls back to the DOM renderer.
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      webgl?.dispose();
      webgl = null;
    }

    const repaintViewport = () => {
      if (replayAwaitingTerminalSettle) {
        pendingFitNeedsRepaint = true;
        return;
      }
      webgl?.clearTextureAtlas();
      termRef.current?.refresh(0, term.rows - 1);
    };

    // The FitAddon can only size the terminal once xterm has measured a
    // character cell (which happens asynchronously after `open`). Firing a
    // single fit synchronously leaves the terminal at its default 24 rows, so
    // retry across a few frames/delays until the pane is filled.
    const rafIds: number[] = [];
    const timeoutIds = new Set<number>();
    const scheduleTimeout = (callback: () => void, delay: number) => {
      const id = window.setTimeout(() => {
        timeoutIds.delete(id);
        callback();
      }, delay);
      timeoutIds.add(id);
      return id;
    };
    const cancelTrackedTimeout = (id: number | undefined) => {
      if (id === undefined) {
        return;
      }
      if (timeoutIds.delete(id)) {
        window.clearTimeout(id);
      }
    };

    const base = resolveApiBase(
      typeof window !== 'undefined' ? window.__CW_API_BASE__ : undefined,
      import.meta.env.VITE_API_BASE,
    );
    let ws: WebSocket;
    let disposed = false;
    let reconnects = 0;
    let reconnectTimer: number | undefined;
    const delivery = createTerminalDelivery({
      send: (message) => {
        if (ws.readyState !== WebSocket.OPEN) throw new Error('Socket is not open');
        ws.send(encodeClientMessage(message));
      },
      status: (state, notice) => setConnectionStatus({ state, notice }),
    });
    setConnectionStatus({ state: 'connecting', notice: '' });

    const sendResize = () => {
      delivery.resize(term.cols, term.rows);
    };

    let replayBarrierId = 0;
    let replayPendingWrites = 0;
    let replayBarrierSealed = false;
    let replayAwaitingTerminalSettle = false;
    let replayNeedsRepaint = false;
    const cancelReplayBarrier = () => {
      replayBarrierId += 1;
      replayPendingWrites = 0;
      replayBarrierSealed = false;
      replayAwaitingTerminalSettle = false;
      replayNeedsRepaint = false;
    };
    const settleReplayBarrier = () => {
      if (!replayAwaitingTerminalSettle || !replayBarrierSealed) {
        return;
      }
      if (replayPendingWrites > 0) {
        return;
      }
      const repaint = replayNeedsRepaint;
      cancelReplayBarrier();
      requestFit({ repaint });
    };
    const beginReplayBarrier = () => {
      replayBarrierId += 1;
      replayPendingWrites = 0;
      replayBarrierSealed = false;
      replayAwaitingTerminalSettle = true;
      replayNeedsRepaint = true;
    };
    const sealReplayBarrier = () => {
      if (!replayAwaitingTerminalSettle) {
        return;
      }
      replayBarrierSealed = true;
      settleReplayBarrier();
    };
    const trackReplayWrite = () => {
      if (!replayAwaitingTerminalSettle || replayBarrierSealed) {
        return null;
      }
      const barrierId = replayBarrierId;
      replayPendingWrites += 1;
      return () => {
        if (disposed || barrierId !== replayBarrierId) {
          return;
        }
        replayPendingWrites = Math.max(0, replayPendingWrites - 1);
        settleReplayBarrier();
      };
    };

    let pendingFit = false;
    let pendingFitNeedsRepaint = false;
    let dragActive = false;
    const performFit = () => {
      if (replayAwaitingTerminalSettle || dragActive) {
        return false;
      }
      if (host.clientWidth === 0 || host.clientHeight === 0) {
        return false;
      }
      // Never refit while the user has an active selection. FitAddon.fit() calls
      // term.resize(), and xterm clears the visual selection on any real resize.
      // On a fresh session the initial fit-retry burst (0/60/160/320/600ms)
      // would otherwise wipe a selection the instant the user makes it, so
      // Ctrl+C / copy-on-select appears to "do nothing" until the burst ends —
      // then starts working once fits settle. Deferring the fit keeps the
      // selection intact so copying works immediately, even on a new session.
      if (term.hasSelection()) {
        return false;
      }
      try {
        fit.fit();
        return true;
      } catch {
        /* xterm throws if measured before layout; ignore and retry */
        return false;
      }
    };
    const flushPendingFit = () => {
      if (!pendingFit) {
        return;
      }
      if (!performFit()) {
        return;
      }
      pendingFit = false;
      sendResize();
      if (pendingFitNeedsRepaint) {
        pendingFitNeedsRepaint = false;
        repaintViewport();
      }
    };
    const requestFit = ({ repaint = false }: { repaint?: boolean } = {}) => {
      pendingFit = true;
      pendingFitNeedsRepaint ||= repaint;
      flushPendingFit();
    };

    // Coalesce bursts of resize events (e.g. the sidebar collapse/expand
    // animation fires the ResizeObserver on every frame) into a single fit at
    // the settled width. Refitting mid-animation sizes xterm to intermediate
    // widths and floods the CLI TUI with resizes, which garbles/truncates its
    // reflowed output. Debouncing to the trailing edge sends one clean final
    // fit+resize once the width stops changing, then redraws.
    let settleTimer: number | undefined;
    const applyFitSettled = () => {
      cancelTrackedTimeout(settleTimer);
      settleTimer = scheduleTimeout(() => {
        settleTimer = undefined;
        // Clear cached glyphs and repaint so any stale cells from the old width
        // cannot survive into the newly wrapped viewport.
        requestFit({ repaint: true });
      }, 120);
    };

    rafIds.push(requestAnimationFrame(() => requestFit()));
    for (const delay of [0, 60, 160, 320, 600]) {
      scheduleTimeout(() => requestFit(), delay);
    }

    const dataSub = term.onData((data) => {
      // Strip xterm's OSC color-query replies before they reach the PTY: the
      // hosted CLI mis-parses them and injects their printable body into its
      // input line, mixing garbage like `4;0;rgb:2e2e/3434/3636` into what the
      // user is typing. Keystrokes and CSI cursor/DA replies are unaffected.
      const outbound = stripTerminalColorReports(data);
      delivery.offer(outbound);
    });

    const writeClipboard = (text: string) => {
      return copyToClipboard(text);
    };

    // Copy-on-select, done right. The hosted CLI enables any-event mouse
    // tracking, so every mouse move is reported to the app, which re-renders and
    // can clear xterm's visual selection mid-drag — often before a following
    // Ctrl+C could read it. So we CACHE the latest non-empty selection here (a
    // cheap ref update, NOT a clipboard write) and copy it once at the end of a
    // drag (see the mouseup handler). Writing to the OS clipboard on every
    // selection change — as this did before — clobbered whatever the user had
    // copied elsewhere on any stray click/drag in the terminal.
    let lastSelection = '';
    let selectedDuringDrag = false;
    const selectionSub = term.onSelectionChange(() => {
      const selection = term.getSelection();
      if (selection) {
        lastSelection = selection;
        selectedDuringDrag = true;
      } else if (!dragActive) {
        flushPendingFit();
      }
    });

    // The WebGL renderer can leave stale, shifted rows behind when the user
    // scrolls back over reflowed/wrapped output: rows that scroll into view keep
    // pixels from whatever was previously painted at that grid position, so the
    // scrollback looks garbled and horizontally clipped until the next write.
    // Forcing a full repaint of the visible rows on every scroll keeps what is
    // shown pixel-aligned with the buffer, whichever direction the user scrolls.
    const scrollSub = term.onScroll(() => {
      repaintViewport();
    });

    const pasteGuard = createPasteGuard();
    let clipboardMounted = true;
    let inputGeneration = 0;
    let terminalGeneration = 0;
    const invalidateClipboardRead = () => { inputGeneration++; };
    const syncFocusToken = () => {
      host.dataset.focusOwner = `terminal:${sessionId}`;
      host.dataset.focusToken = String(focusTokenRef.current);
    };
    const invalidateFocusToken = () => {
      focusTokenRef.current += 1;
      syncFocusToken();
    };
    const onClipboardFocusOut = (event: FocusEvent) => {
      if (!isInternalClipboardFocusTransfer(event)) invalidateClipboardRead();
    };
    const onWindowBlur = () => {
      invalidateClipboardRead();
      dragActive = false;
      selectedDuringDrag = false;
      lastSelection = '';
    };
    host.addEventListener('focusout', onClipboardFocusOut);
    window.addEventListener('blur', onWindowBlur);
    const captureInput = () => {
      const generation = inputGeneration;
      const target = document.activeElement;
      return () => clipboardMounted && generation === inputGeneration &&
        !!target && host.contains(target) && target === document.activeElement;
    };
    const paste = (text: string) => {
      if (text) term.paste(text);
    };

    // Bridge-based paste for the right-click path only (a context-menu paste
    // fires no native `paste` event, so xterm won't handle it). This path is
    // text-only; the keyboard path does NOT use it — see onPaste.
    const pasteFromClipboard = async () => {
      const ownsInput = captureInput();
      if (!ownsInput()) return;
      const text = await readClipboard();
      if (ownsInput() && text) {
        paste(text);
      }
      // Deliberately TEXT-only. A right-click carries no paste intent for a
      // binary image, so silently attaching whatever bitmap happens to sit on
      // the clipboard (as a temp-file path) would splice that path into text the
      // user is composing. Image/file attach stays on the explicit Ctrl/Cmd+V
      // paste path (`onPaste`), which the user invokes on purpose.
    };

    // Terminal clipboard shortcuts. Ctrl/Cmd+C copies when there is a
    // selection (otherwise it must fall through as SIGINT); Ctrl/Cmd+V pastes.
    // The explicit Shift variants always copy/paste, matching common terminals.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') {
        return true;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        return true;
      }
      const key = e.key.toLowerCase();

      if (key === 'c') {
        if (term.hasSelection()) {
          e.preventDefault();
          writeClipboard(term.getSelection());
          return false;
        }
        // No selection: swallow the explicit Ctrl+Shift+C, let plain Ctrl+C
        // through so it still sends an interrupt to the running process.
        return !e.shiftKey;
      }

      if (key === 'v') {
        // Only block xterm from emitting a literal ^V (0x16). Do NOT paste here:
        // returning false makes xterm ignore the key WITHOUT calling
        // preventDefault, so the browser still fires a native `paste` event —
        // which our capture-phase `onPaste` listener owns and handles once.
        return false;
      }

      return true;
    });

    // We OWN the paste completely. This capture-phase listener sits on the host
    // (an ancestor of xterm's element/textarea), so it runs first and can shut
    // down every other paste path:
    //   - `preventDefault()` stops the browser's default action, which would
    //     otherwise insert the pasted text into xterm's hidden textarea; xterm's
    //     input handler then re-sends it — the source of the double paste. Note
    //     xterm 5.5.0's own `handlePasteEvent` only calls `stopPropagation()`,
    //     NOT `preventDefault()`, so it does not prevent this on its own.
    //   - `stopImmediatePropagation()` prevents the event from ever reaching
    //     xterm's own `paste` listeners (bound to both textarea and element), so
    //     xterm never pastes a second time either.
    // We then paste exactly once: the text directly, or a shell-ready path from
    // the native bridge for an image/copied file with no text.
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      // JS-dispatched events are not native clipboard evidence. Browser/menu
      // editing events may be trusted; the menu must not create a second path.
      if (!event.isTrusted || !pasteGuard.shouldPaste(event)) {
        return;
      }
      const ownsInput = captureInput();
      if (!ownsInput()) return;
      const data = event.clipboardData;
      const text = data?.getData('text/plain') ?? '';
      if (text) {
        paste(text);
        return;
      }
      const hasImageOrFile =
        !!data &&
        (data.files.length > 0 ||
          Array.from(data.items).some((it) => it.kind === 'file'));
      if (hasImageOrFile) {
        setAttachmentError(null);
        void readClipboardAttachment(sessionId).then((result) => {
          if (!ownsInput()) return;
          if (!result || result.status === 'error' || result.status === 'none') {
            setAttachmentError(attachmentFailureMessage(result?.status === 'error' ? result.error : 'attachment-unavailable'));
            return;
          }
          let text: string;
          try {
            if (result.source === 'clipboard-image' && result.sessionId !== sessionId) throw new Error('Session changed');
            text = attachmentPasteText(result, hostIsWindows());
          } catch {
            setAttachmentError(attachmentFailureMessage('invalid-response'));
            return;
          }
          try {
            paste(text);
          } catch {
            setAttachmentError('Attachment delivery is unconfirmed. Check the terminal before retrying; input was not replayed.');
          }
        });
      }
    };
    host.addEventListener('paste', onPaste, { capture: true });
    const onCopy = (event: ClipboardEvent) => {
      if (!term.hasSelection()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void writeClipboard(term.getSelection());
    };
    host.addEventListener('copy', onCopy, { capture: true });

    // Right-click acts as copy-when-selected / paste-otherwise, the familiar
    // Windows-terminal convention, so text can be copied without a shortcut.
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (term.hasSelection()) {
        const selection = term.getSelection();
        const ownsInput = captureInput();
        void writeClipboard(selection).then((result) => {
          if (result.ok && ownsInput() && term.getSelection() === selection) term.clearSelection();
        });
      } else {
        void pasteFromClipboard();
      }
    };
    host.addEventListener('contextmenu', onContextMenu);

    // The terminal can silently lose DOM focus (clicking the sidebar/another
    // panel, or the OS window losing then regaining focus). An unfocused
    // terminal swallows keystrokes and can look hung, so aggressively refocus:
    // any pointer press inside the host, and whenever the window regains focus.
    const refocus = () => {
      flushPendingFit();
      focusTerminal(true);
    };
    let refocusTimer: number | undefined;
    const onHostMouseDown = () => {
      // Start of a fresh interaction: reset the copy-on-select capture so a
      // plain click (no drag) never copies and never clobbers the clipboard.
      selectedDuringDrag = false;
      lastSelection = '';
      dragActive = true;
      // Defer so xterm's own selection/focus handling runs first.
      cancelTrackedTimeout(refocusTimer);
      refocusTimer = scheduleTimeout(() => {
        refocusTimer = undefined;
        focusTerminal(false);
      }, 0);
    };
    host.addEventListener('mousedown', onHostMouseDown);
    // Copy-on-select fires exactly once, at the END of a drag that actually
    // selected text — using the cached selection so it survives the TUI's
    // mid-drag re-render. A click with no drag selects nothing and copies
    // nothing, so the user's existing clipboard is left untouched. The listener
    // lives on `window` (not the host) so a drag that ends OUTSIDE the terminal
    // — e.g. selecting down to the last line and releasing past its edge, a very
    // common gesture — still copies instead of silently dropping the selection.
    const onDocumentMouseUp = () => {
      if (!dragActive) {
        return;
      }
      dragActive = false;
      if (selectedDuringDrag && lastSelection) {
        copyToClipboard(lastSelection);
      }
      flushPendingFit();
    };
    window.addEventListener('mouseup', onDocumentMouseUp);
    window.addEventListener('focus', refocus);

    const connect = () => {
      ws = new WebSocket(buildTerminalWsUrl(base, sessionId, window.location));
      ws.onopen = () => {
        requestFit();
      };
      ws.onmessage = (event) => {
        const message = decodeServerMessage(String(event.data));
        if (!message) {
          invalidateClipboardRead();
          invalidateFocusToken();
          cancelReplayBarrier();
          delivery.disconnect(false);
          ws.close(4400, 'Incompatible terminal protocol');
          return;
        }
        if (message.type === 'state') {
          if (
            (terminalGeneration !== 0 && terminalGeneration !== message.generation) ||
            message.state === 'reconnecting' ||
            message.state === 'failed'
          ) {
            invalidateClipboardRead();
            invalidateFocusToken();
            cancelReplayBarrier();
          }
          if (message.state === 'closed') {
            invalidateClipboardRead();
            invalidateFocusToken();
          }
          terminalGeneration = message.generation;
          syncFocusToken();
        }
        delivery.receive(message);
        if (message.type === 'state' && message.state === 'closed') {
          sealReplayBarrier();
        }
        if (message.type === 'state' && message.state === 'ready') {
          reconnects = 0;
          if (replayAwaitingTerminalSettle) {
            sealReplayBarrier();
          } else {
            requestFit();
          }
        }
        if (message.type === 'output') {
          const onWritten = trackReplayWrite();
          if (onWritten) {
            term.write(message.data, onWritten);
          } else {
            term.write(message.data);
          }
        } else if (message.type === 'resize') {
          // Replay uses the capture grid, then the existing fit path restores
          // the pane dimensions after the retained output has been written.
          beginReplayBarrier();
          if (message.cols > 0 && message.rows > 0) {
            try {
              term.resize(message.cols, message.rows);
            } catch {
              /* xterm may reject before layout; the fit burst still recovers */
            }
          }
        } else if (message.type === 'exit') {
          invalidateClipboardRead();
          invalidateFocusToken();
          const footer = `\r\n\x1b[90m[session ended${
            message.code === null ? '' : ` · exit ${message.code}`
          }]\x1b[0m\r\n`;
          // xterm processes writes FIFO: this finite fence also covers any
          // replay or live output already queued before the exit footer.
          beginReplayBarrier();
          const onWritten = trackReplayWrite();
          if (onWritten) {
            term.write(footer, onWritten);
            sealReplayBarrier();
          } else {
            term.write(footer);
          }
          onExitRef.current?.(message.code);
        }
      };
      ws.onerror = () => {
        invalidateClipboardRead();
        invalidateFocusToken();
        cancelReplayBarrier();
        setConnectionStatus((previous) => ({
          ...previous,
          notice: 'Terminal connection failed; waiting for reconnect.',
        }));
      };
      ws.onclose = (event) => {
        if (disposed) return;
        invalidateClipboardRead();
        invalidateFocusToken();
        cancelReplayBarrier();
        const retry = event.code < 4400 && reconnects++ < 3;
        delivery.disconnect(retry);
        if (retry) reconnectTimer = window.setTimeout(connect, 1000);
      };
    };
    connect();

    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => applyFitSettled())
        : null;
    observer?.observe(host);
    window.addEventListener('resize', applyFitSettled);

    return () => {
      clipboardMounted = false;
      disposed = true;
      window.clearTimeout(reconnectTimer);
      invalidateClipboardRead();
      invalidateFocusToken();
      cancelReplayBarrier();
      cancelTrackedTimeout(refocusTimer);
      cancelTrackedTimeout(settleTimer);
      host.removeEventListener('focusout', onClipboardFocusOut);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('resize', applyFitSettled);
      window.removeEventListener('focus', refocus);
      window.removeEventListener('mouseup', onDocumentMouseUp);
      host.removeEventListener('mousedown', onHostMouseDown);
      host.removeEventListener('contextmenu', onContextMenu);
      host.removeEventListener('paste', onPaste, { capture: true });
      host.removeEventListener('copy', onCopy, { capture: true });
      observer?.disconnect();
      for (const id of rafIds) {
        cancelAnimationFrame(id);
      }
      for (const id of timeoutIds) {
        window.clearTimeout(id);
      }
      timeoutIds.clear();
      dataSub.dispose();
      selectionSub.dispose();
      scrollSub.dispose();
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      webgl?.dispose();
      webLinks.dispose();
      term.dispose();
      termRef.current = null;
      delete host.dataset.focusOwner;
      delete host.dataset.focusToken;
    };
  }, [sessionId, connectionAttempt]);

  return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
    <div role="status" aria-live="polite" style={{ flexShrink: 0, fontSize: 12 }}>
      Terminal: {connectionStatus.state}
      {connectionStatus.notice && <span> — {connectionStatus.notice}</span>}
      {(connectionStatus.state === 'failed' || connectionStatus.state === 'closed') &&
        <button onClick={() => setConnectionAttempt((value) => value + 1)}>Reconnect (input is not replayed)</button>}
    </div>
    {attachmentError && <div role="alert" style={{ flexShrink: 0, fontSize: 12 }}>{attachmentError}</div>}
    <div className="terminal-host" style={{ flex: 1, minHeight: 0 }} ref={hostRef} />
  </div>;
}

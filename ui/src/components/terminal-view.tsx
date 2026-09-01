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
} from '../lib/terminal-protocol.js';
import { toClipboardText, createPasteGuard } from '../lib/clipboard.js';

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
interface DesktopClipboard {
  openExternal?: (url: string) => void;
  copyText?: (text: string) => void;
  readText?: () => Promise<string>;
  readImage?: () => Promise<string>;
}

function desktopBridge(): DesktopClipboard | undefined {
  return (window as unknown as { desktop?: DesktopClipboard }).desktop;
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
 * Writes text to the OS clipboard as robustly as possible. In the packaged
 * desktop app this routes through Electron's native clipboard (reliable), then
 * falls back to the async Clipboard API and finally a synchronous
 * `execCommand('copy')` for plain browsers — so a copy never silently no-ops.
 */
function copyToClipboard(text: string): void {
  if (!text) {
    return;
  }
  const normalized = toClipboardText(text, hostIsWindows());
  const bridge = desktopBridge();
  if (bridge?.copyText) {
    bridge.copyText(normalized);
    return;
  }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(normalized).catch(() => {
      legacyCopy(normalized);
    });
    return;
  }
  legacyCopy(normalized);
}

/** Synchronous clipboard write via a transient textarea (browser fallback). */
function legacyCopy(text: string): void {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    area.style.pointerEvents = 'none';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
  } catch {
    /* nothing else we can do */
  }
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
 * bridge, returning a shell-ready path (a temp PNG for a raw screenshot, or the
 * source path for a copied file). Empty when there's no image/file to paste.
 */
async function readClipboardImagePath(): Promise<string> {
  const bridge = desktopBridge();
  if (bridge?.readImage) {
    try {
      return await bridge.readImage();
    } catch {
      return '';
    }
  }
  return '';
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
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const termRef = useRef<Terminal | null>(null);
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
    // Focus immediately on open so keyboard copy (Ctrl/Cmd+C on a selection)
    // works right away on a fresh session, rather than only after the WebSocket
    // connects and calls focus() in ws.onopen.
    term.focus();

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
      webgl?.clearTextureAtlas();
      termRef.current?.refresh(0, term.rows - 1);
    };

    const safeFit = () => {
      if (host.clientWidth === 0 || host.clientHeight === 0) {
        return;
      }
      // Never refit while the user has an active selection. FitAddon.fit() calls
      // term.resize(), and xterm clears the visual selection on any real resize.
      // On a fresh session the initial fit-retry burst (0/60/160/320/600ms)
      // would otherwise wipe a selection the instant the user makes it, so
      // Ctrl+C / copy-on-select appears to "do nothing" until the burst ends —
      // then starts working once fits settle. Deferring the fit keeps the
      // selection intact so copying works immediately, even on a new session.
      if (term.hasSelection()) {
        return;
      }
      try {
        fit.fit();
      } catch {
        /* xterm throws if measured before layout; ignore and retry */
      }
    };

    // The FitAddon can only size the terminal once xterm has measured a
    // character cell (which happens asynchronously after `open`). Firing a
    // single fit synchronously leaves the terminal at its default 24 rows, so
    // retry across a few frames/delays until the pane is filled.
    const rafIds: number[] = [];
    const timeoutIds: number[] = [];

    const base = resolveApiBase(
      typeof window !== 'undefined' ? window.__CW_API_BASE__ : undefined,
      import.meta.env.VITE_API_BASE,
    );
    const ws = new WebSocket(
      buildTerminalWsUrl(base, sessionId, window.location),
    );

    let lastSentCols = 0;
    let lastSentRows = 0;

    const sendResize = () => {
      // Only notify the PTY when the grid dimensions actually change. The fresh
      // session fit-retry burst calls applyFit five times in the first 600ms;
      // without this guard each one re-sends the same cols/rows, flooding the
      // CLI TUI with redundant SIGWINCH redraws that can garble input being
      // pasted at that moment. Deduping keeps at most one resize per real size.
      if (
        ws.readyState === WebSocket.OPEN &&
        (term.cols !== lastSentCols || term.rows !== lastSentRows)
      ) {
        lastSentCols = term.cols;
        lastSentRows = term.rows;
        ws.send(
          encodeClientMessage({
            type: 'resize',
            cols: term.cols,
            rows: term.rows,
          }),
        );
      }
    };

    const applyFit = () => {
      safeFit();
      sendResize();
    };

    // Coalesce bursts of resize events (e.g. the sidebar collapse/expand
    // animation fires the ResizeObserver on every frame) into a single fit at
    // the settled width. Refitting mid-animation sizes xterm to intermediate
    // widths and floods the CLI TUI with resizes, which garbles/truncates its
    // reflowed output. Debouncing to the trailing edge sends one clean final
    // fit+resize once the width stops changing, then redraws.
    let settleTimer: number | undefined;
    const applyFitSettled = () => {
      if (settleTimer !== undefined) {
        window.clearTimeout(settleTimer);
      }
      settleTimer = window.setTimeout(() => {
        settleTimer = undefined;
        applyFit();
        // Clear cached glyphs and repaint so any stale cells from the old width
        // cannot survive into the newly wrapped viewport.
        repaintViewport();
      }, 120);
      timeoutIds.push(settleTimer);
    };

    rafIds.push(requestAnimationFrame(applyFit));
    for (const delay of [0, 60, 160, 320, 600]) {
      timeoutIds.push(window.setTimeout(applyFit, delay));
    }

    const dataSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeClientMessage({ type: 'input', data }));
      }
    });

    const writeClipboard = (text: string) => {
      copyToClipboard(text);
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

    // Collapse duplicate pastes delivered as one user action (see
    // createPasteGuard). 40ms is far below deliberate double-paste speed, so a
    // real repeat is never suppressed, but a doubled single paste is.
    const pasteGuard = createPasteGuard(40);
    const paste = (text: string) => {
      if (text && pasteGuard.shouldPaste(text, Date.now())) {
        term.paste(text);
      }
    };

    // Bridge-based paste for the right-click path only (a context-menu paste
    // fires no native `paste` event, so xterm won't handle it): text first, then
    // an image/file fallback. The keyboard path does NOT use this — see onPaste.
    const pasteFromClipboard = async () => {
      const text = await readClipboard();
      if (text) {
        paste(text);
        return;
      }
      paste(await readClipboardImagePath());
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
        void readClipboardImagePath().then(paste);
      }
    };
    host.addEventListener('paste', onPaste, { capture: true });

    // Right-click acts as copy-when-selected / paste-otherwise, the familiar
    // Windows-terminal convention, so text can be copied without a shortcut.
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (term.hasSelection()) {
        writeClipboard(term.getSelection());
        term.clearSelection();
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
      try {
        term.focus();
      } catch {
        /* terminal may be disposed during teardown; ignore */
      }
    };
    let dragActive = false;
    const onHostMouseDown = () => {
      // Start of a fresh interaction: reset the copy-on-select capture so a
      // plain click (no drag) never copies and never clobbers the clipboard.
      selectedDuringDrag = false;
      lastSelection = '';
      dragActive = true;
      // Defer so xterm's own selection/focus handling runs first.
      timeoutIds.push(window.setTimeout(refocus, 0));
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
    };
    window.addEventListener('mouseup', onDocumentMouseUp);
    window.addEventListener('focus', refocus);

    ws.onopen = () => {
      safeFit();
      sendResize();
      term.focus();
    };
    ws.onmessage = (event) => {
      const message = decodeServerMessage(String(event.data));
      if (!message) {
        return;
      }
      if (message.type === 'output') {
        term.write(message.data);
      } else if (message.type === 'exit') {
        term.write(
          `\r\n\x1b[90m[session ended${
            message.code === null ? '' : ` · exit ${message.code}`
          }]\x1b[0m\r\n`,
        );
        onExitRef.current?.(message.code);
      }
    };

    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => applyFitSettled())
        : null;
    observer?.observe(host);
    window.addEventListener('resize', applyFitSettled);

    return () => {
      window.removeEventListener('resize', applyFitSettled);
      window.removeEventListener('focus', refocus);
      window.removeEventListener('mouseup', onDocumentMouseUp);
      host.removeEventListener('mousedown', onHostMouseDown);
      host.removeEventListener('contextmenu', onContextMenu);
      host.removeEventListener('paste', onPaste, { capture: true });
      observer?.disconnect();
      for (const id of rafIds) {
        cancelAnimationFrame(id);
      }
      for (const id of timeoutIds) {
        clearTimeout(id);
      }
      dataSub.dispose();
      selectionSub.dispose();
      scrollSub.dispose();
      ws.onopen = null;
      ws.onmessage = null;
      ws.close();
      webgl?.dispose();
      webLinks.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId]);

  return <div className="terminal-host" ref={hostRef} />;
}

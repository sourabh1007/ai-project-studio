import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { resolveApiBase } from '../lib/api-base.js';
import { buildTerminalWsUrl } from '../lib/terminal-url.js';
import {
  decodeServerMessage,
  encodeClientMessage,
} from '../lib/terminal-protocol.js';

/** The subset of the Electron preload bridge this component uses. */
interface DesktopClipboard {
  copyText?: (text: string) => void;
  readText?: () => Promise<string>;
}

function desktopBridge(): DesktopClipboard | undefined {
  return (window as unknown as { desktop?: DesktopClipboard }).desktop;
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
  const bridge = desktopBridge();
  if (bridge?.copyText) {
    bridge.copyText(text);
    return;
  }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {
      legacyCopy(text);
    });
    return;
  }
  legacyCopy(text);
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

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const term = new Terminal({
      // The hosted CLI is a full-screen TUI that draws and blinks its own
      // cursor via escape sequences. Letting xterm ALSO run its own blink timer
      // fights those continuous redraws (spinners/streaming output reset the
      // timer), which shows up as a rapid, erratic cursor flicker. Disable
      // xterm's blink so the application owns the cursor — steady and IDE-like.
      cursorBlink: false,
      fontFamily:
        'JetBrains Mono, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      allowProposedApi: true,
      scrollback: 5000,
      theme: {
        background: '#0a0f1e',
        foreground: '#c9d6ef',
        cursor: '#818cf8',
        selectionBackground: 'rgba(129, 140, 248, 0.3)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const safeFit = () => {
      if (host.clientWidth === 0 || host.clientHeight === 0) {
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

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
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

    const paste = (text: string) => {
      if (text && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeClientMessage({ type: 'input', data: text }));
      }
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
        void readClipboard().then(paste);
        return false;
      }

      return true;
    });

    // Right-click acts as copy-when-selected / paste-otherwise, the familiar
    // Windows-terminal convention, so text can be copied without a shortcut.
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (term.hasSelection()) {
        writeClipboard(term.getSelection());
        term.clearSelection();
      } else {
        void readClipboard().then(paste);
      }
    };
    host.addEventListener('contextmenu', onContextMenu);

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
        ? new ResizeObserver(() => applyFit())
        : null;
    observer?.observe(host);
    window.addEventListener('resize', applyFit);

    return () => {
      window.removeEventListener('resize', applyFit);
      host.removeEventListener('contextmenu', onContextMenu);
      observer?.disconnect();
      for (const id of rafIds) {
        cancelAnimationFrame(id);
      }
      for (const id of timeoutIds) {
        clearTimeout(id);
      }
      dataSub.dispose();
      ws.onopen = null;
      ws.onmessage = null;
      ws.close();
      term.dispose();
    };
  }, [sessionId]);

  return <div className="terminal-host" ref={hostRef} />;
}

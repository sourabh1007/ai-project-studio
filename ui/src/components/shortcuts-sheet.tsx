import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  formatChord,
  type ShortcutBinding,
} from '../lib/keyboard-shortcuts.js';
import { attachDialogFocusOwnership } from '../lib/focus-ownership.js';

interface ShortcutsSheetProps {
  open: boolean;
  bindings: ShortcutBinding[];
  onClose: () => void;
}

/**
 * A discoverable overlay listing every keyboard shortcut and its chord. Opened
 * from the command palette or with Ctrl+/ and dismissed with Esc or a click
 * outside. Purely presentational — the bindings come from the shared registry.
 */
export function ShortcutsSheet({ open, bindings, onClose }: ShortcutsSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const panel = panelRef.current;
    if (!panel) {
      return undefined;
    }
    return attachDialogFocusOwnership(panel);
  }, [open]);

  if (!open) {
    return null;
  }
  return createPortal(
    <div
      className="cmdk-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        className="shortcuts-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="shortcuts-header">Keyboard shortcuts</div>
        <ul className="shortcuts-list">
          {bindings.map((binding) => (
            <li key={binding.id} className="shortcuts-row">
              <span className="shortcuts-title">{binding.title}</span>
              <kbd className="shortcuts-chord">{formatChord(binding)}</kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}

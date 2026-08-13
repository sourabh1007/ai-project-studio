import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Command, filterCommands } from '../lib/command-palette.js';
import { SearchIcon } from './icons.js';

/** A palette command paired with the action to run when it is chosen. */
export interface PaletteCommand extends Command {
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
}

/**
 * The Ctrl+K command palette overlay. Fuzzy-filters the registry via the pure
 * `filterCommands` helper and is fully keyboard-driven: type to filter,
 * Up/Down to move, Enter to run, Esc to dismiss. Rendered in a portal so it
 * floats above the whole app shell.
 */
export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(
    () => filterCommands(commands, query),
    [commands, query],
  );

  // Reset the query and selection each time the palette opens, and focus input.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // Focus after paint so the element exists and is focusable.
      const id = window.requestAnimationFrame(() => inputRef.current?.focus());
      return () => window.cancelAnimationFrame(id);
    }
    return undefined;
  }, [open]);

  // Keep the active index within the current result bounds as filtering changes.
  useEffect(() => {
    setActive((prev) => {
      if (results.length === 0) return 0;
      return Math.min(prev, results.length - 1);
    });
  }, [results]);

  // Scroll the active row into view when it changes.
  useEffect(() => {
    const node = listRef.current?.children[active] as HTMLElement | undefined;
    node?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) {
    return null;
  }

  const run = (command: PaletteCommand | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((prev) =>
        results.length === 0 ? 0 : (prev + 1) % results.length,
      );
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((prev) =>
        results.length === 0 ? 0 : (prev - 1 + results.length) % results.length,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(results[active]);
    }
  };

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
        className="cmdk-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <div className="cmdk-search">
          <SearchIcon size={16} />
          <input
            ref={inputRef}
            className="cmdk-input"
            type="text"
            placeholder="Type a command…"
            value={query}
            aria-label="Command palette search"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
        </div>
        {results.length === 0 ? (
          <div className="cmdk-empty">No matching commands</div>
        ) : (
          <ul className="cmdk-list" ref={listRef} role="listbox">
            {results.map((command, index) => (
              <li
                key={command.id}
                role="option"
                aria-selected={index === active}
                className={`cmdk-item ${index === active ? 'is-active' : ''}`.trim()}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  run(command);
                }}
              >
                <span className="cmdk-item-title">{command.title}</span>
                {command.section ? (
                  <span className="cmdk-item-section">{command.section}</span>
                ) : null}
                {command.shortcut ? (
                  <kbd className="cmdk-item-shortcut">{command.shortcut}</kbd>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}

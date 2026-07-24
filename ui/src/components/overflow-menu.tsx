import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreIcon } from './icons.js';

export interface OverflowAction {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
}

/**
 * Compact "⋯" overflow menu that collapses a row's secondary actions into a
 * hover-revealed dropdown, keeping list rows uncluttered. Closes on outside
 * click, Escape, or after an action is chosen.
 */
export function OverflowMenu({
  actions,
  label = 'More actions',
}: {
  actions: OverflowAction[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onDocClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="overflow-menu" ref={ref}>
      <button
        type="button"
        className="tree-action overflow-trigger"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreIcon />
      </button>
      {open && (
        <div className="overflow-pop" role="menu">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              className={`overflow-item ${action.danger ? 'overflow-item-danger' : ''}`.trim()}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
            >
              {action.icon && (
                <span className="overflow-item-icon" aria-hidden="true">
                  {action.icon}
                </span>
              )}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

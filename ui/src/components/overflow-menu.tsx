import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreIcon } from './icons.js';

export interface OverflowAction {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
}

interface PopPosition {
  top: number;
  right: number;
  origin: 'top' | 'bottom';
}

const MENU_MARGIN = 4;
const ESTIMATED_ITEM_HEIGHT = 30;

function computePosition(trigger: DOMRect, itemCount: number): PopPosition {
  const right = Math.max(MENU_MARGIN, window.innerWidth - trigger.right);
  const estimatedHeight = itemCount * ESTIMATED_ITEM_HEIGHT + 8;
  const spaceBelow = window.innerHeight - trigger.bottom;
  const openUp = spaceBelow < estimatedHeight + MENU_MARGIN && trigger.top > spaceBelow;
  if (openUp) {
    return {
      top: Math.max(MENU_MARGIN, trigger.top - MENU_MARGIN),
      right,
      origin: 'bottom',
    };
  }
  return { top: trigger.bottom + 2, right, origin: 'top' };
}

/**
 * Compact "⋯" overflow menu that collapses a row's secondary actions into a
 * hover-revealed dropdown. The popup is rendered in a portal with fixed
 * positioning so it escapes ancestor stacking contexts and `overflow` clipping
 * (which previously let list rows paint over the menu and swallow clicks).
 * Closes on outside click, Escape, scroll, or after an action is chosen.
 */
export function OverflowMenu({
  actions,
  label = 'More actions',
  icon,
  triggerClassName = 'tree-action overflow-trigger',
}: {
  actions: OverflowAction[];
  label?: string;
  icon?: ReactNode;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      return;
    }
    setPos(computePosition(triggerRef.current.getBoundingClientRect(), actions.length));
  }, [open, actions.length]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onDocPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }
    function onReposition() {
      setOpen(false);
    }
    document.addEventListener('mousedown', onDocPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    return () => {
      document.removeEventListener('mousedown', onDocPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
    };
  }, [open]);

  return (
    <div className="overflow-menu">
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {icon ?? <MoreIcon />}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className={`overflow-pop overflow-pop-${pos.origin}`}
            role="menu"
            style={{ top: pos.top, right: pos.right }}
          >
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
          </div>,
          document.body,
        )}
    </div>
  );
}

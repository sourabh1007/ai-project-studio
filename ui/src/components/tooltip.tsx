import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

/** Pointer- and keyboard-accessible tooltip, rendered outside clipping panes. */
export function Tooltip({ label, children }: {
  label: string;
  children: ReactElement<{ title?: string; 'aria-describedby'?: string }>;
}) {
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const clear = () => clearTimeout(timer.current);
  const hide = () => { clear(); setVisible(false); };
  const leave = () => {
    clear();
    if (!trigger.current?.contains(document.activeElement)) {
      timer.current = setTimeout(() => setVisible(false), 100);
    }
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!visible) return;
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('resize', hide);
      window.removeEventListener('scroll', hide, true);
    };
  }, [visible]);
  useLayoutEffect(() => {
    if (!visible || !trigger.current || !bubble.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const tip = bubble.current.getBoundingClientRect();
    const top = anchor.top >= tip.height + 12 ? anchor.top - tip.height - 8 : anchor.bottom + 8;
    setPosition({
      left: Math.max(8, Math.min(window.innerWidth - tip.width - 8, anchor.left + (anchor.width - tip.width) / 2)),
      top: Math.max(8, Math.min(window.innerHeight - tip.height - 8, top)),
    });
  }, [visible, label]);

  return (
    <span ref={trigger} className="tooltip-trigger"
      onMouseEnter={() => { clear(); timer.current = setTimeout(() => setVisible(true), 300); }}
      onMouseLeave={leave}
      onFocus={() => { clear(); setVisible(true); }}
      onBlur={hide}
      onClick={hide}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && visible) {
          event.stopPropagation();
          hide();
        }
      }}
    >
      {cloneElement(children, {
        title: undefined,
        'aria-describedby': visible
          ? [children.props['aria-describedby'], id].filter(Boolean).join(' ')
          : children.props['aria-describedby'],
      })}
      {visible && createPortal(
        <div ref={bubble} id={id} role="tooltip" className="tooltip-bubble"
          style={position} onMouseEnter={clear} onMouseLeave={leave}>
          {label}
        </div>, document.body,
      )}
    </span>
  );
}

import { useId, useState, type ReactNode } from 'react';
import { useAnimatedPresence } from '../hooks/use-motion.js';
import { ChevronIcon } from './icons.js';

export function Disclosure({ summary, children, className }: {
  summary: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { present } = useAnimatedPresence(open, '--motion-panel-duration');
  const id = useId();
  return (
    <details className={`disclosure ${className ?? ''}`} open={present}>
      <summary aria-expanded={open} aria-controls={id} onClick={(event) => {
        event.preventDefault();
        setOpen((value) => !value);
      }}>
        <ChevronIcon size={14} open={open} />
        {summary}
      </summary>
      <div id={id} className={`disclosure-grid${open ? ' is-open' : ''}`}
        aria-hidden={!open || undefined} ref={(node) => { node?.toggleAttribute('inert', !open); }}>
        <div className="disclosure-inner">{children}</div>
      </div>
    </details>
  );
}

import { useEffect, useRef, type PointerEvent } from 'react';
import { createDisposer } from '../lib/disposer.js';
import { DragHandleIcon } from './icons.js';

export function PaneResizer({
  label, className, value, min, max, resetValue, onChange, reverse = false,
  units = 'pixels', dragScale = 1,
}: {
  label: string;
  className: string;
  value: number;
  min: number;
  max: number;
  resetValue: number;
  onChange: (value: number) => void;
  reverse?: boolean;
  units?: string;
  /** Number of pixels per value unit, measured when a drag starts. */
  dragScale?: number | (() => number);
}) {
  const disposer = useRef(createDisposer());
  useEffect(() => {
    const current = disposer.current;
    return () => current.dispose();
  }, []);

  const change = (next: number) => onChange(Math.min(max, Math.max(min, next)));
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const scale = typeof dragScale === 'function' ? dragScale() : dragScale;
    if (scale <= 0) return;
    const startX = event.clientX;
    const pointerId = event.pointerId;
    const current = disposer.current;
    current.dispose();
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId === pointerId) {
        change(value + (next.clientX - startX) / scale * (reverse ? -1 : 1));
      }
    };
    const stop = () => current.dispose();
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
    document.body.classList.add('is-resizing');
    current.add(() => document.removeEventListener('pointermove', move));
    current.add(() => document.removeEventListener('pointerup', stop));
    current.add(() => document.removeEventListener('pointercancel', stop));
    current.add(() => window.removeEventListener('blur', stop));
    current.add(() => document.body.classList.remove('is-resizing'));
  };

  return (
    <div
      className={`pane-resizer ${className}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)} ${units}`}
      tabIndex={0}
      title="Drag or use Left/Right arrows to resize; Home/End for limits; double-click or Enter to reset"
      onPointerDown={start}
      onDoubleClick={() => change(resetValue)}
      onKeyDown={(event) => {
        const step = units === 'pixels' ? (event.shiftKey ? 40 : 10) : (event.shiftKey ? 10 : 2);
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          change(value + (event.key === 'ArrowRight' ? step : -step) * (reverse ? -1 : 1));
        } else if (event.key === 'Home' || event.key === 'End' || event.key === 'Enter') {
          event.preventDefault();
          change(event.key === 'Home' ? min : event.key === 'End' ? max : resetValue);
        }
      }}
    >
      <span className="pane-resizer-grip" aria-hidden="true"><DragHandleIcon size={14} /></span>
    </div>
  );
}

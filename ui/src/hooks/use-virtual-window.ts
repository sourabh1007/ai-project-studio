import { useEffect, useRef, useState } from 'react';
import {
  computeVirtualWindow,
  type VirtualWindow,
} from '../lib/virtual-window.js';

interface Params {
  rowHeight: number;
  rowCount: number;
  overscan?: number;
}

/**
 * Wires a scroll container to the pure {@link computeVirtualWindow} math. Attach
 * the returned `ref` to a scrollable element; the hook tracks its scroll offset
 * and measured height (via a ResizeObserver when available) and returns the
 * current render window. Generic over the element type so it works with any
 * scroll container (e.g. a `<div>` wrapping a table).
 */
export function useVirtualWindow<E extends HTMLElement>({
  rowHeight,
  rowCount,
  overscan = 6,
}: Params): { ref: React.RefObject<E>; window: VirtualWindow } {
  const ref = useRef<E>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      setScrollTop(el.scrollTop);
      setViewportHeight(el.clientHeight);
    };
    measure();

    el.addEventListener('scroll', measure, { passive: true });

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(el);
    } else {
      window.addEventListener('resize', measure);
    }

    return () => {
      el.removeEventListener('scroll', measure);
      if (observer) {
        observer.disconnect();
      } else {
        window.removeEventListener('resize', measure);
      }
    };
  }, [rowCount, rowHeight]);

  const virtualWindow = computeVirtualWindow({
    scrollTop,
    viewportHeight,
    rowHeight,
    rowCount,
    overscan,
  });

  return { ref, window: virtualWindow };
}

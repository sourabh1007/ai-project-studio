import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Motion } from '../lib/ui-preferences.js';

/** Shared policy for JavaScript animations; CSS follows the same preferences. */
export function useMotion(): Motion {
  const [media] = useState(() => typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)') : null);
  const subscribe = useCallback((notify: () => void) => {
    const observer = new MutationObserver(notify);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    media?.addEventListener('change', notify);
    return () => {
      observer.disconnect();
      media?.removeEventListener('change', notify);
    };
  }, [media]);
  const snapshot = useCallback((): Motion => {
    const choice = document.documentElement.getAttribute('data-motion');
    if (choice === 'off') return 'off';
    return choice === 'reduced' || media?.matches ? 'reduced' : 'full';
  }, [media]);
  return useSyncExternalStore(subscribe, snapshot);
}

/** Retain closing surfaces until their shared CSS transition finishes. */
export function useAnimatedPresence(
  open: boolean,
  token: '--motion-panel-duration' | '--motion-overlay-duration',
  onExited?: () => void,
): { present: boolean; exiting: boolean } {
  const motion = useMotion();
  const [retained, setRetained] = useState(open);
  const callback = useRef(onExited);
  callback.current = onExited;
  useLayoutEffect(() => {
    if (open) {
      setRetained(true);
      return;
    }
    if (!retained) return;
    const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    // Production CSS optimizers can rewrite milliseconds to fractional seconds.
    const duration = motion === 'full'
      ? (Number.parseFloat(raw) || 0) * (raw.endsWith('ms') ? 1 : 1000) : 0;
    const finish = () => {
      setRetained(false);
      callback.current?.();
    };
    if (duration === 0) {
      finish();
      return;
    }
    const timer = window.setTimeout(finish, duration);
    return () => window.clearTimeout(timer);
  }, [open, retained, motion, token]);
  return { present: open || retained, exiting: !open && retained };
}

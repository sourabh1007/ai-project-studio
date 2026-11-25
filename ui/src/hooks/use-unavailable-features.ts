import { useCallback, useEffect } from 'react';
import { usePersistentState } from './use-persistent-state.js';
import { UNAVAILABLE_FEATURES_CHANGED, UNAVAILABLE_FEATURES_KEY } from '../lib/provider-features.js';

export function useUnavailableFeatures() {
  const [enabled, setEnabled] = usePersistentState(UNAVAILABLE_FEATURES_KEY, false, {
    validate: (value): value is boolean => typeof value === 'boolean',
  });
  useEffect(() => {
    const changed = (event: Event) => {
      if (event instanceof StorageEvent) {
        if (event.key === UNAVAILABLE_FEATURES_KEY || event.key === null) setEnabled(event.newValue === 'true');
      } else {
        const value: unknown = (event as CustomEvent<unknown>).detail;
        if (typeof value === 'boolean') setEnabled(value);
      }
    };
    window.addEventListener(UNAVAILABLE_FEATURES_CHANGED, changed);
    window.addEventListener('storage', changed);
    return () => {
      window.removeEventListener(UNAVAILABLE_FEATURES_CHANGED, changed);
      window.removeEventListener('storage', changed);
    };
  }, [setEnabled]);
  const set = useCallback((value: boolean) => {
    setEnabled(value);
    window.dispatchEvent(new CustomEvent(UNAVAILABLE_FEATURES_CHANGED, { detail: value }));
  }, [setEnabled]);
  return [enabled, set] as const;
}

import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  prImportStore,
  type PrImportEvent,
  type PrImportJob,
  type PrImportStore,
} from '../lib/pr-import-store.js';

/** Live snapshot of every tracked pull-request import. */
export function usePrImports(store: PrImportStore = prImportStore): readonly PrImportJob[] {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * Subscribes to successful imports for the lifetime of the calling component.
 * Imports that finished while no component listened are replayed on mount, so
 * a review is never left un-queued because the explorer was unmounted. The
 * handler may change every render without resubscribing.
 */
export function usePrImportEvents(
  onEvent: (event: PrImportEvent) => void,
  store: PrImportStore = prImportStore,
): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => store.subscribeEvents((event) => handler.current(event)), [store]);
}

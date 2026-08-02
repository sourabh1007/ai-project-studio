import { useSyncExternalStore } from 'react';
import {
  getActivitySnapshot,
  subscribeActivity,
  type ActivitySnapshot,
} from '../lib/activity.js';

/** Subscribes a component to the global activity store. */
export function useActivity(): ActivitySnapshot {
  return useSyncExternalStore(
    subscribeActivity,
    getActivitySnapshot,
    getActivitySnapshot,
  );
}

import { useEffect, useSyncExternalStore } from 'react';
import { useApi } from '../app/api-context.js';
import type { ApiClient } from '../lib/api.js';

/** Dispatched after an in-app GitHub sign-in/out so identity views refresh now. */
export const GITHUB_AUTH_CHANGED_EVENT = 'github-auth-changed';

export interface GithubIdentity {
  /** False until the first status check completes. */
  checked: boolean;
  login: string | null;
  avatarUrl: string | null;
}

interface IdentityStore {
  value: GithubIdentity;
  listeners: Set<() => void>;
  inFlight: Promise<void> | null;
  users: number;
  stop: (() => void) | null;
}

const UNCHECKED: GithubIdentity = { checked: false, login: null, avatarUrl: null };
const stores = new WeakMap<ApiClient, IdentityStore>();

/** GitHub serves every user's public avatar at a stable, login-derived URL. */
export function githubAvatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=96`;
}

function storeFor(api: ApiClient): IdentityStore {
  let store = stores.get(api);
  if (!store) {
    store = { value: UNCHECKED, listeners: new Set(), inFlight: null, users: 0, stop: null };
    stores.set(api, store);
  }
  return store;
}

function refresh(api: ApiClient, store: IdentityStore): Promise<void> {
  store.inFlight ??= Promise.resolve().then(() => api.getGithubStatus()).then((status) => {
    const login = status.authenticated ? status.login : null;
    if (store.value.checked && store.value.login === login) return;
    store.value = { checked: true, login, avatarUrl: login ? githubAvatarUrl(login) : null };
    for (const listener of store.listeners) listener();
  }).catch(() => {
    /* Transient failures keep the last known identity. */
  }).finally(() => { store.inFlight = null; });
  return store.inFlight;
}

/**
 * The signed-in GitHub identity, shared by every consumer of one API client so
 * the dock avatar and Explorer accounts never poll twice. Refreshes on mount,
 * window focus, explicit auth changes and once a minute.
 */
export function useGithubIdentity(intervalMs = 60_000): GithubIdentity {
  const api = useApi();
  const store = storeFor(api);
  useEffect(() => {
    store.users += 1;
    if (store.users === 1) {
      const update = () => { void refresh(api, store); };
      update();
      const timer = window.setInterval(update, intervalMs);
      window.addEventListener('focus', update);
      window.addEventListener(GITHUB_AUTH_CHANGED_EVENT, update);
      store.stop = () => {
        window.clearInterval(timer);
        window.removeEventListener('focus', update);
        window.removeEventListener(GITHUB_AUTH_CHANGED_EVENT, update);
      };
    }
    return () => {
      store.users -= 1;
      if (store.users === 0) {
        store.stop?.();
        store.stop = null;
      }
    };
  }, [api, store, intervalMs]);
  return useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    () => store.value,
  );
}

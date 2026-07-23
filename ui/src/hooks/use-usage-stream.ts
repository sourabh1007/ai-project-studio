import { useEffect, useReducer } from 'react';
import {
  applyStreamEvent,
  initialLiveState,
  parseServerEvent,
  type LiveState,
  type StreamEvent,
} from '../lib/stream.js';
import { resolveApiBase } from '../lib/api-base.js';

const STREAM_EVENT_NAMES = [
  'session.started',
  'session.output',
  'session.ended',
  'session.updated',
  'usage.recorded',
] as const;

function reducer(state: LiveState, event: StreamEvent): LiveState {
  return applyStreamEvent(state, event);
}

/**
 * Subscribes to the backend SSE usage stream and maintains a reduced live
 * state (sessions, per-session output lines, deduped usage). The base path is
 * config-driven via VITE_API_BASE and defaults to the Vite-proxied /api.
 */
export function useUsageStream(): LiveState {
  const [state, dispatch] = useReducer(reducer, initialLiveState);

  useEffect(() => {
    const base = resolveApiBase(
      typeof window !== 'undefined' ? window.__CW_API_BASE__ : undefined,
      import.meta.env.VITE_API_BASE,
    );
    const source = new EventSource(`${base}/stream`);
    const handlers = STREAM_EVENT_NAMES.map((name) => {
      const handler = (raw: MessageEvent<string>) => {
        const parsed = parseServerEvent(name, raw.data);
        if (parsed) {
          dispatch(parsed);
        }
      };
      source.addEventListener(name, handler as EventListener);
      return { name, handler };
    });
    return () => {
      for (const { name, handler } of handlers) {
        source.removeEventListener(name, handler as EventListener);
      }
      source.close();
    };
  }, []);

  return state;
}

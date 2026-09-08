import { useEffect, useReducer } from 'react';
import {
  applyStreamEvent,
  initialLiveState,
  parseServerEvent,
  MAX_LIVE_EVENT_CHARACTERS,
  type LiveState,
  type StreamEvent,
} from '../lib/stream.js';
import { resolveApiBase } from '../lib/api-base.js';
import { failActivity } from '../lib/activity.js';

const STREAM_EVENT_NAMES = [
  'session.started',
  'session.ended',
  'session.updated',
  'session.file',
  'session.notice',
  'usage.recorded',
  'repository.context.updated',
  'context.status',
  'automation.updated',
  'automation.removed',
  'subagent.updated',
  'review.board.activity',
] as const;

function reducer(state: LiveState, event: StreamEvent): LiveState {
  return applyStreamEvent(state, event);
}

/**
 * Subscribes to the backend SSE usage stream and maintains a reduced live
 * state (sessions and deduped usage). Terminal output uses its own WebSocket.
 * The base path is
 * config-driven via VITE_API_BASE and defaults to the Vite-proxied /api.
 */
export function useUsageStream(): LiveState {
  const [state, dispatch] = useReducer(reducer, initialLiveState);

  useEffect(() => {
    const base = resolveApiBase(
      typeof window !== 'undefined' ? window.__CW_API_BASE__ : undefined,
      import.meta.env.VITE_API_BASE,
    );
    const source = new EventSource(`${base}/stream?output=0`);
    const interrupted = () => dispatch({ type: 'stream.interrupted' });
    const reconnected = () => dispatch({ type: 'stream.reconnected' });
    source.addEventListener('error', interrupted);
    source.addEventListener('open', reconnected);
    const handlers = STREAM_EVENT_NAMES.map((name) => {
      const handler = (raw: MessageEvent<string>) => {
        if (raw.data.length > MAX_LIVE_EVENT_CHARACTERS) {
          dispatch({ type: 'stream.truncated' });
          return;
        }
        const parsed = parseServerEvent(name, raw.data);
        if (!parsed) {
          return;
        }
        // A self-recovery failure surfaces on the status bar rather than the
        // live session state, so route error notices straight to the activity
        // store and skip the reducer.
        if (parsed.type === 'session.notice') {
          if (parsed.level === 'error') {
            failActivity(parsed.message);
          }
          return;
        }
        dispatch(parsed);
      };
      source.addEventListener(name, handler as EventListener);
      return { name, handler };
    });
    return () => {
      source.removeEventListener('error', interrupted);
      source.removeEventListener('open', reconnected);
      for (const { name, handler } of handlers) {
        source.removeEventListener(name, handler as EventListener);
      }
      source.close();
    };
  }, []);

  return state;
}

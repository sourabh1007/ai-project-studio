import type { EventBus } from '../kernel/event-bus.js';
import type { SessionEventMap } from '../session/session-launcher.js';
import type { UsageRecordedMap } from '../usage/usage-recorder.js';
import type { RepositoryContextEventMap } from '../repository-context/repository-context-coordinator.js';
import type { PrReviewEventMap } from '../pr-review/pr-review-contract.js';

/** Combined event map streamed to clients over SSE. */
export type StreamEventMap = SessionEventMap &
  UsageRecordedMap &
  RepositoryContextEventMap &
  PrReviewEventMap;

export type StreamEventName = keyof StreamEventMap;

/** Transport-agnostic sink for server-sent events. */
export interface SseSink {
  send(event: string, data: unknown): void;
}

const STREAM_EVENTS: StreamEventName[] = [
  'session.started',
  'session.output',
  'session.ended',
  'session.updated',
  'usage.recorded',
  'repository.context.updated',
  'pr.review.updated',
];

/**
 * Forwards every workspace stream event onto an {@link SseSink}. Returns an
 * unsubscribe function that detaches all handlers. Kept transport-agnostic so
 * it is fully unit-testable without an HTTP response.
 */
export function subscribeStream(
  bus: EventBus<StreamEventMap>,
  sink: SseSink,
): () => void {
  const offs = STREAM_EVENTS.map((event) =>
    bus.on(event, (payload) => {
      if (
        event.startsWith('session.') &&
        'scope' in (payload as object) &&
        (payload as { scope?: string }).scope === 'internal'
      ) {
        return;
      }
      sink.send(event as string, payload);
    }),
  );
  return () => {
    for (const off of offs) {
      off();
    }
  };
}

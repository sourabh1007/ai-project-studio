import {
  toResponse,
  type LayoutRequest,
} from '../../lib/change-graph-worker-protocol.js';

/**
 * Dedicated web worker that computes change-graph layouts off the main thread
 * (Phase 2e). It owns no state: each message is a self-contained `LayoutRequest`
 * that it routes through the shared pure `toResponse` and posts back. Typed via a
 * minimal local view of the worker scope so it needs no `webworker` lib in the
 * DOM-configured tsconfig.
 */
const ctx = self as unknown as {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: LayoutRequest }) => void,
  ): void;
};

ctx.addEventListener('message', (event) => {
  ctx.postMessage(toResponse(event.data));
});

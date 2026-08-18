import { useEffect, useRef, useState } from 'react';
import type { ChangeGraphLayout } from '../../lib/change-graph-layout.js';
import {
  computeLayout,
  type LayoutRequest,
  type LayoutResponse,
} from '../../lib/change-graph-worker-protocol.js';

/** A layout request without its correlation id (the hook assigns ids). */
export type LayoutSpec =
  | Omit<Extract<LayoutRequest, { kind: 'full' }>, 'id'>
  | Omit<Extract<LayoutRequest, { kind: 'focused' }>, 'id'>;

function specToRequest(spec: LayoutSpec, id: number): LayoutRequest {
  return { ...spec, id } as LayoutRequest;
}

function createWorker(): Worker | null {
  if (typeof Worker === 'undefined') {
    return null;
  }
  try {
    return new Worker(
      new URL('./change-graph.worker.ts', import.meta.url),
      { type: 'module' },
    );
  } catch {
    // Some environments (tests, restricted sandboxes) cannot spawn workers.
    return null;
  }
}

/**
 * Computes a change-graph layout, offloading recomputes to a web worker so pan/
 * zoom/expand interactions never block the main thread (Phase 2e).
 *
 * The very first layout is computed synchronously so the initial paint is
 * immediately correct (no empty-graph flash); every subsequent recompute driven
 * by user interaction is posted to the worker and applied when it replies. Only
 * the newest request's response is honoured, so a burst of rapid toggles never
 * renders a stale layout. Where a worker cannot be created (e.g. jsdom tests),
 * it falls back to the identical pure computation on the main thread.
 */
export function useChangeGraphLayout(spec: LayoutSpec): ChangeGraphLayout {
  const [layout, setLayout] = useState<ChangeGraphLayout>(() =>
    computeLayout(specToRequest(spec, 0)),
  );
  const workerRef = useRef<Worker | null>(null);
  const nextId = useRef(0);
  const latestId = useRef(0);
  const firstRun = useRef(true);
  // The most recent request posted to the worker, so if the worker fails after
  // the fact we can recompute exactly what the UI is currently asking for.
  const latestRequest = useRef<LayoutRequest | null>(null);

  useEffect(() => {
    const worker = createWorker();
    workerRef.current = worker;
    if (worker) {
      worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
        if (event.data.id === latestId.current) {
          setLayout(event.data.layout);
        }
      };
      // A module worker can be constructed successfully yet fail to *load* or
      // execute later (a production bundling/format mismatch, a CSP quirk, a
      // parse error) — the constructor doesn't throw, so the try/catch in
      // createWorker never sees it. Without this handler `onmessage` would then
      // simply never fire, silently freezing every interaction that depends on
      // a recompute (expanding a module, zooming, toggling callers): the state
      // updates but the layout never does. On error, drop the worker and fall
      // back to the identical pure computation on the main thread — for the
      // request currently in flight and for every recompute thereafter.
      worker.onerror = () => {
        worker.terminate();
        if (workerRef.current === worker) {
          workerRef.current = null;
        }
        if (latestRequest.current) {
          setLayout(computeLayout(latestRequest.current));
        }
      };
    }
    return () => {
      worker?.terminate();
      workerRef.current = null;
    };
  }, []);

  const collapsedKey =
    spec.kind === 'full' ? [...spec.collapsed].join('\u0000') : '';
  const focusPath = spec.kind === 'focused' ? spec.focusPath : '';

  useEffect(() => {
    // The initial layout was already produced synchronously by useState; skip
    // the redundant first post so the worker only handles later recomputes.
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const id = (nextId.current += 1);
    latestId.current = id;
    const request = specToRequest(spec, id);
    latestRequest.current = request;
    const worker = workerRef.current;
    if (worker) {
      worker.postMessage(request);
    } else {
      setLayout(computeLayout(request));
    }
    // spec is rebuilt each render; the primitive keys below capture its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.kind, spec.step, spec.category, collapsedKey, focusPath]);

  return layout;
}

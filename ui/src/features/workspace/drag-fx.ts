/**
 * Drag lifecycle CSS-class side effects for tree rows, shared by the feature
 * tree and the explorer. Kept as tiny DOM helpers (no React state) so any
 * draggable row can opt into the same pickup / drop / cancel animations by
 * toggling classes on its own element:
 *
 *   - `is-dragging`  — applied while a row is picked up and being dragged.
 *   - `drag-dropped` — one-shot settle animation when the drag ends on a target.
 *   - `drag-cancel`  — one-shot spring-back animation when the drag is canceled
 *                      or released outside any drop target.
 *
 * The one-shot classes clear themselves on `animationend`, with a timeout
 * fallback for environments that never fire it (e.g. reduced-motion, tests).
 */

const PICKUP = 'is-dragging';
const DROPPED = 'drag-dropped';
const CANCELED = 'drag-cancel';
const ONE_SHOT_CLASSES = [DROPPED, CANCELED];

/** Max lifetime of a one-shot animation class before it is force-cleared (ms). */
const ONE_SHOT_TIMEOUT_MS = 600;

/** Marks a row as picked up. Call from the row's own `onDragStart`. */
export function beginDragFx(el: EventTarget | null): void {
  if (!(el instanceof HTMLElement)) {
    return;
  }
  el.classList.remove(...ONE_SHOT_CLASSES);
  el.classList.add(PICKUP);
}

/** True when the drag ended without landing on a drop target. */
function wasCanceled(event?: { dataTransfer?: DataTransfer | null }): boolean {
  const transfer = event?.dataTransfer;
  return !transfer || transfer.dropEffect === 'none';
}

/**
 * Ends the pickup state and plays the settle (dropped) or spring-back
 * (canceled) animation. Call from the row's own `onDragEnd`, forwarding the
 * event so the drop outcome can be detected.
 */
export function endDragFx(
  el: EventTarget | null,
  event?: { dataTransfer?: DataTransfer | null },
): void {
  if (!(el instanceof HTMLElement)) {
    return;
  }
  el.classList.remove(PICKUP);
  const outcome = wasCanceled(event) ? CANCELED : DROPPED;
  el.classList.add(outcome);
  const clear = () => el.classList.remove(outcome);
  el.addEventListener('animationend', clear, { once: true });
  window.setTimeout(clear, ONE_SHOT_TIMEOUT_MS);
}

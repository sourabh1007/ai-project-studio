/**
 * A tiny global store for notices that must outlive the dialog or view that
 * caused them (for example "created, but retry protection could not be cleaned
 * up" after the form that created the item has closed). It is read by a banner
 * mounted once in the app shell. Unlike the activity error it is not cleared by
 * the next request, only by the user.
 */

export interface OperationNoticeSnapshot {
  message: string | null;
  /** How many notices arrived since the last dismissal. */
  count: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: OperationNoticeSnapshot = { message: null, count: 0 };

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeOperationNotices(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getOperationNotices(): OperationNoticeSnapshot {
  return snapshot;
}

export function pushOperationNotice(message: string): void {
  snapshot = { message, count: snapshot.count + 1 };
  emit();
}

export function dismissOperationNotices(): void {
  if (snapshot.count === 0) return;
  snapshot = { message: null, count: 0 };
  emit();
}

/**
 * A tiny disposer bag for leak-safe teardown of imperative resources (Phase 2d).
 *
 * Most listeners/timers/observers in the app live inside `useEffect` and are
 * torn down by the effect's cleanup return. A few, though, are attached from
 * imperative event handlers (e.g. attaching document-level `mousemove`/`mouseup`
 * while a drag gesture is in progress). Those can leak if the component unmounts
 * mid-gesture, since no effect owns their teardown. This collects teardown
 * callbacks so they can all be disposed at once — from the gesture's natural end
 * AND from an unmount effect — making double-dispose a safe no-op.
 */
export interface Disposer {
  /** Register a teardown callback to run on the next {@link Disposer.dispose}. */
  add(teardown: () => void): void;
  /**
   * Run every registered teardown once, in reverse (LIFO) order, then clear the
   * bag. Safe to call repeatedly: a second call with nothing registered no-ops.
   * A throwing teardown never prevents the others from running.
   */
  dispose(): void;
  /** How many teardowns are currently registered. */
  readonly size: number;
}

export function createDisposer(): Disposer {
  let teardowns: (() => void)[] = [];
  return {
    add(teardown) {
      teardowns.push(teardown);
    },
    dispose() {
      const pending = teardowns;
      teardowns = [];
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        try {
          pending[i]();
        } catch {
          /* a failing teardown must not block the rest */
        }
      }
    },
    get size() {
      return teardowns.length;
    },
  };
}

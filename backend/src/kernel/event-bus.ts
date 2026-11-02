/**
 * Minimal typed publish/subscribe bus. Decouples the write path (usage capture)
 * from read-side consumers (aggregation, SSE controllers).
 */

export type EventHandler<T> = (payload: T) => void;

export interface EventBus<EventMap extends Record<string, unknown>> {
  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): () => void;
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void;
  handlerCount<K extends keyof EventMap>(event: K): number;
}

export interface EventBusOptions<EventMap extends Record<string, unknown>> {
  /**
   * Receives a subscriber failure so the emitter and sibling subscribers keep
   * running. Without it, every subscriber still runs and the failure is then
   * rethrown to the emitter rather than being swallowed.
   */
  onHandlerError?: (error: unknown, event: keyof EventMap) => void;
}

export function createEventBus<
  EventMap extends Record<string, unknown>,
>(options: EventBusOptions<EventMap> = {}): EventBus<EventMap> {
  const handlers = new Map<keyof EventMap, Set<EventHandler<never>>>();

  return {
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as EventHandler<never>);
      return () => {
        set!.delete(handler as EventHandler<never>);
      };
    },
    emit(event, payload) {
      const set = handlers.get(event);
      if (!set) {
        return;
      }
      const failures: unknown[] = [];
      for (const handler of set) {
        try {
          (handler as EventHandler<EventMap[typeof event]>)(payload);
        } catch (error) {
          failures.push(error);
        }
      }
      for (const error of failures) {
        if (!options.onHandlerError) continue;
        try {
          options.onHandlerError(error, event);
        } catch {
          // A failing reporter must not break the emitter or sibling subscribers.
        }
      }
      if (!options.onHandlerError && failures.length > 0) {
        throw failures.length === 1
          ? failures[0]
          : new AggregateError(failures, `${failures.length} event subscribers failed`);
      }
    },
    handlerCount(event) {
      return handlers.get(event)?.size ?? 0;
    },
  };
}

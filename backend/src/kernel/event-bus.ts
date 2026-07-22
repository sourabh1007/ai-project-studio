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

export function createEventBus<
  EventMap extends Record<string, unknown>,
>(): EventBus<EventMap> {
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
      for (const handler of set) {
        (handler as EventHandler<EventMap[typeof event]>)(payload);
      }
    },
    handlerCount(event) {
      return handlers.get(event)?.size ?? 0;
    },
  };
}

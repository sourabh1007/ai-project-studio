export interface McpConfigWrites {
  run<T>(path: string, action: () => Promise<T>): Promise<T>;
}

/** Share source locks between manager edits and narrowly scoped bridge repair. */
export function createMcpConfigWrites(): McpConfigWrites {
  const pending = new Map<string, Promise<unknown>>();
  return {
    async run(path, action) {
      const previous = pending.get(path) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(action);
      pending.set(path, next);
      try { return await next; }
      finally { if (pending.get(path) === next) pending.delete(path); }
    },
  };
}

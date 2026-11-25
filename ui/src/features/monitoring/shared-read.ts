const pending = new WeakMap<object, Map<string, Promise<unknown>>>();

export function sharedRead<T>(owner: object, key: string, load: () => Promise<T>): Promise<T> {
  let queries = pending.get(owner);
  if (!queries) { queries = new Map(); pending.set(owner, queries); }
  const existing = queries.get(key);
  if (existing) return existing as Promise<T>;
  if (queries.size >= 64) return Promise.reject(new Error('Too many concurrent insight queries; retry after current reads finish.'));
  const promise = Promise.resolve().then(load);
  queries.set(key, promise);
  const release = () => { if (queries.get(key) === promise) queries.delete(key); };
  void promise.then(release, release);
  return promise;
}

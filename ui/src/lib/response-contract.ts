/**
 * Targeted runtime validation for the few API responses whose *structure* the
 * UI relies on to render at all.
 *
 * `api.ts` casts every parsed body straight to its declared type. That cast is
 * a promise the network cannot keep: during an upgrade a stale or partly
 * started backend can answer 200 with a different shape, and a proxy can answer
 * 200 with an HTML page. The UI then fails deep inside a render with something
 * like "pools.map is not a function", which reads as a crash rather than as the
 * backend problem it actually is.
 *
 * Validation here is deliberately *narrow*: only the fields the UI iterates,
 * indexes or counts. Unknown extra fields and new optional fields are fine, so
 * a newer backend never trips an older UI. Each validator returns a problem
 * description, or null when the payload is usable.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Describes what arrived, without dumping a whole response into the UI. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/**
 * A body that is not a JSON object at all. This is the HTML-from-a-proxy and
 * bare-string case, and it is worth naming separately because the cause is
 * usually "you are not talking to the backend you think you are".
 */
export function validateObjectBody(path: string, body: unknown): string | null {
  return isRecord(body)
    ? null
    : `${path} returned ${describe(body)} instead of an object. The backend may be starting up or an old version may still be running.`;
}

/** `/meta/pools` — the settings page renders the pool and its sessions. */
export function validateMetaPoolsStatus(body: unknown): string | null {
  const objectProblem = validateObjectBody('/meta/pools', body);
  if (objectProblem) return objectProblem;
  const status = body as Record<string, unknown>;
  if (status.pool === undefined || status.pool === null) {
    // A disabled warm pool legitimately reports no pool at all.
    return null;
  }
  if (!isRecord(status.pool)) {
    return `/meta/pools returned ${describe(status.pool)} for the pool instead of an object.`;
  }
  // `sessions` is what the settings list renders per slot; a non-array here is
  // precisely the shape that used to blank the whole section.
  if (status.pool.sessions !== undefined && !Array.isArray(status.pool.sessions)) {
    return `/meta/pools returned ${describe(status.pool.sessions)} for the pool sessions instead of a list.`;
  }
  return null;
}

/** `/meta/operations` — paged, so a bad cursor silently loops forever. */
export function validateMetaOperationPage(body: unknown): string | null {
  const objectProblem = validateObjectBody('/meta/operations', body);
  if (objectProblem) return objectProblem;
  const page = body as Record<string, unknown>;
  if (!Array.isArray(page.items)) {
    return `/meta/operations returned no operation list (items was ${describe(page.items)}).`;
  }
  for (const [index, item] of page.items.entries()) {
    if (!isRecord(item) || typeof item.operationId !== 'string') {
      return `/meta/operations returned an entry at index ${index} with no operation id.`;
    }
  }
  // A cursor that is neither a string nor null cannot terminate paging.
  if (page.nextCursor !== null && typeof page.nextCursor !== 'string' &&
      page.nextCursor !== undefined) {
    return `/meta/operations returned ${describe(page.nextCursor)} as the page cursor.`;
  }
  return null;
}

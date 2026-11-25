import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDatabase } from '../persistence/db/connection.js';
import { applySchema } from '../persistence/db/schema.js';
import { createMetaOperationRepo } from '../persistence/meta-operation-repo.js';
import { createPromptUsageRepo } from '../persistence/prompt-usage-repo.js';
import type { MetaOperation } from '../meta/meta-operation-contract.js';
import type { HttpRequest } from './http-contract.js';
import { createPromptUsageRoutes } from './prompt-usage-controller.js';

let db: ReturnType<typeof createDatabase>;
beforeEach(() => { db = createDatabase({ databasePath: ':memory:' }); });
afterEach(() => db.close());
const from = '2026-01-01T00:00:00.000Z', to = '2026-02-01T00:00:00.000Z';
const op = (overrides: Partial<MetaOperation> = {}): MetaOperation => ({
  operationId: 'op', featureId: 'f', automationId: null, originSessionId: null,
  providerId: 'copilot', requestedModel: 'auto', resolvedModel: null, sessionId: 'shared',
  providerSessionId: 'vendor', sessionIds: ['shared'], transport: 'warm-acp',
  state: 'completed', outcome: 'returned', purpose: null, label: null,
  resultText: 'Private result', errorMessage: null, usageState: 'partial',
  usage: { inputTokens: 10, outputTokens: 2, nanoAiu: null, credits: null },
  createdAt: from, updatedAt: from, startedAt: from, finishedAt: from, ...overrides,
});
const req = (query: HttpRequest['query']): HttpRequest => ({ params: {}, query, body: null });

it('retains explicit template participation without inventing legacy attribution or shared-session totals', async () => {
  const operations = createMetaOperationRepo(db), usage = createPromptUsageRepo(db);
  operations.create(op({ operationId: 'legacy' }));
  operations.create(op({ promptRefs: ['one', 'two'], requestUsage: { inputTokens: 10, outputTokens: 2, nanoAiu: null, credits: null },
    usage: { inputTokens: 9999, outputTokens: 9999, nanoAiu: 9999, credits: 9999 } }));
  operations.create(op({ operationId: 'retry', promptRefs: ['one'], state: 'failed', usage: null }));
  operations.create(op({ operationId: 'end', promptRefs: ['one'], createdAt: to }));
  operations.create(op({ operationId: 'empty', promptRefs: [] }));
  usage.recordContext({ eventId: 'prep', promptRefs: [], sessionId: 's', providerId: 'copilot', kind: 'context-prepared', recordedAt: from });
  const event = { eventId: 'inject', promptRefs: ['one', 'one'], sessionId: 's', providerId: 'copilot',
    kind: 'context-injected' as const, recordedAt: from };
  usage.recordContext(event); usage.recordContext(event);
  usage.recordContext({ ...event, eventId: 'prep', kind: 'context-prepared' });
  const route = createPromptUsageRoutes({ usage, maxEvents: 100 })[0];
  const result = await route.handler(req({ from: '2026-01-01T00:00:00Z', to }));
  expect(result).toMatchObject({ status: 200, body: { limited: false, maxEvents: 100 } });
  const snapshot = usage.read({ from, to }, 100);
  expect(snapshot.events).toHaveLength(4);
  expect(snapshot.events.filter((row) => row.kind === 'request')).toEqual([
    expect.objectContaining({ eventId: 'request:retry', state: 'failed', usage: null }),
    expect.objectContaining({ eventId: 'request:op', usage: { inputTokens: 10, outputTokens: 2, nanoAiu: null, credits: null } }),
  ]);
  expect(snapshot.events.filter((row) => row.kind !== 'request').every((row) => row.usage === null)).toBe(true);
  expect(snapshot.events[0].promptRefs).toEqual(['one']);
  expect(JSON.stringify(result)).not.toContain('Private result');
  expect(usage.read({ from, to, promptRef: 'two' }, 1)).toMatchObject({ limited: false, events: [{ eventId: 'request:op' }] });
  expect(usage.read({ from, to, promptRef: 'one' }, 1)).toMatchObject({ limited: true, events: [{ eventId: 'request:retry' }] });
  expect(usage.read({ from, to, promptRef: "one' OR 1=1" }, 100).events).toEqual([]);
  expect(operations.get('op')?.promptRefs).toEqual(['one', 'two']);
  expect(operations.get('op')?.requestUsage?.inputTokens).toBe(10);
  expect(operations.listPage({}, null, 100).items.find((row) => row.operationId === 'legacy')?.promptRefs).toBeUndefined();
});

it('uses late dedicated-session charges but never reused warm-session totals without request metering', () => {
  const operations = createMetaOperationRepo(db), usage = createPromptUsageRepo(db);
  operations.create(op({ promptRefs: ['one'], transport: 'session' }));
  operations.create(op({ operationId: 'warm', promptRefs: ['one'] }));
  expect(usage.read({ from, to }, 100).events).toEqual([
    expect.objectContaining({ eventId: 'request:warm', usage: null }),
    expect.objectContaining({ eventId: 'request:op', usage: { inputTokens: 10, outputTokens: 2, nanoAiu: null, credits: null } }),
  ]);
});

it('upgrades a pre-attribution database without backfilling guessed prompt identities', () => {
  createMetaOperationRepo(db).create(op({ operationId: 'old' }));
  db.exec('ALTER TABLE usage.meta_operations DROP COLUMN prompt_refs_json');
  db.exec('ALTER TABLE usage.meta_operations DROP COLUMN request_usage_json');
  db.exec('DROP TABLE usage.prompt_context_events');
  applySchema(db);
  expect(createMetaOperationRepo(db).get('old')).toMatchObject({ operationId: 'old', resultText: 'Private result' });
  expect(createPromptUsageRepo(db).read({ from, to }, 100).events).toEqual([]);
});

it('filters hidden providers before bounding history and exposes the same data after eligibility returns', async () => {
  const operations = createMetaOperationRepo(db), usage = createPromptUsageRepo(db);
  operations.create(op({ providerId: 'agency', promptRefs: ['one'] }));
  operations.create(op({ operationId: 'unknown', providerId: null, promptRefs: ['one'] }));
  usage.recordContext({ eventId: 'agency', promptRefs: ['one'], sessionId: 's', providerId: 'agency', kind: 'context-prepared', recordedAt: from });
  let visible = false;
  const route = createPromptUsageRoutes({ usage, maxEvents: 1, microsoftSignedIn: () => visible })[0];
  expect(await route.handler(req({ from, to, promptRef: 'one' }))).toMatchObject({
    body: { limited: false, events: [{ eventId: 'request:unknown' }] },
  });
  visible = true;
  expect(await route.handler(req({ from, to }))).toMatchObject({ body: { limited: true } });
  expect(usage.read({ from, to, excludeProviderId: 'copilot' }, 100).events).toHaveLength(3);
});

it.each([
  {}, { from }, { from, to: from }, { from, to: '2027-02-01T00:00:00Z' },
  { from: 'bad', to }, { from, to, promptRef: '' }, { from, to, extra: 'field' },
])('rejects invalid prompt analytical windows %j', async (query) => {
  const usage = createPromptUsageRepo(db);
  expect(await createPromptUsageRoutes({ usage, maxEvents: 100 })[0].handler(req(query))).toMatchObject({ status: 400 });
});
it.each([0, 1001, 1.5, NaN])('bounds database reads even outside HTTP: %s', (limit) => {
  expect(() => createPromptUsageRepo(db).read({ from, to }, limit)).toThrow(RangeError);
});

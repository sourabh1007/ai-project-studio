'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHttpCacheCleanupHandler } = require('../http-cache-cleanup.cjs');

function setup(clearCache = async () => {}) {
  const mainFrame = {};
  const event = { trusted: true, senderFrame: mainFrame, sender: { mainFrame } };
  let calls = 0;
  const errors = [];
  const handler = createHttpCacheCleanupHandler({
    isTrustedSender: (event) => event.trusted,
    getSession: () => ({ clearCache: () => { calls++; return clearCache(); } }),
    now: () => 123,
    reportError: (error) => errors.push(error),
  });
  return { handler, event, errors, calls: () => calls };
}
test('clears only the fixed Electron HTTP cache with no paths/options/storage APIs', async () => {
  const { handler, event, calls } = setup();
  assert.deepEqual(await handler(event), {
    status: 'completed', scope: 'electron-http-cache', completedAt: 123, error: null,
  });
  assert.equal(calls(), 1);
});
test('coalesces callers while in flight and releases ownership after completion', async () => {
  let finish;
  const fixture = setup(() => new Promise((resolve) => { finish = resolve; }));
  const first = fixture.handler(fixture.event);
  assert.equal(fixture.handler(fixture.event), first);
  await Promise.resolve();
  assert.equal(fixture.calls(), 1);
  finish();
  await first;
  const next = fixture.handler(fixture.event);
  await Promise.resolve();
  assert.equal(fixture.calls(), 2);
  finish();
  await next;
});
test('rejects untrusted, missing or child frames and extra payloads before touching cache', async () => {
  const fixture = setup();
  for (const event of [
    { ...fixture.event, trusted: false },
    { ...fixture.event, senderFrame: null },
    { ...fixture.event, senderFrame: {} },
  ]) assert.equal((await fixture.handler(event)).status, 'failed');
  assert.equal((await fixture.handler(fixture.event, { path: 'C:\\', cookies: true })).status, 'failed');
  assert.equal(fixture.calls(), 0);
});
test('reports clearCache errors explicitly and permits a subsequent retry', async () => {
  const fixture = setup(async () => { throw new Error('disk locked'); });
  assert.match((await fixture.handler(fixture.event)).error, /disk locked/);
  assert.equal((await fixture.handler(fixture.event)).status, 'failed');
  assert.equal(fixture.calls(), 2);
  assert.deepEqual(fixture.errors, ['disk locked', 'disk locked']);
});
test('returns unavailable for missing capability and catches session lookup failures', async () => {
  const { event } = setup();
  for (const session of [null, {}]) {
    const handler = createHttpCacheCleanupHandler({
      isTrustedSender: () => true, getSession: () => session, now: () => 1, reportError: assert.fail,
    });
    assert.equal((await handler(event)).status, 'unavailable');
  }
  let reported;
  const handler = createHttpCacheCleanupHandler({
    isTrustedSender: () => true, getSession: () => { throw 'unavailable'; },
    now: () => 1, reportError: (message) => { reported = message; },
  });
  assert.equal((await handler(event)).status, 'failed');
  assert.equal(reported, 'unavailable');
});

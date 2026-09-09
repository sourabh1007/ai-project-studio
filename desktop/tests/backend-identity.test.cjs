'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DESKTOP_PROTOCOL_VERSION,
  BackendProtocolMismatchError,
  classifyBackendIdentity,
  parseBackendIdentity,
} = require('../backend-identity.cjs');

const expected = {
  launchId: 'launch-1',
  pid: 4242,
  protocolVersion: DESKTOP_PROTOCOL_VERSION,
};

function identity(overrides = {}) {
  return {
    launchId: 'launch-1',
    pid: 4242,
    version: '0.11.3',
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    ...overrides,
  };
}

test('adopts the backend it launched when identity, pid and protocol all match', () => {
  assert.deepEqual(classifyBackendIdentity(identity(), expected), { state: 'ready' });
});

test('treats a stranger on the port as foreign so startup keeps waiting', () => {
  for (const body of [
    null,
    'not-an-object',
    identity({ launchId: 'someone-else' }),
    identity({ launchId: undefined }),
    identity({ launchId: 7 }),
  ]) {
    const verdict = classifyBackendIdentity(body, expected);
    assert.equal(verdict.state, 'foreign', `expected foreign for ${JSON.stringify(body)}`);
    assert.match(verdict.reason, /\S/);
  }
});

test('rejects a different process answering for our own launch id', () => {
  const verdict = classifyBackendIdentity(identity({ pid: 999 }), expected);
  assert.equal(verdict.state, 'foreign');
  assert.match(verdict.reason, /pid 999/);
});

test('skips the pid check when the child pid is unknown', () => {
  const verdict = classifyBackendIdentity(identity({ pid: 999 }), {
    ...expected,
    pid: undefined,
  });
  assert.deepEqual(verdict, { state: 'ready' });
});

test('fails fast on a protocol mismatch instead of retrying until timeout', () => {
  const verdict = classifyBackendIdentity(
    identity({ protocolVersion: DESKTOP_PROTOCOL_VERSION + 1, version: '0.10.3' }),
    expected,
  );
  assert.equal(verdict.state, 'mismatch');
  assert.match(verdict.reason, /0\.10\.3/);
  assert.match(verdict.reason, /reinstall/i);
});

test('reports an unknown version when a mismatched backend omits it', () => {
  const verdict = classifyBackendIdentity(
    identity({ protocolVersion: 0, version: undefined }),
    expected,
  );
  assert.equal(verdict.state, 'mismatch');
  assert.match(verdict.reason, /unknown/);
});

test('parseBackendIdentity tolerates non-JSON payloads', () => {
  assert.deepEqual(parseBackendIdentity('{"launchId":"a"}'), { launchId: 'a' });
  assert.equal(parseBackendIdentity('<html>proxy error</html>'), null);
  assert.equal(parseBackendIdentity(''), null);
});

test('BackendProtocolMismatchError is a fatal, named error', () => {
  const error = new BackendProtocolMismatchError('half-upgraded');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'BackendProtocolMismatchError');
  assert.equal(error.fatal, true);
  assert.equal(error.message, 'half-upgraded');
});

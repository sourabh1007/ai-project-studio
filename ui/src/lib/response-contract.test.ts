import { describe, it, expect } from 'vitest';
import {
  validateMetaOperationPage,
  validateMetaPoolsStatus,
  validateObjectBody,
} from './response-contract.js';

describe('validateObjectBody', () => {
  it('accepts an object body', () => {
    expect(validateObjectBody('/x', {})).toBeNull();
  });

  it('names what arrived instead, for each way a body can be wrong', () => {
    // The HTML-from-a-proxy case a user actually hits mid-upgrade.
    expect(validateObjectBody('/x', '<!doctype html>')).toContain('string');
    expect(validateObjectBody('/x', null)).toContain('null');
    expect(validateObjectBody('/x', [])).toContain('an array');
    expect(validateObjectBody('/x', 7)).toContain('number');
    expect(validateObjectBody('/x', undefined)).toContain('undefined');
  });

  it('points at the backend rather than blaming the page', () => {
    expect(validateObjectBody('/meta/pools', 'nope')).toContain('/meta/pools');
    expect(validateObjectBody('/meta/pools', 'nope')).toContain('starting up');
  });
});

describe('validateMetaPoolsStatus', () => {
  const pool = { purpose: 'review', sessions: [] };

  it('accepts a well formed status, including unknown future fields', () => {
    expect(validateMetaPoolsStatus({ enabled: true, pools: [pool] })).toBeNull();
    expect(
      validateMetaPoolsStatus({ enabled: true, pools: [pool], somethingNew: 1 }),
    ).toBeNull();
  });

  it('accepts a pool that omits sessions entirely', () => {
    expect(validateMetaPoolsStatus({ pools: [{ purpose: 'review' }] })).toBeNull();
  });

  it('rejects a body that is not an object', () => {
    expect(validateMetaPoolsStatus('<html>')).toContain('/meta/pools');
  });

  it('rejects a missing or non-array pool list', () => {
    expect(validateMetaPoolsStatus({ enabled: true })).toContain('no pool list');
    expect(validateMetaPoolsStatus({ pools: {} })).toContain('no pool list');
  });

  it('reports which pool entry is malformed', () => {
    expect(validateMetaPoolsStatus({ pools: [pool, null] })).toContain('pool 1');
    expect(validateMetaPoolsStatus({ pools: [pool, {}] })).toContain('index 1');
  });

  it('rejects non-list sessions, the shape that used to blank the section', () => {
    const problem = validateMetaPoolsStatus({
      pools: [{ purpose: 'review', sessions: {} }],
    });
    expect(problem).toContain('"review"');
    expect(problem).toContain('instead of a list');
  });
});

describe('validateMetaOperationPage', () => {
  const item = { operationId: 'op-1' };

  it('accepts a well formed page with either cursor form', () => {
    expect(validateMetaOperationPage({ items: [item], nextCursor: null })).toBeNull();
    expect(validateMetaOperationPage({ items: [item], nextCursor: 'op-1' })).toBeNull();
    expect(validateMetaOperationPage({ items: [] })).toBeNull();
  });

  it('rejects a body that is not an object', () => {
    expect(validateMetaOperationPage([])).toContain('/meta/operations');
  });

  it('rejects a missing item list', () => {
    expect(validateMetaOperationPage({ nextCursor: null })).toContain('no operation list');
  });

  it('reports which entry has no operation id', () => {
    expect(validateMetaOperationPage({ items: [item, {}] })).toContain('index 1');
    expect(validateMetaOperationPage({ items: [null] })).toContain('index 0');
    expect(validateMetaOperationPage({ items: [{ operationId: 7 }] })).toContain('index 0');
  });

  it('rejects a cursor that cannot terminate paging', () => {
    // A non-string, non-null cursor is re-sent forever and never advances.
    expect(validateMetaOperationPage({ items: [], nextCursor: 12 })).toContain('cursor');
    expect(validateMetaOperationPage({ items: [], nextCursor: {} })).toContain('cursor');
  });
});

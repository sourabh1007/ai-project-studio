import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetFailures, compareLogFiles, parseOptions, percentile } from './performance.mjs';

test('percentiles sort a copy and use nearest-rank measurements', () => {
  const samples = [4, 1, 3, 2];
  assert.equal(percentile(samples, 0), 1);
  assert.equal(percentile(samples, 0.5), 2);
  assert.equal(percentile(samples, 0.95), 4);
  assert.equal(percentile(samples, 1), 4);
  assert.deepEqual(samples, [4, 1, 3, 2]);
  assert.throws(() => percentile([], 0.5));
  assert.throws(() => percentile(samples, -1));
  assert.throws(() => percentile(samples, 2));
});

test('the performance gate fails on regression or missing measurements', () => {
  assert.deepEqual(budgetFailures({ latency: 10 }, { latency: 10 }), []);
  assert.deepEqual(budgetFailures({ latency: 11 }, { latency: 10 }), ['latency: 11.00 exceeds 10']);
  for (const value of [undefined, NaN, Infinity]) {
    assert.deepEqual(budgetFailures({ latency: value }, { latency: 10 }), ['latency: no finite measurement']);
  }
  for (const value of [0, -1, NaN, Infinity]) {
    assert.throws(() => budgetFailures({}, { latency: value }));
  }
});

test('CLI validates options and makes baseline-only mode explicit', () => {
  assert.equal(parseOptions([]).baseline, false);
  assert.equal(parseOptions(['--baseline']).baseline, true);
  assert.match(parseOptions(['--output=fixture.json']).output, /fixture\.json$/);
  assert.throws(() => parseOptions(['--output=']));
  assert.throws(() => parseOptions(['--skip-checks']));
});

test('log-file measurements follow rotations before the active file and across UTC days', () => {
  const files = ['perf-2026-01-02.1.log', 'perf-2026-01-01.log', 'perf-2026-01-01.10.log',
    'perf-2026-01-02.log', 'perf-2026-01-01.2.log', 'perf-2026-01-01.1.log'];
  assert.deepEqual(files.sort(compareLogFiles), ['perf-2026-01-01.1.log', 'perf-2026-01-01.2.log',
    'perf-2026-01-01.10.log', 'perf-2026-01-01.log', 'perf-2026-01-02.1.log', 'perf-2026-01-02.log']);
  assert.equal(compareLogFiles(files[0], files[0]), 0);
  assert.throws(() => compareLogFiles('unexpected.log', files[0]));
});

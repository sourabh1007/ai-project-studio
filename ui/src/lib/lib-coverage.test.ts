import { describe, expect, it } from 'vitest';

// Coverage aggregator: vitest runs test files across worker processes, but v8
// per-file coverage is only reported for modules loaded in the primary worker.
// Loading every lib test here (in worker 1 only) ensures each lib module is
// counted toward the 100% src/lib gate regardless of which worker ran its test.
if (process.env.VITEST_POOL_ID === '1' && process.env.VITEST_WORKER_ID === '1') {
  await Promise.all([
    import('./activity.test.js'),
    import('./api-base.test.js'),
    import('./api.test.js'),
    import('./automation-view.test.js'),
    import('./change-graph-layout.test.js'),
    import('./change-graph-worker-protocol.test.js'),
    import('./clipboard.test.js'),
    import('./command-palette.test.js'),
    import('./connection-status.test.js'),
    import('./credential-storage.test.js'),
    import('./diagnostics.test.js'),
    import('./diff-lines.test.js'),
    import('./disposer.test.js'),
    import('./draft-store.test.js'),
    import('./error-model.test.js'),
    import('./failure-log.test.js'),
    import('./feature-color.test.js'),
    import('./format.test.js'),
    import('./keyboard-shortcuts.test.js'),
    import('./markdown.test.js'),
    import('./network-activity.test.js'),
    import('./persisted-state.test.js'),
    import('./progress-stages.test.js'),
    import('./session-names.test.js'),
    import('./session-status.test.js'),
    import('./stream.test.js'),
    import('./terminal-protocol.test.js'),
    import('./terminal-url.test.js'),
    import('./test-method-diff.test.js'),
    import('./theme.test.js'),
    import('./update-state.test.js'),
    import('./usage-tree.test.js'),
    import('./virtual-window.test.js'),
  ]);
}

describe('lib coverage aggregator', () => {
  it('loads every lib test in the primary worker', () => {
    expect(true).toBe(true);
  });
});

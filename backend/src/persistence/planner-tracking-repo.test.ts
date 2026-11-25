import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createPlannerTrackingContext, createPlannerTrackingStore } from './planner-tracking-repo.js';

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
describe('Planner tracking persistence and bounded source projection', () => {
  it('discovers only user work and correlated agents; projects source context, PRs and precise skill activity', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    databases.push(db);
    db.exec(`
      INSERT INTO features(id, name, description, created_at) VALUES
        ('f', 'Work', '', '2026-04-04'), ('internal', 'Internal', '', '2026-04-04'), ('agent', 'Agent', '', '2026-04-04');
      INSERT INTO sessions(id, feature_id, provider, requested_model, status, kind, scope, prompt, usage_file_path, created_at)
        VALUES ('s', 'f', 'copilot', 'auto', 'running', 'dev', 'feature', 'Work', '', '2026-04-04'),
        ('internal-s', 'internal', 'copilot', 'auto', 'completed', 'meta', 'internal', 'Internal', '', '2026-04-04');
      INSERT INTO meta_operations(operation_id, feature_id, correlation_json, state, result_text, created_at, updated_at)
        VALUES ('op', 'agent', '{"agentId":"review-board","perspectiveId":"business"}', 'completed', 'Reviewed business behavior.', '2026-04-04', '2026-04-04');
      INSERT INTO pr_reviews(feature_id, repo_id, pull_number, pull_title, pull_url, worktree_path, status, created_at, updated_at)
        VALUES('f', 'repo', 42, 'Lock fix', 'https://github.com/o/r/pull/42', '', 'ready', '2026-04-04', '2026-04-04');
      INSERT INTO skill_usage(event_id, feature_id, session_id, provider, repo_id, identity, name, source, kind, scope, recorded_at)
        VALUES('skill-event', 'f', 's', 'copilot', NULL, 'repository:review', 'Repo review skill', 'repository', 'context-injected', 'feature', '2026-04-04');
    `);
    const source = createPlannerTrackingContext(db);
    expect(source.page('', '2026-04-03')).toEqual(['agent', 'f']);
    expect(source.page('agent', '2026-04-03')).toEqual(['f']);
    expect(source.page('', '2026-04-05')).toEqual(['f']);
    expect(source.context('missing')).toBeNull();
    expect(source.exists('f', null)).toBe(true);
    expect(source.exists('f', 'other')).toBe(false);
    expect(source.context('f')).toMatchObject({
      sessions: [{ id: 's', provider: 'copilot' }],
      recorded: [
        { kind: 'pr', text: 'https://github.com/o/r/pull/42\nLock fix', completed: false },
        { kind: 'skill', label: 'Repo review skill (repository; context-injected)', completed: false },
      ],
    });
    expect(source.context('agent')?.recorded).toEqual([expect.objectContaining({
      kind: 'agent', label: 'review-board: ', text: 'Recorded state: completed; perspective: business\nReviewed business behavior.', completed: true,
    })]);
    const store = createPlannerTrackingStore(db, false);
    expect(store.enabled()).toBe(false);
    store.setEnabled(true);
    expect(createPlannerTrackingStore(db, false).enabled()).toBe(true);
    expect(store.get('missing')).toBeNull();
    expect(store.provenance('missing')).toBeNull();
    expect(store.candidates('repo', 'f')).toEqual({ tasks: [], work: [] });
    expect(source.context('internal')?.sessions).toEqual([]);
  });
});

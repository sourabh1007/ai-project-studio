import { describe, expect, it } from 'vitest';
import type { RepoInsights } from '../repo-insights/repo-insights-contract.js';
import { createDatabase } from './db/connection.js';
import { createRepoRepo } from './repo-repo.js';
import { createRepoInsightsRepo } from './repo-insights-repo.js';

function insights(overrides: Partial<RepoInsights> = {}): RepoInsights {
  return {
    repositoryId: 'r1',
    branch: 'main',
    agents: [
      { name: 'A', description: 'agent a', author: 'Ada', path: '.github/agents/a.md' },
    ],
    skills: [],
    docs: [{ name: 'Doc', description: 'a doc', author: 'Bob', path: 'docs/d.md' }],
    readiness: [
      { key: 'agents', label: 'Agents', requirement: 'AGENTS.md', status: 'pass', detail: null },
    ],
    agentReady: true,
    generatedAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
}

function addRepository(
  repo: ReturnType<typeof createRepoRepo>,
  id: string,
): void {
  repo.create({
    id,
    provider: 'github',
    remoteUrl: `https://github.com/acme/${id}.git`,
    name: `acme/${id}`,
    localPath: `C:\\work\\${id}`,
    defaultBranch: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('repo-insights-repo', () => {
  it('returns null for an unknown repository', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const store = createRepoInsightsRepo(db);
    expect(store.get('missing')).toBeNull();
    db.close();
  });

  it('saves and restores a snapshot verbatim', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    addRepository(createRepoRepo(db), 'r1');
    const store = createRepoInsightsRepo(db);
    const snapshot = insights();
    store.save(snapshot);
    expect(store.get('r1')).toEqual(snapshot);
    db.close();
  });

  it('replaces an existing snapshot on re-save', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    addRepository(createRepoRepo(db), 'r1');
    const store = createRepoInsightsRepo(db);
    store.save(insights());
    store.save(insights({ branch: 'develop', generatedAt: '2026-03-01T00:00:00.000Z' }));
    const restored = store.get('r1');
    expect(restored?.branch).toBe('develop');
    expect(restored?.generatedAt).toBe('2026-03-01T00:00:00.000Z');
    db.close();
  });

  it('forgets a snapshot on delete', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    addRepository(createRepoRepo(db), 'r1');
    const store = createRepoInsightsRepo(db);
    store.save(insights());
    store.delete('r1');
    expect(store.get('r1')).toBeNull();
    db.close();
  });

  it('drops the snapshot when its repository is deleted (cascade)', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repos = createRepoRepo(db);
    addRepository(repos, 'r1');
    const store = createRepoInsightsRepo(db);
    store.save(insights());
    repos.delete('r1');
    expect(store.get('r1')).toBeNull();
    db.close();
  });

  it('returns null when the stored snapshot is corrupt', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    addRepository(createRepoRepo(db), 'r1');
    createRepoInsightsRepo(db);
    db.prepare(
      'INSERT INTO repo_insights (repo_id, snapshot, generated_at) VALUES (?, ?, ?)',
    ).run('r1', 'not json', '2026-02-01T00:00:00.000Z');
    expect(createRepoInsightsRepo(db).get('r1')).toBeNull();
    db.close();
  });

  it('returns null when the stored snapshot is a JSON non-object', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    addRepository(createRepoRepo(db), 'r1');
    db.prepare(
      'INSERT INTO repo_insights (repo_id, snapshot, generated_at) VALUES (?, ?, ?)',
    ).run('r1', '42', '2026-02-01T00:00:00.000Z');
    expect(createRepoInsightsRepo(db).get('r1')).toBeNull();
    db.close();
  });
});

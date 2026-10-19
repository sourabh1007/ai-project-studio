import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createSkillUsageRepo } from './skill-usage-repo.js';
import type { SkillUsageRecord } from '../skill-usage/skill-usage-contract.js';

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = createDatabase({ databasePath: ':memory:' });
  databases.push(db);
  return { db, repo: createSkillUsageRepo(db) };
}
const event = (extra: Partial<SkillUsageRecord> = {}): SkillUsageRecord => ({
  eventId: 'e1', featureId: 'f1', sessionId: 's1', provider: 'agency', repoId: 'r1',
  identity: '.github/skills/review/SKILL.md', name: 'review', source: 'repository', kind: 'invocation', scope: 'feature',
  inputTokens: null, outputTokens: null, nanoAiu: null, recordedAt: '2026-10-17T10:00:00.000Z', ...extra,
});

describe('skill usage persistence', () => {
  it('returns an honest empty snapshot', () => {
    const { repo } = fixture();
    expect(repo.read({ scope: 'feature' }, 100)).toEqual({ rows: [], limited: false, maxEvents: 100 });
  });
  it('deduplicates historical replays, accepts late metrics once and never rewrites ownership', () => {
    const { repo } = fixture();
    repo.record(event());
    repo.record(event({ featureId: 'changed', source: 'cli', inputTokens: 0, outputTokens: 20, nanoAiu: 1e9 }));
    repo.record(event({ inputTokens: 123, outputTokens: 123, nanoAiu: 9e9 }));
    expect(repo.read({ scope: 'feature', featureId: 'f1' }, 100).rows).toEqual([{
      identity: '.github/skills/review/SKILL.md', name: 'review', source: 'repository', kind: 'invocation',
      provider: 'agency', repoId: 'r1', repoName: null, uses: 1, sessions: 1,
      inputTokens: 0, outputTokens: 20, nanoAiu: 1e9, reportedInput: 1, reportedOutput: 1, reportedAic: 1,
      lastUsedAt: '2026-10-17T10:00:00.000Z',
    }]);
    expect(repo.read({ scope: 'feature', featureId: 'changed' }, 100).rows).toEqual([]);
  });
  it('keeps sources, repositories, providers, internal scopes, and context activities separate', () => {
    const { repo } = fixture();
    repo.record(event());
    repo.record(event({ eventId: 'ide', source: 'ide', kind: 'context-prepared' }));
    repo.record(event({ eventId: 'cli', source: 'cli' }));
    repo.record(event({ eventId: 'other-repo', repoId: 'r2' }));
    repo.record(event({ provider: 'copilot' }));
    repo.record(event({ eventId: 'internal', scope: 'internal' }));
    expect(repo.read({ scope: 'feature' }, 100).rows).toHaveLength(5);
    expect(repo.read({ scope: 'internal' }, 100).rows).toHaveLength(1);
  });
  it('shows repository names while retaining the original identity after the repository is deleted', () => {
    const { repo, db } = fixture();
    db.prepare(`INSERT INTO repositories (id, provider, remote_url, name, local_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('r1', 'github', 'https://example.invalid/project', 'Project', 'C:\\project', '');
    repo.record(event());
    expect(repo.read({ scope: 'feature' }, 100).rows[0]).toMatchObject({ repoId: 'r1', repoName: 'Project' });
    db.prepare('DELETE FROM repositories WHERE id = ?').run('r1');
    expect(repo.read({ scope: 'feature' }, 100).rows[0]).toMatchObject({ repoId: 'r1', repoName: null, uses: 1 });
  });
  it('counts real uses and sessions, marks metric coverage and does not convert unknown usage to zero', () => {
    const { repo } = fixture();
    repo.record(event());
    repo.record(event({ eventId: 'e2', sessionId: 's2', inputTokens: 100, nanoAiu: 0 }));
    const row = repo.read({ scope: 'feature' }, 100).rows[0];
    expect(row).toMatchObject({ uses: 2, sessions: 2, inputTokens: 100, reportedInput: 1, outputTokens: null,
      reportedOutput: 0, nanoAiu: 0, reportedAic: 1 });
  });
  it('limits the snapshot to the newest indexed events without deleting older history', () => {
    const { repo, db } = fixture();
    repo.record(event({ eventId: 'old', recordedAt: '2026-10-16T10:00:00.000Z', inputTokens: 500 }));
    repo.record(event({ eventId: 'new', inputTokens: 10 }));
    expect(repo.read({ scope: 'feature' }, 1)).toMatchObject({ limited: true, maxEvents: 1, rows: [{ uses: 1, inputTokens: 10 }] });
    expect(repo.read({ scope: 'feature', featureId: 'f1' }, 2)).toMatchObject({ limited: false, rows: [{ uses: 2, inputTokens: 510 }] });
    expect(db.prepare('SELECT COUNT(*) AS n FROM skill_usage').get()?.n).toBe(2);
  });
});

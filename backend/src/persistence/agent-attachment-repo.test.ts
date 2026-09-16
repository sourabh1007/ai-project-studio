import { describe, it, expect } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createAgentAttachmentRepo } from './agent-attachment-repo.js';
import type { AgentAttachment } from '../agents/agent-contract.js';

function attachment(overrides: Partial<AgentAttachment> = {}): AgentAttachment {
  return {
    id: 'a1',
    agentId: 'review-board',
    featureId: 'f1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function repo() {
  const db = createDatabase({ databasePath: ':memory:' });
  return { db, repo: createAgentAttachmentRepo(db) };
}

describe('agent-attachment-repo', () => {
  it('creates and reads back an attachment', () => {
    const { db, repo: r } = repo();
    r.create(attachment());
    expect(r.get('a1')).toEqual(attachment());
    expect(r.get('missing')).toBeNull();
    db.close();
  });

  it('lists a feature\'s attachments in creation order', () => {
    const { db, repo: r } = repo();
    r.create(attachment({ id: 'a2', createdAt: '2026-01-02T00:00:00.000Z' }));
    r.create(attachment({ id: 'a1', createdAt: '2026-01-01T00:00:00.000Z' }));
    r.create(attachment({ id: 'b1', featureId: 'f2' }));
    expect(r.listByFeature('f1').map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(r.listAll()).toHaveLength(3);
    db.close();
  });

  it('counts attachments by agent and feature', () => {
    const { db, repo: r } = repo();
    r.create(attachment({ id: 'a1' }));
    r.create(attachment({ id: 'a2', agentId: 'other' }));
    expect(r.countByAgentAndFeature('review-board', 'f1')).toBe(1);
    expect(r.countByAgentAndFeature('review-board', 'f2')).toBe(0);
    db.close();
  });

  it('deletes by id and by feature', () => {
    const { db, repo: r } = repo();
    r.create(attachment({ id: 'a1' }));
    r.create(attachment({ id: 'a2' }));
    r.create(attachment({ id: 'b1', featureId: 'f2' }));
    r.delete('a1');
    expect(r.get('a1')).toBeNull();
    r.deleteByFeature('f1');
    expect(r.listByFeature('f1')).toEqual([]);
    expect(r.listByFeature('f2')).toHaveLength(1);
    db.close();
  });

  it('records one-shot backfill markers idempotently', () => {
    const { db, repo: r } = repo();
    expect(r.isBackfilled('auto:review-board')).toBe(false);
    r.markBackfilled('auto:review-board');
    r.markBackfilled('auto:review-board');
    expect(r.isBackfilled('auto:review-board')).toBe(true);
    db.close();
  });
});

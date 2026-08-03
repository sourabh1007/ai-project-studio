import { describe, expect, it } from 'vitest';
import type { ContextDocument } from '../context-store/context-contract.js';
import { createContextRepo } from './context-repo.js';
import { createDatabase } from './db/connection.js';

function doc(overrides: Partial<ContextDocument> = {}): ContextDocument {
  return {
    scope: 'feature',
    scopeId: 'f1',
    content: '- Prefer small pure functions.',
    updatedAt: '2026-09-01T00:00:00.000Z',
    updatedBy: 'merge',
    ...overrides,
  };
}

describe('context-repo', () => {
  it('returns null for an absent document', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const contexts = createContextRepo(db);
    expect(contexts.get('feature', 'missing')).toBeNull();
    db.close();
  });

  it('saves, loads and overwrites per scope', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const contexts = createContextRepo(db);
    contexts.save(doc());
    contexts.save(doc({ scope: 'workspace', scopeId: '', updatedBy: 'manual' }));
    contexts.save(doc({ scope: 'repo', scopeId: 'r1', updatedBy: 'import' }));

    expect(contexts.get('feature', 'f1')).toEqual(doc());
    expect(contexts.get('workspace', '')).toEqual(
      doc({ scope: 'workspace', scopeId: '', updatedBy: 'manual' }),
    );
    expect(contexts.get('repo', 'r1')).toEqual(
      doc({ scope: 'repo', scopeId: 'r1', updatedBy: 'import' }),
    );

    contexts.save(
      doc({ content: '- Updated guidance.', updatedAt: '2026-09-02T00:00:00.000Z' }),
    );
    expect(contexts.get('feature', 'f1')).toEqual(
      doc({ content: '- Updated guidance.', updatedAt: '2026-09-02T00:00:00.000Z' }),
    );
    db.close();
  });

  it('deletes a document and is a no-op when absent', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const contexts = createContextRepo(db);
    contexts.save(doc());
    contexts.delete('feature', 'f1');
    expect(contexts.get('feature', 'f1')).toBeNull();
    contexts.delete('feature', 'f1');
    db.close();
  });
});

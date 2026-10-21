import { expect, it } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createMobileChatRepo } from './mobile-chat-repo.js';
import type { MobileChatRecord } from '../mobile/mobile-contract.js';

it('persists full conversation/consent state and reads bounded lightweight summaries', () => {
  const db = createDatabase({ databasePath: ':memory:' });
  try {
    const repo = createMobileChatRepo(db);
    expect(repo.get('absent')).toBeNull();
    expect(repo.list()).toEqual([]);
    const chat: MobileChatRecord = {
      id: 'chat', version: 1, repoId: 'repo', featureId: 'feature', attachmentId: 'attachment',
      title: 'Task', status: 'review-changes', messages: [{ id: 'message', role: 'user', text: 'Keep this', at: '' }],
      proposal: 'Proposal', files: [{ path: 'file.ts', changeType: 'modified' }], approval: null,
      consumedApprovalId: 'consumed', terminalSessionId: 'terminal', error: null, createdAt: '2026-01-01', updatedAt: '2026-01-01',
    };
    repo.save(chat);
    expect(repo.get(chat.id)).toEqual(chat);
    expect(repo.list()).toEqual([{ ...chat, messages: [], proposal: null, files: [], approval: null }]);
    repo.save({ ...chat, version: 2, status: 'publishing', updatedAt: '2026-01-02' });
    const reopened = createMobileChatRepo(db);
    expect(reopened.get(chat.id)).toMatchObject({ version: 2, status: 'publishing', consumedApprovalId: 'consumed' });
  } finally { db.close(); }
});

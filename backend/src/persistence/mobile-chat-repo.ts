import type { DatabaseSync } from 'node:sqlite';
import type { MobileChatRecord, MobileChatRepo } from '../mobile/mobile-contract.js';

export function createMobileChatRepo(db: DatabaseSync): MobileChatRepo {
  const get = db.prepare('SELECT body FROM mobile_chats WHERE id = ?');
  const list = db.prepare('SELECT summary AS body FROM mobile_chats ORDER BY updated_at DESC LIMIT 1000');
  const save = db.prepare(`INSERT INTO mobile_chats (id, body, summary, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET body = excluded.body, summary = excluded.summary, updated_at = excluded.updated_at`);
  const read = (row: unknown): MobileChatRecord =>
    JSON.parse((row as { body: string }).body) as MobileChatRecord;
  return {
    get(id) {
      const row = get.get(id);
      return row ? read(row) : null;
    },
    list: () => list.all().map(read),
    save: (chat) => {
      const summary = { ...chat, messages: [], proposal: null, files: [], approval: null };
      save.run(chat.id, JSON.stringify(chat), JSON.stringify(summary), chat.updatedAt);
    },
  };
}

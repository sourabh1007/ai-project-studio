import type { DatabaseSync } from 'node:sqlite';
import type { AgentAttachment } from '../agents/agent-contract.js';
import type { AgentAttachmentRepo } from '../agents/agent-attachment-repo-port.js';

interface AttachmentRow {
  id: string;
  agent_id: string;
  feature_id: string;
  created_at: string;
}

function mapAttachment(row: AttachmentRow): AgentAttachment {
  return {
    id: row.id,
    agentId: row.agent_id,
    featureId: row.feature_id,
    createdAt: row.created_at,
  };
}

/** SQLite-backed implementation of {@link AgentAttachmentRepo}. */
export function createAgentAttachmentRepo(db: DatabaseSync): AgentAttachmentRepo {
  const insert = db.prepare(
    'INSERT INTO agent_attachments (id, agent_id, feature_id, created_at) VALUES (?, ?, ?, ?)',
  );
  const selectById = db.prepare('SELECT * FROM agent_attachments WHERE id = ?');
  const selectByFeature = db.prepare(
    'SELECT * FROM agent_attachments WHERE feature_id = ? ORDER BY created_at, id',
  );
  const selectAll = db.prepare(
    'SELECT * FROM agent_attachments ORDER BY created_at, id',
  );
  const countByAgentFeature = db.prepare(
    'SELECT COUNT(*) AS n FROM agent_attachments WHERE agent_id = ? AND feature_id = ?',
  );
  const deleteById = db.prepare('DELETE FROM agent_attachments WHERE id = ?');
  const deleteByFeatureStmt = db.prepare(
    'DELETE FROM agent_attachments WHERE feature_id = ?',
  );
  const selectBackfill = db.prepare(
    'SELECT key FROM agent_backfill_state WHERE key = ?',
  );
  const insertBackfill = db.prepare(
    'INSERT OR IGNORE INTO agent_backfill_state (key, completed_at) VALUES (?, ?)',
  );

  return {
    create(attachment) {
      insert.run(
        attachment.id,
        attachment.agentId,
        attachment.featureId,
        attachment.createdAt,
      );
    },
    get(id) {
      const row = selectById.get(id) as AttachmentRow | undefined;
      return row ? mapAttachment(row) : null;
    },
    listByFeature(featureId) {
      return (selectByFeature.all(featureId) as unknown as AttachmentRow[]).map(mapAttachment);
    },
    listAll() {
      return (selectAll.all() as unknown as AttachmentRow[]).map(mapAttachment);
    },
    countByAgentAndFeature(agentId, featureId) {
      const row = countByAgentFeature.get(agentId, featureId) as { n: number };
      return row.n;
    },
    delete(id) {
      deleteById.run(id);
    },
    deleteByFeature(featureId) {
      deleteByFeatureStmt.run(featureId);
    },
    isBackfilled(key) {
      return selectBackfill.get(key) !== undefined;
    },
    markBackfilled(key) {
      insertBackfill.run(key, new Date().toISOString());
    },
  };
}

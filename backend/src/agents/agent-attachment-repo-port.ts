import type { AgentAttachment } from './agent-contract.js';

/**
 * Persistence port for agent↔feature attachments. Mirrors the skill-attachment
 * pattern: attachments are the source of truth for which agents render on a
 * feature. Includes a one-shot backfill marker so auto-attach can be applied
 * once to pre-existing eligible features without ever undoing a later detach.
 */
export interface AgentAttachmentRepo {
  create(attachment: AgentAttachment): void;
  get(id: string): AgentAttachment | null;
  /** Attachments on a feature, in creation order. */
  listByFeature(featureId: string): AgentAttachment[];
  /** All attachments, for catalog reach counts. */
  listAll(): AgentAttachment[];
  /** How many times an agent is attached to a feature (multiplicity guard). */
  countByAgentAndFeature(agentId: string, featureId: string): number;
  delete(id: string): void;
  /** Removes every attachment on a feature (feature deletion cleanup). */
  deleteByFeature(featureId: string): void;

  /** True once the named one-shot backfill has run. */
  isBackfilled(key: string): boolean;
  /** Records that the named one-shot backfill has run. */
  markBackfilled(key: string): void;
}

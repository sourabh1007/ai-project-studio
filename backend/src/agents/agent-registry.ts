import type { AgentDefinition } from './agent-contract.js';

/**
 * The in-memory registry of every agent contributed at composition time. It is
 * the single place the host learns what agents exist, replacing the per-agent
 * hand-wiring the Review Board needed. Ids must be unique so routes, config and
 * attachments never collide.
 */
export interface AgentRegistry {
  /** Every registered agent definition, in registration order. */
  list(): AgentDefinition[];
  /** One agent by id, or null when unknown. */
  get(id: string): AgentDefinition | null;
}

/** Builds a registry, rejecting duplicate agent ids up front. */
export function createAgentRegistry(
  definitions: readonly AgentDefinition[],
): AgentRegistry {
  const byId = new Map<string, AgentDefinition>();
  for (const definition of definitions) {
    const { id } = definition.manifest;
    if (byId.has(id)) {
      throw new Error(`Duplicate agent id: ${id}`);
    }
    byId.set(id, definition);
  }
  const ordered = [...definitions];
  return {
    list: () => [...ordered],
    get: (id) => byId.get(id) ?? null,
  };
}

import type { ModelInfo } from '../provider-contract.js';
import type { CopilotConfig } from './config.js';

/**
 * Exposes the provider's selectable models. Sourced from configuration so the
 * list is user-editable (IDE-grade configurability) rather than hardcoded.
 */
export function listCopilotModels(config: CopilotConfig): ModelInfo[] {
  return config.models.map((m) => ({ id: m.id, label: m.label }));
}

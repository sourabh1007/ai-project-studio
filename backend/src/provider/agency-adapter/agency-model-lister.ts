import type { ModelInfo } from '../provider-contract.js';
import type { AgencyConfig } from './config.js';

/**
 * Exposes the Agency provider's selectable models. Sourced from configuration
 * so the list is user-editable rather than hardcoded.
 */
export function listAgencyModels(config: AgencyConfig): ModelInfo[] {
  return config.models.map((m) => ({ id: m.id, label: m.label }));
}

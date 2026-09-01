import { ValidationError } from '../kernel/error-types.js';
import type { Route } from './http-contract.js';

/** The runtime meta AI settings surfaced to the IDE status bar. */
export interface MetaSettingsView {
  /** Provider id new metasessions launch with. */
  providerId: string;
  /** Requested model; `auto` lets the provider pick its default. */
  model: string;
  /**
   * True when warm ACP pools are enabled. Warm sessions are pinned to the CLI
   * default model, so choosing a specific model routes new metasessions to the
   * (slightly slower) cold path so the model is honored.
   */
  warmPoolEnabled: boolean;
}

export interface MetaSettingsControllerDeps {
  /** Current provider/model + warm-pool flag. */
  get: () => MetaSettingsView;
  /** Applies a provider/model patch and returns the resulting settings. */
  update: (patch: { providerId?: string; model?: string }) => MetaSettingsView;
}

function assertSettingsPatch(body: unknown): {
  providerId?: string;
  model?: string;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('body must be an object');
  }
  const record = body as Record<string, unknown>;
  const patch: { providerId?: string; model?: string } = {};
  if (record.providerId !== undefined) {
    if (
      typeof record.providerId !== 'string' ||
      record.providerId.trim().length === 0
    ) {
      throw new ValidationError('providerId must be a non-empty string');
    }
    patch.providerId = record.providerId;
  }
  if (record.model !== undefined) {
    if (typeof record.model !== 'string' || record.model.trim().length === 0) {
      throw new ValidationError('model must be a non-empty string');
    }
    patch.model = record.model;
  }
  if (patch.providerId === undefined && patch.model === undefined) {
    throw new ValidationError('provide providerId and/or model to update');
  }
  return patch;
}

/**
 * Routes exposing the runtime meta AI provider/model so the status bar can show
 * which model the IDE uses for its metasessions and let the user change it live.
 * `PUT` applies the change to all *new* metasessions immediately (no restart).
 */
export function createMetaSettingsRoutes(
  deps: MetaSettingsControllerDeps,
): Route[] {
  return [
    {
      method: 'get',
      path: '/meta/settings',
      handler: () => ({ status: 200, body: deps.get() }),
    },
    {
      method: 'put',
      path: '/meta/settings',
      handler: (req) => ({
        status: 200,
        body: deps.update(assertSettingsPatch(req.body)),
      }),
    },
  ];
}

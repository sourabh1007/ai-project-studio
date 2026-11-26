import type { AgencyConfig } from '../provider/agency-adapter/config.js';
import type { CopilotConfig } from '../provider/copilot-adapter/config.js';
import type { MetaConfig } from './config.js';
import type { MetaRequest } from './meta-runner.js';
import type { MetaSettings } from './meta-settings.js';
import type { MetaPoolsStatus } from './pooled-meta-runner.js';

export function metaFanOutCapacity(transport: 'acp' | undefined, liveWarmSessions: number, configuredSize: number): number {
  return transport === 'acp' ? liveWarmSessions : configuredSize;
}

export function warmPoolAvailability(input: {
  enabled: boolean;
  providerId: string;
  installed: boolean;
  selectionRequired: boolean;
  transport: 'acp' | undefined;
  warmProviderId: string | null;
  running: boolean;
  starting: boolean;
  failed: boolean;
}): NonNullable<MetaPoolsStatus['availability']> {
  const result = (state: NonNullable<MetaPoolsStatus['availability']>['state'], message: string) =>
    ({ state, providerId: input.providerId, message });
  if (input.selectionRequired) return result('unavailable', 'Select a CLI to check warm-session availability.');
  if (!input.installed) return result('unavailable', 'The selected CLI is not installed.');
  if (input.transport !== 'acp') return result('unavailable', 'This provider runs AI requests on demand; reusable warm sessions are not supported.');
  if (input.warmProviderId !== input.providerId) return result('unavailable', 'The warm executable does not match the selected CLI.');
  if (!input.enabled) return result('disabled', 'Warm sessions are turned off.');
  if (input.running) return result('running', 'The warm pool is running.');
  if (input.failed) return result('failed', 'Warm startup failed. Check CLI readiness and MCP settings before restarting.');
  if (input.starting) return result('starting', 'Starting the warm pool.');
  return result('unavailable', 'No warm pool is running. Restart after checking CLI readiness.');
}

export interface WarmRoutePolicyDeps {
  settings: Pick<MetaSettings, 'get'>;
  warmProviderId: string | null;
}

export interface ConfiguredWarmRoutePolicyDeps {
  settings: Pick<MetaSettings, 'get'>;
  metaConfig: Pick<MetaConfig, 'warmPool'>;
  copilotConfig: Pick<CopilotConfig, 'executable'>;
  agencyConfig: Pick<AgencyConfig, 'executable'>;
}

export interface WarmProviderIdentityDeps {
  warmExecutable: string;
  copilotExecutable: string;
  agencyExecutable: string;
}

/**
 * ACP warm sessions currently use the executable's built-in defaults: they can
 * only honor requests that stay on that provider's default model, use no
 * attachments, and remain in the internal scope. A tool-less request is also
 * served warm when the caller marked tools optional, since warm sessions cannot
 * turn tools off but a prompt that needs none simply never calls them.
 */
export function resolveWarmProviderIdentity(
  deps: WarmProviderIdentityDeps,
): string | null {
  const matchesCopilot = deps.warmExecutable === deps.copilotExecutable;
  const matchesAgency = deps.warmExecutable === deps.agencyExecutable;
  return matchesCopilot && !matchesAgency ? 'copilot' : null;
}

export function createConfiguredWarmRoutePolicy(
  deps: ConfiguredWarmRoutePolicyDeps,
): (request: MetaRequest) => boolean {
  const warmExecutable =
    deps.metaConfig.warmPool.executable === 'copilot'
      ? deps.copilotConfig.executable
      : deps.metaConfig.warmPool.executable;
  return createWarmRoutePolicy({
    settings: deps.settings,
    warmProviderId: resolveWarmProviderIdentity({
      warmExecutable,
      copilotExecutable: deps.copilotConfig.executable,
      agencyExecutable: deps.agencyConfig.executable,
    }),
  });
}

export function createWarmRoutePolicy(
  deps: WarmRoutePolicyDeps,
): (request: MetaRequest) => boolean {
  return (request) => {
    if ((request.scope ?? 'internal') !== 'internal') {
      return false;
    }
    if ((request.noTools && !request.toolsOptional) ||
        (request.attachments?.length ?? 0) > 0) {
      return false;
    }
    if (deps.warmProviderId === null) {
      return false;
    }
    const live = deps.settings.get();
    if (live.providerId !== deps.warmProviderId ||
        (request.providerId !== undefined && request.providerId !== deps.warmProviderId)) {
      return false;
    }
    const model = request.model ?? live.model;
    return model === 'auto';
  };
}

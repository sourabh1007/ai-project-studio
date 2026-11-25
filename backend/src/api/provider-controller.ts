import type { ProviderRegistry } from '../provider/provider-registry.js';
import type { ProviderExecutionPolicy, ProviderSelectionSnapshot } from '../provider/active-provider.js';
import { ConflictError, NotFoundError, ValidationError } from '../kernel/error-types.js';
import { z } from 'zod';
import type { Route } from './http-contract.js';
import type { AutomationReadiness, ProviderFeature } from '../provider-features/provider-features.js';

export interface ProviderControllerDeps {
  executionPolicy?: ProviderExecutionPolicy;
  drainProviderWork?: () => Promise<void>;
  updateInternalAgencyOptIn?: (enabled: boolean) => void;
  /** Injected availability policy, separate from identity and authorization. */
  isProviderEligible?: (id: string) => boolean;
  registry: ProviderRegistry;
  /** Reports the default provider and each provider's install state. */
  bootstrapInfo: () => ProviderBootstrapInfo;
  /**
   * Legacy identity display only. It does not authorize provider access.
   */
  microsoftSignedIn: () => boolean;
}

/** Install state + default selection, so the first-run UI knows what to set up. */
export interface ProviderBootstrapInfo {
  /** Active provider, or a display-only fallback while setup is required. */
  defaultProvider: string;
  /** Each registered provider with whether its CLI is installed. */
  providers: Array<{
    id: string;
    installed: boolean;
    label?: string;
    installCommand?: string;
    installAvailable?: boolean;
    configNamespace?: string;
    /** Interactive availability does not imply safe automated/headless execution. */
    automation?: AutomationReadiness;
    features?: ProviderFeature[];
  }>;
  /** Legacy identity display only; never an eligibility decision. */
  microsoftSignedIn?: boolean;
  selectionRequired?: boolean;
  blockers?: Array<{ kind: string; id: string; label: string }>;
  revision?: number;
  remember?: boolean;
  internalAgencyEnabled?: boolean;
}

/** Routes exposing available providers and each provider's model catalog. */
export function createProviderRoutes(deps: ProviderControllerDeps): Route[] {
  const exposed = (id: string): boolean =>
    deps.executionPolicy?.isEligible(id) ??
    deps.isProviderEligible?.(id) ?? id !== 'agency';
  const bootstrap = () => {
    const info = deps.bootstrapInfo();
    const providers = info.providers.filter((p) => exposed(p.id));
    const selection = deps.executionPolicy?.get();
    const defaultProvider = selection?.providerId ??
      (providers.some((p) => p.id === info.defaultProvider)
        ? info.defaultProvider : providers[0]?.id ?? info.defaultProvider);
    return {
      ...info, defaultProvider, providers, microsoftSignedIn: deps.microsoftSignedIn(),
      ...(selection ? {
        selectionRequired: selection.selectionRequired,
        blockers: selection.blockers, revision: selection.revision,
        remember: selection.remember,
      } : {}),
    };
  };
  return [
    {
      method: 'get',
      path: '/providers',
      handler: () => {
        const installState = new Map(
          deps.bootstrapInfo().providers.map((p) => [p.id, p]),
        );
        return {
          status: 200,
          body: deps.registry
            .list()
            .filter((provider) => exposed(provider.id))
            .map((provider) => ({
              id: provider.id,
              installed: installState.get(provider.id)?.installed ?? false,
              ...(installState.get(provider.id)?.automation
                ? { automation: installState.get(provider.id)!.automation } : {}),
              ...(installState.get(provider.id)?.features
                ? { features: installState.get(provider.id)!.features } : {}),
            })),
        };
      },
    },
    {
      method: 'get',
      path: '/providers/bootstrap',
      handler: () => ({ status: 200, body: bootstrap() }),
    },
    {
      method: 'post',
      path: '/providers/selection',
      handler: (req) => {
        const parsed = z.object({ providerId: z.string().trim().min(1), remember: z.boolean().optional() }).strict().safeParse(req.body);
        if (!parsed.success) throw new ValidationError('A providerId is required');
        if (!deps.executionPolicy) throw new ValidationError('Provider selection is not configured');
        if (!exposed(parsed.data.providerId)) throw new NotFoundError('Provider is not available');
        try {
          deps.executionPolicy.select(parsed.data.providerId, parsed.data.remember);
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error;
          const details = error.details as Partial<ProviderSelectionSnapshot> | undefined;
          return {
            status: 409,
            body: { error: {
              kind: error.kind,
              message: error.message,
              blockers: (details?.blockers ?? []).map(({ kind, id, label }) => ({ kind, id, label })),
            } },
          };
        }
        return { status: 200, body: bootstrap() };
      },
    },
    {
      method: 'post',
      path: '/providers/switch',
      handler: async (req) => {
        const parsed = z.object({
          providerId: z.string().trim().min(1), remember: z.boolean(),
          expectedRevision: z.number().int().nonnegative(),
        }).strict().safeParse(req.body);
        if (!parsed.success) throw new ValidationError('A providerId, remember choice and expectedRevision are required');
        if (!deps.executionPolicy || !deps.drainProviderWork) throw new ValidationError('Provider switching is not configured');
        if (!exposed(parsed.data.providerId)) throw new NotFoundError('Provider is not available');
        if (!deps.bootstrapInfo().providers.some((p) => p.id === parsed.data.providerId && p.installed)) {
          throw new ValidationError('Install the selected CLI before switching');
        }
        try {
          await deps.executionPolicy.switchTo(
            parsed.data.providerId, parsed.data.remember, parsed.data.expectedRevision, deps.drainProviderWork,
          );
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error;
          const details = error.details as Partial<ProviderSelectionSnapshot> | undefined;
          return { status: 409, body: { error: {
            kind: error.kind, message: error.message,
            blockers: (details?.blockers ?? []).map(({ kind, id, label }) => ({ kind, id, label })),
          } } };
        }
        return { status: 200, body: bootstrap() };
      },
    },
    {
      method: 'put',
      path: '/providers/preferences',
      handler: (req) => {
        const parsed = z.object({ allowInternalAgency: z.boolean() }).strict().safeParse(req.body);
        if (!parsed.success) throw new ValidationError('An explicit allowInternalAgency choice is required');
        if (!deps.updateInternalAgencyOptIn) throw new ValidationError('Internal CLI preferences are not configured');
        if (!parsed.data.allowInternalAgency && deps.executionPolicy?.get().providerId === 'agency') {
          throw new ConflictError('Choose another CLI before disabling Agency');
        }
        deps.updateInternalAgencyOptIn(parsed.data.allowInternalAgency);
        return { status: 200, body: bootstrap() };
      },
    },
    {
      method: 'get',
      path: '/providers/:id/models',
      handler: async (req) => {
        if (!exposed(req.params.id)) throw new NotFoundError('Provider is not available');
        return { status: 200, body: await deps.registry.get(req.params.id).listModels() };
      },
    },
  ];
}

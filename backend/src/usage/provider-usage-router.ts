import type { UsageCaptureRead } from './usage-capture-contract.js';

export interface ProviderUsageContext {
  featureId: string;
  provider: string;
  requestedModel: string;
}

export interface ProviderUsageSource {
  readonly sourceId: string;
  readUsagePage(sessionId: string, context: ProviderUsageContext, cursor: string | null, limit: number): UsageCaptureRead;
}

export interface ProviderUsageRouterDeps {
  sessions: { get(id: string): { provider: string } | null };
  sources: ReadonlyMap<string, ProviderUsageSource>;
}

/** Admission constrains new execution, not capture of previously attributed work. */
export function createProviderUsageRouter(deps: ProviderUsageRouterDeps) {
  return {
    sourceId(provider: string): string {
      return deps.sources.get(provider)?.sourceId ?? `unavailable:${provider}`;
    },
    readUsagePage(sessionId: string, context: ProviderUsageContext, cursor: string | null, limit: number): UsageCaptureRead {
      const session = deps.sessions.get(sessionId);
      const source = deps.sources.get(context.provider);
      if (session && session.provider !== context.provider) {
        return { status: 'unsupported', sourceId: source?.sourceId ?? `unavailable:${context.provider}`, reason: 'source-attribution-mismatch' };
      }
      if (!source) return { status: 'unsupported', sourceId: `unavailable:${context.provider}`, reason: 'provider-usage-unavailable' };
      return source.readUsagePage(sessionId, context, cursor, limit);
    },
  };
}

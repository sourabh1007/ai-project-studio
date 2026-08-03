import type { Clock } from '../kernel/clock.js';
import type { ContextConfig } from './config.js';
import { composeSharedContext } from './context-compose.js';
import type {
  ContextDocument,
  ContextScope,
  ContextUpdatedBy,
} from './context-contract.js';
import type { ContextStore } from './context-store-port.js';

export interface ContextServiceDeps {
  store: ContextStore;
  clock: Clock;
  config: ContextConfig;
  /** Notified after any write so live-push can propagate to running sessions. */
  onUpdated: (doc: ContextDocument) => void;
}

export interface SetContentInput {
  scope: ContextScope;
  scopeId: string;
  content: string;
  updatedBy: ContextUpdatedBy;
}

export interface RememberInput {
  scope: ContextScope;
  scopeId: string;
  text: string;
}

export interface ComposeInput {
  repoId?: string | null;
  featureId?: string | null;
}

export interface ContextService {
  get(scope: ContextScope, scopeId: string): ContextDocument | null;
  setContent(input: SetContentInput): ContextDocument;
  remember(input: RememberInput): ContextDocument;
  composeLayered(input: ComposeInput): string;
  remove(scope: ContextScope, scopeId: string): void;
}

function clampDoc(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars).trimEnd()}…`;
}

function asBullet(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith('-') ? trimmed : `- ${trimmed}`;
}

/**
 * Central façade over the layered context store. Owns clamping, the
 * append-a-fact ("remember") flow, layered composition for launch, and firing
 * the update notification that drives live-push.
 */
export function createContextService(deps: ContextServiceDeps): ContextService {
  const write = (input: SetContentInput): ContextDocument => {
    const doc: ContextDocument = {
      scope: input.scope,
      scopeId: input.scopeId,
      content: clampDoc(input.content, deps.config.maxDocChars),
      updatedAt: deps.clock.isoNow(),
      updatedBy: input.updatedBy,
    };
    deps.store.save(doc);
    deps.onUpdated(doc);
    return doc;
  };

  return {
    get(scope, scopeId) {
      return deps.store.get(scope, scopeId);
    },
    setContent(input) {
      return write(input);
    },
    remember(input) {
      const existing = deps.store.get(input.scope, input.scopeId)?.content ?? '';
      const bullet = asBullet(input.text);
      const content = existing.trim()
        ? `${existing.trim()}\n${bullet}`
        : bullet;
      return write({
        scope: input.scope,
        scopeId: input.scopeId,
        content,
        updatedBy: 'manual',
      });
    },
    composeLayered(input) {
      const layers = [];
      const workspace = deps.store.get('workspace', '');
      layers.push({ scope: 'workspace' as ContextScope, content: workspace?.content ?? '' });
      if (input.repoId) {
        const repo = deps.store.get('repo', input.repoId);
        layers.push({ scope: 'repo' as ContextScope, content: repo?.content ?? '' });
      }
      if (input.featureId) {
        const feature = deps.store.get('feature', input.featureId);
        layers.push({
          scope: 'feature' as ContextScope,
          content: feature?.content ?? '',
        });
      }
      return composeSharedContext(layers, deps.config);
    },
    remove(scope, scopeId) {
      deps.store.delete(scope, scopeId);
    },
  };
}

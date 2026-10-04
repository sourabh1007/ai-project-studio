import type { ContextService } from './context-service.js';

export interface WorkspaceContextSeederDeps {
  /** Reads/writes the layered context store. */
  contexts: Pick<ContextService, 'get' | 'setContent'>;
  /**
   * Default workspace context to seed, supplied from configuration
   * (`context.defaultWorkspaceContext`) rather than hardcoded here. When blank,
   * seeding is disabled.
   */
  content: string;
}

/**
 * Seeds the editable workspace context document with the configured standing
 * prompt so every new session launches with it.
 *
 * It writes the configured default when no workspace document exists yet, and
 * also re-applies it when the stored document is present but blank — so a fresh
 * install, or a workspace whose context was cleared, is always populated by
 * default. A document the user has filled in with their own content is never
 * overwritten. The default text lives in `context.defaultWorkspaceContext`
 * (see `context-store/config.ts`); setting that config value empty disables
 * seeding entirely.
 */
export function seedWorkspaceContext(deps: WorkspaceContextSeederDeps): void {
  if (!deps.content.trim()) {
    return;
  }
  const existing = deps.contexts.get('workspace', '');
  if (existing && existing.content.trim()) {
    return;
  }
  deps.contexts.setContent({
    scope: 'workspace',
    scopeId: '',
    content: deps.content,
    updatedBy: 'import',
  });
}

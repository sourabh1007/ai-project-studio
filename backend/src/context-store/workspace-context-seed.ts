import type { ContextService } from './context-service.js';

/**
 * Default workspace-scope context seeded on first run. It is written once into
 * the editable workspace document (Settings → Workspace context) so every new
 * dev session is launched with these standing response principles. The user
 * stays free to edit or delete it afterwards — deletion is never undone,
 * because seeding runs at most once (see {@link seedWorkspaceContext}).
 */
export const DEFAULT_WORKSPACE_CONTEXT = [
  'Primary objective: maximize usefulness, accuracy, and clarity.',
  '',
  'Before responding:',
  '1. Determine what the user is actually trying to achieve.',
  '2. Provide the shortest response that fully solves the problem.',
  '3. Expand only when additional detail materially improves understanding or decision-making.',
  '4. Never fill knowledge gaps with assumptions.',
  '5. If something is unknown, say so directly.',
  '',
  'Response principles:',
  '- Human over robotic.',
  '- Practical over theoretical.',
  '- Precise over verbose.',
  '- Honest over confident.',
  '- Context-aware over generic.',
  '',
  'Do not:',
  '- Hallucinate facts.',
  '- Add unnecessary background.',
  '- Repeat information.',
  '- Turn simple questions into essays.',
  '- Provide superficial one-line answers to complex topics.',
].join('\n');

export interface WorkspaceContextSeederDeps {
  /** Reads/writes the layered context store. */
  contexts: Pick<ContextService, 'get' | 'setContent'>;
  /** Whether the one-time seed has already run (persisted marker). */
  hasSeeded: () => boolean;
  /** Records that the one-time seed has run, so it never repeats. */
  markSeeded: () => void;
  /** Content to write into the empty workspace document. */
  content: string;
}

/**
 * Seeds the editable workspace context document exactly once, so the configured
 * standing prompt is present for every new session the first time the app runs.
 *
 * It is deliberately idempotent and non-destructive:
 *  - It never runs again once {@link WorkspaceContextSeederDeps.markSeeded} has
 *    recorded the one-time seed, so a document the user later deletes does not
 *    reappear after an app restart.
 *  - It only writes when no workspace document exists yet (or it is blank), so a
 *    document the user has already curated is never overwritten.
 */
export function seedWorkspaceContext(deps: WorkspaceContextSeederDeps): void {
  if (deps.hasSeeded()) {
    return;
  }
  const existing = deps.contexts.get('workspace', '');
  if (!existing || existing.content.trim().length === 0) {
    deps.contexts.setContent({
      scope: 'workspace',
      scopeId: '',
      content: deps.content,
      updatedBy: 'import',
    });
  }
  deps.markSeeded();
}

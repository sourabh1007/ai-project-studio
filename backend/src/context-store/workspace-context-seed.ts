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
  /** Content to write when the workspace document is first created. */
  content: string;
}

/**
 * Seeds the editable workspace context document with the configured standing
 * prompt the first time the app runs, so every new session launches with it.
 *
 * It only writes when no workspace document exists yet, which makes it both
 * idempotent and non-destructive: a document the user has edited — or cleared
 * to blank and saved — already exists, so it is never overwritten or
 * resurrected on a later launch. Because it keys off the document's own
 * presence it needs no separate persisted flag, and so never writes to the
 * validated config store.
 */
export function seedWorkspaceContext(deps: WorkspaceContextSeederDeps): void {
  if (deps.contexts.get('workspace', '')) {
    return;
  }
  deps.contexts.setContent({
    scope: 'workspace',
    scopeId: '',
    content: deps.content,
    updatedBy: 'import',
  });
}

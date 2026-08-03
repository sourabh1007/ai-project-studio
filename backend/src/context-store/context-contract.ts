/**
 * Contracts for the central, layered shared-context store.
 *
 * Context is curated instruction-style markdown that survives across sessions
 * and is injected into every dev session at launch (and live-pushed into
 * already-running ones). It is organised in three layers that cascade from most
 * general to most specific:
 *
 *   workspace  — one global document shared by every repo and feature.
 *   repo       — one document per repository, shared by its features/sessions.
 *   feature    — one document per feature, the default target for auto-merge.
 *
 * Each layer holds a single markdown blob per scope id, mirroring the proven
 * single-document-per-scope shape of {@link RepositoryContext}.
 */

/** The three cascading layers, ordered most-general to most-specific. */
export type ContextScope = 'workspace' | 'repo' | 'feature';

/** How the current content of a document was last produced. */
export type ContextUpdatedBy = 'merge' | 'manual' | 'import';

/** A single curated context document for one scope. */
export interface ContextDocument {
  /** The layer this document belongs to. */
  scope: ContextScope;
  /**
   * Identifier within the layer: `''` for the singleton workspace document, a
   * repository id for `repo`, or a feature id for `feature`.
   */
  scopeId: string;
  /** Curated, instruction-style markdown. Never null (absent rows read as no doc). */
  content: string;
  /** ISO timestamp of the last write. */
  updatedAt: string;
  /** Origin of the current content. */
  updatedBy: ContextUpdatedBy;
}

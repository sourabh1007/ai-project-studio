import type { ContextDocument, ContextScope } from './context-contract.js';

/**
 * Port for persisting and retrieving layered context documents. Implemented by
 * the persistence module; services depend only on this interface so the store
 * can be swapped or faked in tests.
 */
export interface ContextStore {
  /** Return the document for a scope, or `null` when none exists. */
  get(scope: ContextScope, scopeId: string): ContextDocument | null;
  /** Insert or replace the document for its scope. */
  save(doc: ContextDocument): void;
  /** Remove the document for a scope. No-op when absent. */
  delete(scope: ContextScope, scopeId: string): void;
}

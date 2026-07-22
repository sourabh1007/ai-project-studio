import type { Session } from './session-contract.js';

/** Persistence port for sessions. Implemented by the persistence module. */
export interface SessionRepo {
  /** Insert or update a session by id. */
  save(session: Session): void;
  get(id: string): Session | null;
  listByFeature(featureId: string): Session[];
  listAll(): Session[];
  delete(id: string): void;
  deleteByFeature(featureId: string): void;
}

import type { Session } from './session-contract.js';

/** Persistence port for sessions. Implemented by the persistence module. */
export interface SessionRepo {
  /** Insert or update a session by id. */
  save(session: Session): void;
  get(id: string): Session | null;
  listByFeature(featureId: string): Session[];
  listAll(): Session[];
  /** Updates only the display name; null reverts to the ordinal label. */
  rename(id: string, name: string | null): void;
  /** Re-homes a session to a container and sets its sort position. */
  updatePlacement(
    id: string,
    placement: { featureId: string; groupId: string | null; orderIndex: number },
  ): void;
  delete(id: string): void;
  deleteByFeature(featureId: string): void;
}

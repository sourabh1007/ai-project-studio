import type { Transcript } from './transcript-capture.js';

/**
 * Port for persisting and retrieving session transcripts. Implemented by the
 * persistence module; the orchestrator depends only on this interface.
 */
export interface TranscriptStore {
  save(transcript: Transcript): Promise<void>;
  load(sessionId: string): Promise<Transcript | null>;
  delete(sessionId: string): Promise<void>;
}

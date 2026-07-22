import type { SessionEvent } from '../provider/provider-contract.js';

/** Accumulated output of a session run. */
export interface Transcript {
  sessionId: string;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}

/** Stateful recorder that folds streaming SessionEvents into a Transcript. */
export interface TranscriptCapture {
  record(event: SessionEvent): void;
  result(): Transcript;
}

export function createTranscriptCapture(sessionId: string): TranscriptCapture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;

  return {
    record(event) {
      switch (event.type) {
        case 'stdout':
          stdout.push(event.line);
          break;
        case 'stderr':
          stderr.push(event.line);
          break;
        case 'exit':
          exitCode = event.code;
          break;
      }
    },
    result() {
      return { sessionId, stdout: [...stdout], stderr: [...stderr], exitCode };
    },
  };
}

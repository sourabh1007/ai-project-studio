import path from 'node:path';
import type { SessionConfig } from './config.js';

/** Builds the per-session usage (OTel JSONL) file path from session config. */
export function buildUsageFilePath(
  config: SessionConfig,
  sessionId: string,
): string {
  return path.join(
    config.usageDir,
    `${sessionId}${config.usageFileExtension}`,
  );
}

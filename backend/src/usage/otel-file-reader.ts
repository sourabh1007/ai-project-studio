import { readFile as fsReadFile } from 'node:fs/promises';
import { parseOtelLine } from './otel-record-parser.js';
import { isIncludedSpan, normalizeSpan } from './usage-normalizer.js';
import type { UsageConfig } from './config.js';
import type { UsageEvent } from './usage-contract.js';

export type ReadFile = (path: string) => Promise<string>;

const defaultReadFile: ReadFile = (path) => fsReadFile(path, 'utf8');

/**
 * Reads a session's OTel usage file and returns all captured UsageEvents in
 * file order. Missing files yield an empty list (the session may not have
 * emitted usage yet). Injectable readFile keeps this unit-testable.
 */
export async function readUsageEvents(
  filePath: string,
  config: UsageConfig,
  readFile: ReadFile = defaultReadFile,
): Promise<UsageEvent[]> {
  let content: string;
  try {
    content = await readFile(filePath);
  } catch {
    return [];
  }

  const events: UsageEvent[] = [];
  let turnIndex = 0;
  for (const line of content.split('\n')) {
    const record = parseOtelLine(line);
    if (record?.kind === 'span' && isIncludedSpan(record, config)) {
      events.push(normalizeSpan(record, config, turnIndex));
      turnIndex += 1;
    }
  }
  return events;
}

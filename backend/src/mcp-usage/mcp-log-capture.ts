import type { Logger } from '../kernel/logger.js';
import type { McpObservedCall, McpObservedUsageRepo } from './mcp-usage-contract.js';

export interface McpLogSource {
  key: string;
  provider: string;
  sessionId: string;
}

export interface McpLogOwnership {
  featureId: string;
  sessionId: string;
  scope: 'feature' | 'internal';
}

export interface McpLogOwners {
  list(after: string, limit: number): McpLogSource[];
  /** Rechecked after IO; removed or ambiguously shared sessions have no owner. */
  resolve(source: McpLogSource, timestamp: string): McpLogOwnership | null;
}

export interface McpLogCursor {
  offset: number;
  skipping: boolean;
}

export interface McpLogPage {
  lines: string[];
  cursor: McpLogCursor;
  oversized: boolean;
}

export interface McpLogReader {
  read(sessionId: string, cursor: McpLogCursor, maxBytes: number): Promise<McpLogPage>;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Only explicit public CLI MCP identity fields qualify; tool-name prefixes do not. */
export function mcpCallFromEvent(value: unknown): Pick<McpObservedCall, 'server' | 'callId' | 'origin' | 'recordedAt'> | null {
  const event = object(value);
  if (event?.type !== 'tool.execution_start') return null;
  const data = object(event.data);
  if (!data || !identifier(data.toolCallId)) return null;
  const server = data.mcpConfigServerName ?? data.mcpServerName;
  if (!identifier(server) || typeof event.timestamp !== 'string'
    || !Number.isFinite(Date.parse(event.timestamp))) return null;
  const source = data.mcpConfigSource;
  return {
    server, callId: data.toolCallId, recordedAt: new Date(event.timestamp).toISOString(),
    origin: source === 'builtin' ? 'built-in'
      : source === 'user' || source === 'workspace' || source === 'plugin' ? 'configured' : 'unknown',
  };
}

export interface McpLogCaptureDeps {
  owners: McpLogOwners;
  reader: McpLogReader;
  usage: McpObservedUsageRepo;
  logger: Pick<Logger, 'warn'>;
  sourcesPerTick: number;
  bytesPerSource: number;
  maxCachedSources: number;
}

/**
 * Bounded historical/live reconciliation. Replays after restart are safe because
 * the sink owns durable call identities, not this disposable offset cache.
 */
export function createMcpLogCapture(deps: McpLogCaptureDeps) {
  const cursors = new Map<string, McpLogCursor>();
  let after = '';
  let running = false;
  let stopped = false;
  return {
    async tick(): Promise<void> {
      if (running || stopped) return;
      running = true;
      try {
        const sources = deps.owners.list(after, deps.sourcesPerTick);
        after = sources.length === deps.sourcesPerTick ? sources[sources.length - 1].key : '';
        for (const source of sources) {
          if (stopped) break;
          try {
            const page = await deps.reader.read(source.sessionId,
              cursors.get(source.key) ?? { offset: 0, skipping: false }, deps.bytesPerSource);
            if (stopped) break;
            let malformed = 0;
            let unattributed = 0;
            for (const line of page.lines) {
              let event: unknown;
              try { event = JSON.parse(line); } catch { malformed += 1; continue; }
              const call = mcpCallFromEvent(event);
              if (!call) continue;
              const owner = deps.owners.resolve(source, call.recordedAt);
              if (!owner) { unattributed += 1; continue; }
              deps.usage.recordObserved({
                ...call, ...owner, provider: source.provider,
                callId: JSON.stringify([source.sessionId, call.callId]),
              });
            }
            if (page.oversized || malformed || unattributed) {
              deps.logger.warn('MCP usage log capture is partial', {
                source: source.key, oversized: page.oversized, malformed, unattributed,
              });
            }
            cursors.delete(source.key);
            cursors.set(source.key, page.cursor);
            if (cursors.size > deps.maxCachedSources) {
              const oldest = cursors.keys().next().value!;
              cursors.delete(oldest);
            }
          } catch {
            // Do not log the event, arguments, result, or filesystem error text.
            deps.logger.warn('MCP usage log unavailable; capture will retry', { source: source.key });
          }
        }
      } catch {
        deps.logger.warn('MCP usage source enumeration failed; capture will retry');
      } finally {
        running = false;
      }
    },
    stop(): void { stopped = true; },
  };
}

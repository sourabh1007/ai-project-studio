import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createCliMcpLogReader } from './cli-mcp-log-reader.js';
import type { McpLogCursor } from '../../mcp-usage/mcp-log-capture.js';
import { createMcpLogCapture } from '../../mcp-usage/mcp-log-capture.js';
import { createDatabase } from '../../persistence/db/connection.js';
import { createMcpUsageRepo } from '../../persistence/mcp-usage-repo.js';
import { createMcpLogOwners } from '../../persistence/mcp-log-owners.js';
import { createUsageRollupRepo } from '../../persistence/usage-rollup-repo.js';
import { ideUsageDefaults } from '../../ide-usage/config.js';

const dirs: string[] = [];
async function fixture(contents: string) {
  const root = await mkdtemp(join(process.cwd(), '.mcp-log-'));
  dirs.push(root);
  await mkdir(join(root, 'session'));
  const path = join(root, 'session', 'events.jsonl');
  await writeFile(path, contents);
  return { reader: createCliMcpLogReader(root), path };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const start = { offset: 0, skipping: false };

describe('bounded read-only CLI event logs', () => {
  it('preserves UTF-8, CRLF and trailing records across appends', async () => {
    const { reader, path } = await fixture('{"name":"\u00e9"}\r\n\n{"partial"');
    const first = await reader.read('session', start, 1000);
    expect(first.lines).toEqual(['{"name":"\u00e9"}\r']);
    const partial = await reader.read('session', first.cursor, 1000);
    expect(partial.lines).toEqual([]);
    expect(partial.cursor).toEqual(first.cursor);
    await appendFile(path, ':true}\n');
    const last = await reader.read('session', partial.cursor, 1000);
    expect(last.lines).toEqual(['{"partial":true}']);
    const eof = await reader.read('session', last.cursor, 1000);
    expect(eof.cursor).toEqual(last.cursor);
    expect(eof.lines).toEqual([]);
  });
  it('resets a truncated source and discards oversized records until newline', async () => {
    const { reader, path } = await fixture('x'.repeat(10) + '\n{}\n');
    const first = await reader.read('session', start, 5);
    expect(first).toEqual({ lines: [], cursor: { offset: 5, skipping: true }, oversized: true });
    const second = await reader.read('session', first.cursor, 5);
    expect(second.cursor).toEqual({ offset: 10, skipping: true });
    const third = await reader.read('session', second.cursor, 5);
    expect(third.lines).toEqual(['{}']);
    await writeFile(path, '{}\n');
    const reset = await reader.read('session', { offset: 100, skipping: true }, 5);
    expect(reset.lines).toEqual(['{}']);
    expect(reset.cursor).toEqual({ offset: 3, skipping: false });
  });
  it('retains a partial oversized record skip state until its terminating newline arrives', async () => {
    const { reader, path } = await fixture('12345xx');
    const first = await reader.read('session', start, 5);
    const partial = await reader.read('session', first.cursor, 5);
    expect(partial.cursor).toEqual(first.cursor);
    await appendFile(path, '\n');
    expect((await reader.read('session', partial.cursor, 5)).lines).toEqual([]);
  });
  it.each([
    ['../outside', 4, start], ['', 4, start], ['x'.repeat(129), 4, start],
    ['session', 0, start], ['session', 1048577, start], ['session', 1.5, start],
    ['session', 4, { offset: -1, skipping: false }], ['session', 4, { offset: 1.5, skipping: false }],
  ] as [string, number, McpLogCursor][])('rejects unsafe identities or read bounds %s %s', async (id, limit, cursor) => {
    await expect(createCliMcpLogReader('.').read(id, cursor, limit)).rejects.toThrow('Invalid MCP log');
  });
  it('surfaces missing sources rather than returning empty success', async () => {
    const { reader } = await fixture('');
    await expect(reader.read('missing', start, 20)).rejects.toThrow();
  });
  it('captures native built-in and configured calls through persistent rollups, replay and deletion', async () => {
    const at = '2026-09-26T12:00:00.000Z';
    const lines = [
      { type: 'tool.execution_start', timestamp: at, data: {
        toolCallId: 'one', mcpServerName: 'ado', mcpConfigSource: 'builtin',
      } },
      { type: 'tool.execution_start', timestamp: at, data: {
        toolCallId: 'two', mcpServerName: 'files', mcpConfigSource: 'user',
      } },
      { type: 'tool.execution_complete', timestamp: at, data: { toolCallId: 'two', success: false } },
      { type: 'tool.execution_start', timestamp: at, data: { toolCallId: 'shell', toolName: 'powershell' } },
    ].map((value) => JSON.stringify(value)).join('\n') + '\n';
    const { reader } = await fixture(lines);
    const db = createDatabase({ databasePath: ':memory:' });
    try {
      db.exec(`INSERT INTO sessions (id, feature_id, provider, requested_model, status, kind, scope, prompt, usage_file_path, created_at)
        VALUES ('session', 'f', 'agency', 'auto', 'running', 'chat', 'feature', '', '', '${at}')`);
      const usage = createMcpUsageRepo(db);
      const rollups = createUsageRollupRepo(db, ideUsageDefaults);
      const deps = {
        reader, usage, owners: createMcpLogOwners(db), logger: { warn: () => { throw new Error('Unexpected capture warning'); } },
        sourcesPerTick: 8, bytesPerSource: 4096, maxCachedSources: 16,
      };
      await createMcpLogCapture(deps).tick();
      await createMcpLogCapture(deps).tick();
      expect(rollups.workspaceMcpServers()).toEqual([
        expect.objectContaining({ server: 'ado', provider: 'agency', origin: 'built-in', calls: 1,
          inputTokens: null, outputTokens: null, nanoAiu: null, credits: null, attribution: 'unavailable' }),
        expect.objectContaining({ server: 'files', provider: 'agency', origin: 'configured', calls: 1 }),
      ]);
      usage.record({ featureId: 'f', sessionId: 'session', provider: 'agency', server: 'files',
        calls: 1, inputBytes: 25, outputBytes: 50, durationMs: 12, recordedAt: at });
      expect(rollups.featureMcpServers('f').find((row) => row.server === 'files')).toMatchObject({
        calls: 1, inputBytes: 25, outputBytes: 50, durationMs: 12,
      });
      usage.deleteBySession('session');
      db.exec("DELETE FROM sessions WHERE id = 'session'");
      await createMcpLogCapture(deps).tick();
      expect(rollups.workspaceMcpServers()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

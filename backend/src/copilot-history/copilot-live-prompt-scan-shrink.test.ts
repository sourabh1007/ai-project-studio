import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let shrinkAfterReads = Infinity;
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      let reads = 0;
      const originalRead = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
      (handle as unknown as { read: unknown }).read = async (...a: unknown[]) => {
        reads += 1;
        return reads > shrinkAfterReads ? { bytesRead: 0 } : originalRead(...a);
      };
      return handle;
    },
  };
});

const { scanLiveLog } = await import('./copilot-live-prompt-fs-adapter.js');

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cw scan shrink-'));
  mkdirSync(join(root, 's'));
  const user = JSON.stringify({ type: 'user.message', data: { content: 'latest', messageId: 'm1' }, timestamp: '2024-01-01T00:00:00Z' });
  const filler = JSON.stringify({ type: 'tool.execution_complete', data: { output: 'x'.repeat(300) }, timestamp: '2024-01-01T00:00:01Z' });
  writeFileSync(join(root, 's', 'events.jsonl'), [user, ...Array.from({ length: 20 }, () => filler)].join('\n') + '\n');
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('scanLiveLog when the log shrinks or rotates mid-scan', () => {
  const input = () => ({ path: join(root, 's', 'events.jsonl'), tailBytes: 1000, maxScanBytes: 100_000 });

  it('stops with no turn instead of mixing stale offsets when a later read comes back short', async () => {
    shrinkAfterReads = 1;
    expect(await scanLiveLog(input())).toBeNull();
  });

  it('returns no turn when the very first read is short', async () => {
    shrinkAfterReads = 0;
    expect(await scanLiveLog(input())).toBeNull();
  });

  it('still finds the prompt when the file is stable', async () => {
    shrinkAfterReads = Infinity;
    expect(await scanLiveLog(input())).toMatchObject({ text: 'latest' });
  });
});

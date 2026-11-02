import { createServer } from 'node:http';
import { transferableAbortController } from 'node:util';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../../backend/src/persistence/db/connection.js';
import { createFeatureRepo } from '../../../backend/src/persistence/feature-repo.js';
import { createRepoRepo } from '../../../backend/src/persistence/repo-repo.js';
import { createClientOperationRepo } from '../../../backend/src/persistence/client-operation-repo.js';
import { createSqliteUnitOfWork } from '../../../backend/src/persistence/sqlite-unit-of-work.js';
import { createFeatureService } from '../../../backend/src/feature/feature-service.js';
import { createClientOperations } from '../../../backend/src/client-operations/client-operations-service.js';
import { clientOperationsDefaults } from '../../../backend/src/client-operations/config.js';
import { createFeatureRoutes } from '../../../backend/src/api/feature-controller.js';
import { mountRoutes } from '../../../backend/src/api/express-adapter.js';
import { createApiClient } from '../lib/api.js';
import { PrImportStore } from '../lib/pr-import-store.js';
import {
  createOperationKeyStore,
  OPERATION_KEYS_STORAGE_KEY,
  withOperationKey,
} from '../lib/operation-keys.js';
import type { Feature } from '../lib/types.js';

// Reuse the backend's native SQLite loading approach without changing UI tooling.
vi.mock('node:sqlite', async () => {
  const { createRequire } = await import('node:module');
  const sqlite = createRequire(import.meta.url)('node:sqlite');
  return { ...sqlite, default: sqlite };
});

async function fixture() {
  const db = createDatabase({ databasePath: ':memory:' });
  const clock = { now: () => new Date(), isoNow: () => new Date().toISOString() };
  let seq = 0;
  const repos = createRepoRepo(db);
  repos.create({
    id: 'r1', provider: 'github', name: 'acme/app', localPath: 'C:\\fixture',
    remoteUrl: 'https://example.invalid/acme/app', defaultBranch: 'main', createdAt: clock.isoNow(),
  });
  const features = createFeatureService({
    repo: createFeatureRepo(db), ids: { next: () => `f-${++seq}` }, clock,
    repos: { get: (id) => repos.get(id) }, groups: { get: () => null },
  });
  const operations = createClientOperations({
    repo: createClientOperationRepo(db), unitOfWork: createSqliteUnitOfWork(db),
    clock, config: clientOperationsDefaults,
  });
  const app = express();
  app.use(express.json());
  const keys: string[] = [];
  app.use((req, _res, next) => {
    if (req.method === 'POST') keys.push(req.header('Idempotency-Key') ?? '');
    next();
  });
  const router = express.Router();
  mountRoutes(router, createFeatureRoutes({ features, operations, admin: {} as never }));
  app.use('/api', router);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  let dropResponse = true;
  let staleList = false;
  const api = createApiClient({
    baseUrl: `http://127.0.0.1:${address.port}/api`,
    fetchImpl: async (input, init) => {
      // jsdom signals and Node's native HTTP transport have different brands.
      const transport = transferableAbortController();
      const abort = () => transport.abort(init?.signal?.reason);
      if (init?.signal?.aborted) abort();
      init?.signal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await fetch(input, { ...init, signal: transport.signal });
        const body = await response.text();
        if (init?.method === 'POST' && dropResponse) {
          dropResponse = false;
          expect(response.status).toBe(201);
          // The database commit succeeded, but the caller only sees a gateway failure.
          return new Response(JSON.stringify({ error: { message: 'Lost committed response' } }), { status: 502 });
        }
        if (staleList && String(input).endsWith('/features') && !init?.method) {
          return new Response('[]', { status: 200 });
        }
        return new Response(body, { status: response.status, headers: response.headers });
      } finally {
        init?.signal?.removeEventListener('abort', abort);
      }
    },
  });
  return {
    api, features, keys,
    staleList: () => { staleList = true; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
    },
  };
}

describe('durable creation through the UI client, HTTP routes and SQLite', () => {
  it('replays a committed PR parent after a gateway failure, reload and stale reconciliation read', async () => {
    const h = await fixture();
    try {
      const stream = vi.fn(async () => ({ feature: { id: 'review' } as Feature, alreadyImported: false }));
      const api = { ...h.api, createPrFeatureStreamed: stream };
      const first = new PrImportStore(Date.now, localStorage, () => 'batch-token');
      first.enqueue(api, {
        repo: { id: 'r1', name: 'acme/app' }, batchName: 'Bulk',
        pulls: [{ number: 1, title: 'First' }, { number: 2, title: 'Second' }],
      });
      await vi.waitFor(() => expect(first.getSnapshot().map((job) => job.status)).toEqual(['unknown', 'unknown']));
      expect(h.features.list()).toHaveLength(1);
      expect(stream).not.toHaveBeenCalled();
      h.staleList();
      const reloaded = new PrImportStore(Date.now, localStorage);
      reloaded.bindApi(api);
      reloaded.retry(reloaded.getSnapshot()[0].id);
      await vi.waitFor(() => expect(reloaded.getSnapshot()[0]).toMatchObject({ status: 'succeeded', error: null }));
      expect(h.keys).toEqual(['pr-import-parent-batch-token', 'pr-import-parent-batch-token']);
      expect(h.features.list()).toHaveLength(1);
      expect(reloaded.getBatch(reloaded.getSnapshot()[0].batchId)?.parent?.id).toBe(h.features.list()[0].id);
      expect(stream).toHaveBeenCalledTimes(1);
    } finally {
      await h.close();
    }
  });

  it('sends no second HTTP create when unresolved retry protection is corrupted after reload', async () => {
    const h = await fixture();
    try {
      const input = { name: 'Task', description: 'Work' };
      const run = (store: ReturnType<typeof createOperationKeyStore>) =>
        withOperationKey('task-create', input, 'feature',
          (operation) => h.api.createFeature(input, operation), store);
      await expect(run(createOperationKeyStore({ storage: localStorage }))).rejects.toMatchObject({ status: 502 });
      expect(h.features.list()).toHaveLength(1);
      localStorage.setItem(OPERATION_KEYS_STORAGE_KEY, '{damaged');
      await expect(run(createOperationKeyStore({ storage: localStorage }))).rejects.toThrow('Retry protection is damaged');
      expect(h.keys).toHaveLength(1);
      expect(h.features.list()).toHaveLength(1);
      expect(localStorage.getItem(OPERATION_KEYS_STORAGE_KEY)).toBe('{damaged');
    } finally {
      await h.close();
    }
  });
});

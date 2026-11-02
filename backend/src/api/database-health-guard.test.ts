import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { guardDatabaseRoutes } from './database-health-guard.js';
import type { HttpRequest, Route } from './http-contract.js';
import { createSqliteUnitOfWork } from '../persistence/sqlite-unit-of-work.js';
import { UnitOfWorkUncertainError } from '../persistence/unit-of-work.js';

const request: HttpRequest = { params: {}, query: {}, body: undefined };

describe('guardDatabaseRoutes', () => {
  it('preserves metadata and forwards the original request and async result while healthy', async () => {
    const result = { status: 201, body: { id: 'created' } };
    const handler = vi.fn(async () => result);
    const scope = () => ({ featureIds: ['f'] });
    const route: Route = { method: 'post', path: '/features', handler, workScope: scope };
    const [guarded] = guardDatabaseRoutes([route], () => false);
    expect(guarded.workScope).toBe(scope);
    expect(await guarded.handler(request)).toBe(result);
    expect(handler).toHaveBeenCalledWith(request);
  });

  it('refuses both reads and writes before their handlers run once poisoned', () => {
    let poisoned = false;
    const handler = vi.fn(() => ({ status: 200, body: 'ok' }));
    const routes: Route[] = [
      { method: 'get', path: '/features', handler },
      { method: 'post', path: '/health', handler },
    ];
    const guarded = guardDatabaseRoutes(routes, () => poisoned);
    expect(guarded[0].handler(request)).toEqual({ status: 200, body: 'ok' });
    handler.mockClear();
    poisoned = true;
    for (const route of guarded) {
      expect(() => route.handler(request)).toThrow('Restart the backend');
      try {
        route.handler(request);
      } catch (error) {
        expect(error).toMatchObject({ kind: 'unavailable', details: { code: 'database_restart_required' } });
      }
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps only the exact GET health route available for diagnostics', () => {
    const route: Route = { method: 'get', path: '/health', handler: () => ({ status: 200, body: 'restart_required' }) };
    const poisoned = vi.fn(() => true);
    expect(guardDatabaseRoutes([route], poisoned)[0]).toBe(route);
    expect(route.handler(request)).toEqual({ status: 200, body: 'restart_required' });
    expect(poisoned).not.toHaveBeenCalled();
  });

  it('invalidates an already prepared database reader after an uncertain transaction while retaining health', () => {
    const database = new DatabaseSync(':memory:');
    let closed = false;
    const closeDatabase = () => {
      if (closed) return;
      database.close();
      closed = true;
    };
    try {
      const statement = database.prepare('SELECT 1 AS value');
      const nativeExec = database.exec.bind(database);
      vi.spyOn(database, 'exec').mockImplementation((sql) => {
        if (/^(COMMIT|ROLLBACK)\b/i.test(sql.trim())) throw new Error('injected transaction failure');
        nativeExec(sql);
      });
      const onPoisoned = vi.fn(closeDatabase);
      const work = createSqliteUnitOfWork(database, { onPoisoned });
      const reader = vi.fn(() => ({ status: 200, body: statement.get() }));
      const routes = guardDatabaseRoutes([
        { method: 'get', path: '/features', handler: reader },
        { method: 'get', path: '/health', handler: () => ({ status: 200, body: { restartRequired: work.poisoned, closed } }) },
      ], () => work.poisoned);
      expect(() => work.run(() => undefined)).toThrow(UnitOfWorkUncertainError);
      expect(work.poisoned).toBe(true);
      expect(onPoisoned).toHaveBeenCalledOnce();
      expect(() => statement.get()).toThrow();
      expect(() => routes[0].handler(request)).toThrow('Restart the backend');
      expect(reader).not.toHaveBeenCalled();
      expect(routes[1].handler(request)).toEqual({ status: 200, body: { restartRequired: true, closed: true } });
      closeDatabase();
      expect(onPoisoned).toHaveBeenCalledOnce();
    } finally {
      closeDatabase();
    }
  });
});

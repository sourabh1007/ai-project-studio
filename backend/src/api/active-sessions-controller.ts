import type { ActiveSessionsService } from '../active-sessions/active-sessions-contract.js';
import type { Route } from './http-contract.js';

export function createActiveSessionsRoutes(service: ActiveSessionsService): Route[] {
  return [
    { method: 'get', path: '/active-sessions', handler: () => ({ status: 200, body: service.snapshot() }) },
    {
      method: 'get', path: '/active-sessions/:id/debug',
      handler(req) {
        const id = req.params.id;
        if (!id || id.length > 512 || !/^(warm|session):.+$/.test(id)) {
          return { status: 400, body: { error: { kind: 'validation', message: 'Invalid active session ID' } } };
        }
        return { status: 200, body: service.debug(id) };
      },
    },
  ];
}

import { AppError } from '../kernel/error-types.js';
import type { Route } from './http-contract.js';

/** Leave health reachable while refusing work on a connection requiring restart. */
export function guardDatabaseRoutes(routes: Route[], isPoisoned: () => boolean): Route[] {
  return routes.map((route) => route.method === 'get' && route.path === '/health' ? route : {
    ...route,
    handler: (request) => {
      if (isPoisoned()) {
        throw new AppError('unavailable', 'The database transaction outcome is unknown. Restart the backend before continuing.', {
          code: 'database_restart_required',
        });
      }
      return route.handler(request);
    },
  });
}

import { describe, it, expect } from 'vitest';
import { createApiRoutes, type ApiRoutesDeps } from './routes.js';

function deps(): ApiRoutesDeps {
  const empty = {} as never;
  return {
    features: empty,
    admin: empty,
    launcher: empty,
    resolver: empty,
    factory: empty,
    sessionConfig: empty,
    sessions: empty,
    providers: empty,
    aggregates: empty,
    summarizer: empty,
    summaries: empty,
    configRegistry: empty,
    currentConfig: {},
    logger: empty,
  };
}

describe('createApiRoutes', () => {
  it('assembles the full route table from every controller', () => {
    const routes = createApiRoutes(deps());
    const signatures = routes.map((r) => `${r.method} ${r.path}`);
    expect(signatures).toEqual([
      'post /features',
      'get /features',
      'get /features/:id',
      'put /features/:id',
      'delete /features/:id',
      'post /features/:featureId/sessions',
      'get /features/:featureId/sessions',
      'get /sessions/:id',
      'delete /sessions/:id',
      'post /features/:featureId/terminal-sessions',
      'get /providers',
      'get /providers/:id/models',
      'get /features/:featureId/usage',
      'get /usage/totals',
      'get /usage/workspace',
      'post /features/:featureId/summary',
      'get /features/:featureId/summary',
      'get /config',
    ]);
  });
});

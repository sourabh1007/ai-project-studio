import type { AgencyStatus } from '../agency-bootstrap/agency-bootstrapper.js';
import type { Route } from './http-contract.js';

export interface AgencyControllerDeps {
  agencyStatus: () => AgencyStatus;
}

/** Route exposing whether the bundled `agency` CLI is installed. */
export function createAgencyRoutes(deps: AgencyControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/agency/status',
      handler: () => ({ status: 200, body: deps.agencyStatus() }),
    },
  ];
}

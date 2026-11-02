import { AppError } from './error-types.js';

export type CredentialRead =
  | { state: 'ready'; token: string }
  | { state: 'signed-out' }
  | { state: 'interaction-required' }
  | { state: 'unavailable' };

export function credentialFromRead(result: CredentialRead): string | null {
  if (result.state === 'unavailable') {
    throw new AppError('unavailable', 'Stored credentials could not be checked. Existing account state was not replaced; retry the check.');
  }
  return result.state === 'ready' ? result.token : null;
}

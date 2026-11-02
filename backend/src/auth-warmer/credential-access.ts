import { credentialFromRead, type CredentialRead } from '../kernel/credential-read.js';
import { ConflictError } from '../kernel/error-types.js';
import type { CredentialRefresh } from './credential-refresh.js';

export async function readAccountStatus<T extends { authenticated: boolean }>(
  refresh: CredentialRefresh<string | null>,
  read: () => Promise<T>,
): Promise<T> {
  const generation = refresh.generation();
  const status = await refresh.run(read);
  if (generation !== refresh.generation()) {
    throw new ConflictError('The account changed while credentials were being checked. Retry the request.');
  }
  if (status.authenticated) await refresh.refresh();
  if (generation !== refresh.generation()) {
    throw new ConflictError('The account changed while credentials were being checked. Retry the request.');
  }
  return status;
}

export async function readAccountCredential(
  refresh: CredentialRefresh<string | null>,
  read: () => Promise<CredentialRead>,
): Promise<string | null> {
  const generation = refresh.generation();
  const result = await refresh.run(read);
  if (generation !== refresh.generation()) {
    throw new ConflictError('The account changed while credentials were being checked. Retry the request.');
  }
  const token = credentialFromRead(result);
  if (token) refresh.publish(generation, token);
  return token;
}

export async function readFirstCredential<T>(
  targets: Iterable<T>,
  read: (target: T) => Promise<CredentialRead>,
): Promise<CredentialRead> {
  let outcome: CredentialRead = { state: 'signed-out' };
  for (const target of targets) {
    const result = await read(target);
    if (result.state === 'ready') return result;
    if (result.state === 'unavailable' || outcome.state === 'signed-out') outcome = result;
  }
  return outcome;
}

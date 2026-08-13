/**
 * Credentials & secrets transparency inventory (Phase 1b).
 *
 * A companion to `network-activity.ts`: where 1a documents *what leaves* the
 * machine, this documents *where credentials live*. The audit finding it encodes
 * is that AI Project Studio manages no secret storage of its own — every token
 * is delegated to an OS-backed store (the `gh` keyring, Git Credential Manager)
 * or is fetched on demand from the underlying CLI, and configuration secrets are
 * kept only as `${env:NAME}` references that are resolved at read time and
 * redacted before ever crossing the local API. Pure data + pure helpers so it is
 * fully unit-testable and reusable by the Settings surface (and Phase 5c later).
 */

export interface CredentialStore {
  /** Stable identifier (React key / tests). */
  readonly id: string;
  /** What credential this covers (e.g. "GitHub sign-in"). */
  readonly name: string;
  /** The OS-backed or external store that actually holds the secret. */
  readonly backing: string;
  /** Plain-language description of how the secret is handled. */
  readonly description: string;
  /**
   * True only if AI Project Studio itself persists the secret. Every entry is
   * currently false — the app delegates storage — but the field is explicit so
   * the guarantee is visible and enforced by tests.
   */
  readonly managedByApp: boolean;
}

export const CREDENTIAL_STORES: readonly CredentialStore[] = [
  {
    id: 'github',
    name: 'GitHub sign-in',
    backing: 'GitHub CLI keyring (OS credential store)',
    description:
      'Tokens are issued and held by the `gh` CLI in the OS keyring. The app ' +
      'reads a token on demand for API calls and never writes it to its own storage.',
    managedByApp: false,
  },
  {
    id: 'azure-devops',
    name: 'Azure DevOps sign-in',
    backing: 'Git Credential Manager (OAuth cache)',
    description:
      'OAuth access/refresh tokens are cached by Git Credential Manager. The app ' +
      'requests an access token per operation and never persists it.',
    managedByApp: false,
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    backing: 'Copilot CLI',
    description:
      'Authentication is handled entirely by the Copilot CLI using its own ' +
      'credential storage; the app does not see or store the credential.',
    managedByApp: false,
  },
  {
    id: 'config-secrets',
    name: 'Configuration secrets',
    backing: 'Environment variables (${env:NAME} references)',
    description:
      'Secrets in configuration are stored only as ${env:NAME} references, ' +
      'resolved at read time, and redacted before configuration is returned over the API.',
    managedByApp: false,
  },
];

/** True when no catalogued credential is persisted by the app itself. */
export function allDelegated(
  stores: readonly CredentialStore[] = CREDENTIAL_STORES,
): boolean {
  return stores.every((store) => !store.managedByApp);
}

/**
 * Azure DevOps authentication that mirrors how Visual Studio / Git Credential
 * Manager (GCM) handle sign-in: enable the Windows broker (WAM) so GCM can do
 * silent single-sign-on with the signed-in Microsoft account, and perform an
 * interactive sign-in once to prime GCM's credential cache. After that, every
 * spawned session's `git` operations authenticate silently against Azure
 * DevOps (dev.azure.com / *.visualstudio.com) with no "Cannot prompt" failure.
 *
 * All process execution is injected so this module stays pure and unit-tested;
 * the real `git` / `git-credential-manager` runners are wired in main.ts.
 */

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `git-credential-manager <verb>`, feeding `input` on stdin. */
export type GitCredentialRunner = (
  verb: 'get' | 'erase',
  input: string,
  opts: { interactive: boolean },
) => Promise<GitRunResult>;

/** Runs `git <args>` (used for the idempotent broker configuration). */
export type GitConfigRunner = (args: string[]) => Promise<GitRunResult>;

export interface AzureDevOpsStatus {
  authenticated: boolean;
  account: string | null;
}

/** A resolved Azure DevOps credential target (host + optional organization). */
export interface AzureTarget {
  host: string;
  org: string | null;
}

export interface AzureDevOpsAuth {
  /** Enable the WAM broker so GCM can do silent SSO with the default account. */
  configureBroker(): Promise<void>;
  /** Whether GCM already has a cached, usable credential for the target. */
  status(target: AzureTarget): Promise<AzureDevOpsStatus>;
  /** Trigger an interactive sign-in (WAM/browser) and cache the credential. */
  signIn(target: AzureTarget): Promise<AzureDevOpsStatus>;
}

/**
 * Resolves a user-supplied organization, remote URL, or host into an Azure
 * DevOps credential target. A bare word (e.g. "contoso") is treated as an
 * organization on dev.azure.com; anything URL-shaped is parsed for its host and
 * organization. Falls back to the account-level dev.azure.com target.
 */
export function parseAzureTarget(
  input: string | null | undefined,
): AzureTarget {
  const fallback: AzureTarget = { host: 'dev.azure.com', org: null };
  const raw = (input ?? '').trim();
  if (!raw) {
    return fallback;
  }

  const looksLikeUrl =
    raw.includes('://') || raw.includes('/') || raw.includes('.');
  if (!looksLikeUrl) {
    return { host: 'dev.azure.com', org: raw };
  }

  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return { host: 'dev.azure.com', org: raw };
  }

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  if (host.endsWith('.visualstudio.com')) {
    return { host, org: host.split('.')[0] || null };
  }
  if (host === 'dev.azure.com' || host === 'ssh.dev.azure.com') {
    return { host: 'dev.azure.com', org: segments[0] ?? null };
  }
  return { host, org: segments[0] ?? null };
}

/**
 * Builds the stdin payload for `git-credential-manager get`. For dev.azure.com
 * and on-prem hosts the organization is supplied via `path=` (GCM's Azure Repos
 * provider derives the org from it); for *.visualstudio.com the org is already
 * encoded in the host.
 */
export function buildCredentialQuery(target: AzureTarget): string {
  const lines = ['protocol=https', `host=${target.host}`];
  if (target.org && !target.host.endsWith('.visualstudio.com')) {
    lines.push(`path=${target.org}`);
  }
  return `${lines.join('\n')}\n\n`;
}

/** Parses the `key=value` credential output GCM writes to stdout. */
export function parseCredentialOutput(stdout: string): AzureDevOpsStatus {
  const fields = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      fields.set(line.slice(0, eq).trim(), line.slice(eq + 1));
    }
  }
  const password = fields.get('password') ?? '';
  const authenticated = password.length > 0;
  return {
    authenticated,
    account: authenticated ? (fields.get('username') ?? null) : null,
  };
}

/** Builds the Azure DevOps auth facade from injected process runners. */
export function createAzureDevOpsAuth(deps: {
  credential: GitCredentialRunner;
  config: GitConfigRunner;
}): AzureDevOpsAuth {
  const check = async (
    target: AzureTarget,
    interactive: boolean,
  ): Promise<AzureDevOpsStatus> => {
    const res = await deps.credential('get', buildCredentialQuery(target), {
      interactive,
    });
    if (res.code !== 0) {
      return { authenticated: false, account: null };
    }
    return parseCredentialOutput(res.stdout);
  };

  return {
    async configureBroker() {
      await deps.config([
        'config',
        '--global',
        'credential.msauthUseBroker',
        'true',
      ]);
      await deps.config([
        'config',
        '--global',
        'credential.msauthUseDefaultAccount',
        'true',
      ]);
    },
    status(target) {
      return check(target, false);
    },
    signIn(target) {
      return check(target, true);
    },
  };
}

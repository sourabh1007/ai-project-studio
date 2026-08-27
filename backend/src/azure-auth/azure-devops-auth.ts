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
  /**
   * A human-readable reason a sign-in did not authenticate (e.g. GCM missing,
   * no access, or the browser flow was cancelled). Null when authenticated or
   * for a silent status check, where "not signed in" is the normal state.
   */
  message: string | null;
}

/** A resolved Azure DevOps credential target (host + optional organization). */
export interface AzureTarget {
  host: string;
  org: string | null;
}

export interface AzureDevOpsAuth {
  /**
   * Configure GCM for Azure DevOps the way the IDE needs: OAuth credentials
   * (org-agnostic Entra tokens, no PAT juggling) and the browser sign-in flow
   * rather than the WAM broker — the broker needs a parent window we don't have
   * when GCM is spawned from the background, so it would hang. The browser flow
   * launches the default browser and caches a refresh token, after which every
   * session acquires access tokens silently.
   */
  configure(): Promise<void>;
  /** Whether GCM already has a cached, usable credential for the target. */
  status(target: AzureTarget): Promise<AzureDevOpsStatus>;
  /** Trigger an interactive browser sign-in and cache the credential. */
  signIn(target: AzureTarget): Promise<AzureDevOpsStatus>;
  /**
   * Erase GCM's cached credential for the target so subsequent sessions (and
   * the status pill) reflect a signed-out state. Returns the resulting
   * unauthenticated status.
   */
  signOut(target: AzureTarget): Promise<AzureDevOpsStatus>;
  /**
   * The cached OAuth access token for the target (used as a Bearer token for
   * Azure DevOps REST calls), or null when not signed in.
   */
  token(target: AzureTarget): Promise<string | null>;
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
    message: null,
  };
}

/** Parses the `password` (OAuth access token) from GCM's credential output. */
export function parseCredentialPassword(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && line.slice(0, eq).trim() === 'password') {
      const value = line.slice(eq + 1);
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/**
 * Turns Git Credential Manager's stderr into a concise, user-facing reason a
 * sign-in did not complete. GCM is missing, the account lacks access, or the
 * browser flow was cancelled all read very differently in raw output.
 */
export function describeAzureFailure(stderr: string): string {
  const text = stderr.trim();
  const lower = text.toLowerCase();
  if (
    lower.includes('is not recognized') ||
    lower.includes('command not found') ||
    lower.includes('no such file') ||
    lower.includes('enoent')
  ) {
    return 'Git Credential Manager is not installed. Install Git for Windows (which bundles it) and try again.';
  }
  if (lower.includes('cancel') || lower.includes('user canceled')) {
    return 'Sign-in was cancelled before it finished.';
  }
  if (
    lower.includes('aadsts') ||
    lower.includes('forbidden') ||
    lower.includes('unauthorized') ||
    lower.includes('403')
  ) {
    return 'Your account does not have access to this Azure DevOps organization. Check the org name or request access.';
  }
  if (!text) {
    return 'Azure DevOps sign-in did not complete. Please try again.';
  }
  // Keep the surfaced reason short — GCM can emit multi-line stack traces.
  const firstLine = text.split(/\r?\n/)[0];
  return `Azure DevOps sign-in failed: ${firstLine}`;
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
      // A silent status check failing just means "not signed in yet"; surface a
      // reason only for an interactive sign-in the user explicitly triggered.
      return {
        authenticated: false,
        account: null,
        message: interactive ? describeAzureFailure(res.stderr) : null,
      };
    }
    return parseCredentialOutput(res.stdout);
  };

  return {
    async configure() {
      // OAuth = org-agnostic Entra token (no PAT creation, works across orgs).
      await deps.config([
        'config',
        '--global',
        'credential.azreposCredentialType',
        'oauth',
      ]);
      // Never use the WAM broker: it needs a parent window we don't have when
      // GCM runs in the background, and would hang. Use the browser flow.
      await deps.config([
        'config',
        '--global',
        'credential.msauthUseBroker',
        'false',
      ]);
    },
    status(target) {
      return check(target, false);
    },
    signIn(target) {
      return check(target, true);
    },
    async signOut(target) {
      const res = await deps.credential('erase', buildCredentialQuery(target), {
        interactive: false,
      });
      if (res.code !== 0) {
        return {
          authenticated: false,
          account: null,
          message: describeAzureFailure(res.stderr),
        };
      }
      return { authenticated: false, account: null, message: null };
    },
    async token(target) {
      const res = await deps.credential('get', buildCredentialQuery(target), {
        interactive: false,
      });
      if (res.code !== 0) {
        return null;
      }
      return parseCredentialPassword(res.stdout);
    },
  };
}

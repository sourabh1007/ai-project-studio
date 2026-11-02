import { credentialFromRead, type CredentialRead } from '../kernel/credential-read.js';

/**
 * Thin, testable wrapper over the GitHub CLI (`gh`) auth commands. The IDE
 * reuses the same GitHub login that agency/`gh` already established, then
 * propagates it to every spawned session (see github-credential-env.ts). The
 * actual process execution is injected so this stays pure and unit-tested; the
 * real `gh` runner is wired in main.ts.
 */

export interface GhCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GhRunner = (args: string[]) => Promise<GhCommandResult>;

export interface GithubAuthStatus {
  authenticated: boolean;
  login: string | null;
}

export interface GithubAuth {
  /**
   * Whether `gh` reports an authenticated account, and its login name. A
   * transient GitHub outage that fails token *validation* still counts as
   * signed in when a credential is stored locally, so a blip does not demand a
   * pointless re-sign-in.
   */
  status(): Promise<GithubAuthStatus>;
  /** The current GitHub token, or null when unavailable / not logged in. */
  token(): Promise<string | null>;
  readToken(): Promise<CredentialRead>;
  /**
   * Logs the IDE's GitHub account out via `gh auth logout` and returns the
   * resulting (unauthenticated) status. Succeeds even when already logged out.
   */
  signOut(): Promise<GithubAuthStatus>;
}

/**
 * Extracts the logged-in account name from `gh auth status` output, e.g.
 * "✓ Logged in to github.com account sourabh1007 (keyring)" → "sourabh1007".
 */
export function parseGhLogin(output: string): string | null {
  const match = output.match(/account\s+(\S+)/i);
  return match ? match[1] : null;
}

/** Builds the GitHub auth facade from an injected `gh` command runner. */
export function createGithubAuth(deps: { run: GhRunner }): GithubAuth {
  return {
    async status() {
      const res = await deps.run(['auth', 'status', '--hostname', 'github.com']);
      if (res.code === 0) {
        return {
          authenticated: true,
          login: parseGhLogin(`${res.stdout}\n${res.stderr}`),
        };
      }
      // `gh auth status` validates the token against GitHub, so a transient
      // outage (a 5xx / "could not validate the token" while GitHub is briefly
      // unavailable) makes it exit non-zero even though a usable credential is
      // stored locally. Falling straight to "sign in required" then wrongly
      // nags the user to re-authenticate — and the device-flow they start hits
      // the same down servers and appears to hang. So on failure, fall back to
      // the stored token (read from the keyring without a network round-trip):
      // if one exists we still hold a credential, so report signed in rather
      // than stranding the user during a blip.
      if (credentialFromRead(await this.readToken())) {
        return {
          authenticated: true,
          login: parseGhLogin(`${res.stdout}\n${res.stderr}`),
        };
      }
      return { authenticated: false, login: null };
    },
    async token() {
      const read = await this.readToken();
      return read.state === 'ready' ? read.token : null;
    },
    async readToken() {
      const res = await deps.run(['auth', 'token', '--hostname', 'github.com']);
      const token = res.stdout.trim();
      if (res.code === 0) return token ? { state: 'ready', token } : { state: 'signed-out' };
      return /\bno oauth token found\b|\bnot logged (?:in|into)\b/i.test(res.stderr)
        ? { state: 'signed-out' } : { state: 'unavailable' };
    },
    async signOut() {
      await deps.run(['auth', 'logout', '--hostname', 'github.com']);
      return this.status();
    },
  };
}

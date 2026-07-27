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
  /** Whether `gh` reports an authenticated account, and its login name. */
  status(): Promise<GithubAuthStatus>;
  /** The current GitHub token, or null when unavailable / not logged in. */
  token(): Promise<string | null>;
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
      const res = await deps.run(['auth', 'status']);
      if (res.code !== 0) {
        return { authenticated: false, login: null };
      }
      return {
        authenticated: true,
        login: parseGhLogin(`${res.stdout}\n${res.stderr}`),
      };
    },
    async token() {
      const res = await deps.run(['auth', 'token']);
      const token = res.stdout.trim();
      return res.code === 0 && token.length > 0 ? token : null;
    },
  };
}

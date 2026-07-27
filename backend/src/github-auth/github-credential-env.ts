/**
 * Builds the environment that lets non-interactive `git` operations against
 * github.com authenticate with a single GitHub token — with no credential
 * prompt. Spawned agent sessions have no usable TTY for Git Credential Manager
 * to prompt on (hence "fatal: Cannot prompt because user interactivity has been
 * disabled"), so we override the github.com credential helper with an inline
 * helper that returns the token from GITHUB_TOKEN. Injecting these into the
 * app's own process env makes every spawned session inherit the same login.
 *
 * Returns an empty object when there is no token, so callers can spread it
 * unconditionally without clobbering anything.
 */
export function buildGithubCredentialEnv(
  token: string | null,
): Record<string, string> {
  if (!token) {
    return {};
  }
  return {
    GITHUB_TOKEN: token,
    GH_TOKEN: token,
    // Never fall back to an interactive prompt; use the injected helper instead.
    GIT_TERMINAL_PROMPT: '0',
    // Override any inherited helper (e.g. Git Credential Manager) for github.com
    // with an inline helper. Entry 0 clears existing helpers; entry 1 supplies
    // the token. Git runs `!`-prefixed helpers via its bundled shell.
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1:
      '!f() { echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; }; f',
  };
}

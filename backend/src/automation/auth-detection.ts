import type { CheckResult } from './automation-contract.js';

/**
 * Detects when a monitor's check has hit an **authentication wall** — e.g. an
 * Azure DevOps release URL that redirects to a Microsoft sign-in page, a GitHub
 * CLI that is not logged in, or an HTTP `401`/`403`. When detected, the scheduler
 * parks the monitor in the `needs-auth` state and surfaces
 * {@link AUTH_REQUIRED_MESSAGE} so the user can sign in and resume rather than the
 * monitor silently failing on every tick.
 *
 * Pure string/status inspection with no IO, so every branch is unit-tested.
 */

/** User-facing prompt shown when a monitor needs the user to authenticate. */
export const AUTH_REQUIRED_MESSAGE =
  "Sign-in required to reach this resource. The monitor reuses this machine's " +
  'existing logins, so if you are already signed in (in the IDE, or via ' +
  '`az login` / `gh auth login`) just click Resume. If not, sign in once in a ' +
  'terminal, then Resume.';

/** Phrases that indicate an auth failure in a check's error/output text. */
const AUTH_TEXT_PATTERN =
  /unauthorized|forbidden|access\s+denied|not\s+(?:logged|signed)\s+in|requires?\s+(?:authentication|sign[\s-]?in|login)|authentication\s+(?:is\s+)?required|please\s+(?:log|sign)[\s-]?in|sign[\s-]?in\s+to\s+your\s+account|az\s+login|gh\s+auth\s+login|token\s+(?:has\s+)?expired|invalid\s+credentials|401\s+unauthorized|403\s+forbidden/i;

/** Sign-in/OAuth redirect hosts that appear when a request is unauthenticated. */
const AUTH_URL_PATTERN =
  /login\.microsoftonline\.com|login\.live\.com|\/_signin|\/oauth2\/authorize|accounts\.google\.com/i;

/** True when free-form text reads as an authentication failure. */
function textIndicatesAuth(text: string): boolean {
  return AUTH_TEXT_PATTERN.test(text) || AUTH_URL_PATTERN.test(text);
}

/** Returns the login prompt when a thrown check error is an auth failure. */
export function detectAuthFromError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return textIndicatesAuth(message) ? AUTH_REQUIRED_MESSAGE : null;
}

/** Returns the login prompt when a completed check result signals an auth wall. */
export function detectAuthFromResult(result: CheckResult): string | null {
  if (result.code === 401 || result.code === 403) {
    return AUTH_REQUIRED_MESSAGE;
  }
  return textIndicatesAuth(result.text) ? AUTH_REQUIRED_MESSAGE : null;
}

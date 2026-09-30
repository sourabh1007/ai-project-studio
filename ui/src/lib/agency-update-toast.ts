/**
 * Pure UI model for the "Agency CLI was updated" popup shown once on app open.
 * The backend keeps agency current at startup (GET /agency/status) and now
 * reports whether the last successful upgrade actually changed the version.
 * This derives a nullable toast model so the React component stays thin and the
 * "only when an update was really applied" rule is fully unit-tested.
 */
import type { AgencyStatus } from './types.js';

export interface AgencyUpdateToast {
  headline: string;
  detail: string;
}

/**
 * Returns a toast model when an agency update was applied on this startup, else
 * null. Requires the upgrade to have completed (`phase === 'done'`) with the
 * `updated` flag set, so it never fires on a no-op "already latest" run.
 */
export function deriveAgencyUpdateToast(
  status: AgencyStatus | null | undefined,
): AgencyUpdateToast | null {
  if (!status?.installed) {
    return null;
  }
  const upgrade = status.upgrade;
  if (!upgrade || upgrade.phase !== 'done' || upgrade.updated !== true) {
    return null;
  }
  const version = upgrade.version ?? null;
  const previousVersion = upgrade.previousVersion ?? null;
  const detail =
    version && previousVersion
      ? `Updated from ${previousVersion} to ${version}.`
      : version
        ? `Updated to ${version}.`
        : 'The latest version is now active.';
  return {
    headline: 'Agency CLI updated',
    detail,
  };
}

/** True once the upgrade has reached a terminal phase (stop polling). */
export function isAgencyUpgradeTerminal(
  status: AgencyStatus | null | undefined,
): boolean {
  const phase = status?.upgrade?.phase;
  return phase === 'done' || phase === 'error';
}

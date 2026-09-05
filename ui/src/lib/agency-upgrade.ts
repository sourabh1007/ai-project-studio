/**
 * Pure UI model for the IDE's background "keep agency current" upgrade. The
 * backend re-runs the InstallTool bootstrap at startup and reports its phase via
 * GET /agency/status; this derives everything the Agency-CLI settings card needs
 * so the React component stays thin and this logic is fully unit-tested.
 */
import type { AgencyStatus, AgencyUpgradePhase } from './types.js';

export type AgencyUpgradeTone = 'info' | 'success' | 'danger' | 'muted';

export interface AgencyUpgradeUi {
  /** Current phase, defaulting to 'idle' when the backend omits upgrade state. */
  phase: AgencyUpgradePhase;
  headline: string;
  detail: string | null;
  tone: AgencyUpgradeTone;
  /** True while an upgrade is actively running (drives a spinner + re-poll). */
  busy: boolean;
}

/** Derives the Agency-CLI card's labels/flags from a raw agency status. */
export function deriveAgencyUpgradeUi(
  status: AgencyStatus | null | undefined,
): AgencyUpgradeUi {
  const installed = status?.installed ?? false;
  const phase = status?.upgrade?.phase ?? 'idle';
  const busy = phase === 'upgrading';

  if (!installed) {
    return {
      phase,
      headline: 'Agency CLI not installed',
      detail: 'The IDE installs it automatically on first run.',
      tone: 'muted',
      busy,
    };
  }

  switch (phase) {
    case 'upgrading':
      return {
        phase,
        headline: 'Updating Agency CLI…',
        detail: 'Pulling the latest version in the background.',
        tone: 'info',
        busy,
      };
    case 'done':
      return {
        phase,
        headline: 'Agency CLI is up to date',
        detail: 'The IDE keeps it current automatically at startup.',
        tone: 'success',
        busy,
      };
    case 'error':
      return {
        phase,
        headline: 'Agency CLI update failed',
        detail: status?.upgrade?.message ?? 'The last upgrade attempt failed.',
        tone: 'danger',
        busy,
      };
    default:
      return {
        phase,
        headline: 'Agency CLI installed',
        detail: 'The IDE checks for updates automatically at startup.',
        tone: 'muted',
        busy,
      };
  }
}

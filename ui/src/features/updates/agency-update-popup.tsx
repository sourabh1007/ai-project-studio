import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button } from '../../components/ui.js';
import {
  deriveAgencyUpdateToast,
  isAgencyUpgradeTerminal,
} from '../../lib/agency-update-toast.js';
import type { AgencyStatus } from '../../lib/types.js';

/**
 * A dismissible popup shown once on app open when the IDE's background agency
 * auto-upgrade actually applied a new version this startup. It polls
 * GET /agency/status until the upgrade reaches a terminal phase, then surfaces
 * the "Agency CLI updated" toast. A no-op "already latest" run shows nothing.
 */
export function AgencyUpdatePopup() {
  const api = useApi();
  const [status, setStatus] = useState<AgencyStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = (): void => {
      api
        .getAgencyStatus()
        .then((next) => {
          if (cancelled) {
            return;
          }
          setStatus(next);
          if (next.installed && !isAgencyUpgradeTerminal(next)) {
            timer = setTimeout(poll, 3000);
          }
        })
        .catch(() => {
          /* transient; a later poll or reopen will refresh */
        });
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [api]);

  const toast = deriveAgencyUpdateToast(status);
  if (!toast || dismissed) {
    return null;
  }

  return (
    <div className="agency-update-popup" role="status" aria-live="polite">
      <div className="agency-update-popup-main">
        <span className="agency-update-popup-title">{toast.headline}</span>
        <span className="agency-update-popup-detail">{toast.detail}</span>
      </div>
      <Button
        variant="ghost"
        onClick={() => setDismissed(true)}
        ariaLabel="Dismiss Agency update notification"
      >
        Dismiss
      </Button>
    </div>
  );
}
